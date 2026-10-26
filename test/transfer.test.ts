import 'dotenv/config';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { after, before, describe, test } from 'node:test';

// Chạy trên DB riêng (app_db_test) để không đụng dữ liệu dev
const testUrl = new URL(process.env.DATABASE_URL!);
testUrl.pathname = '/app_db_test';
process.env.DATABASE_URL = testUrl.toString();

execFileSync('node_modules/.bin/prisma', ['migrate', 'deploy'], {
  env: process.env,
  stdio: 'ignore',
});

// Import sau khi đổi DATABASE_URL vì prisma client đọc env lúc import
const { prisma } = await import('../src/config/prisma.js');
const { transferFunds } = await import('../src/services/transaction.service.js');
const { HttpError } = await import('../src/utils/index.js');

async function createWallets(balances: bigint[], name = 'wallet') {
  const data = balances.map((balance) => ({
    id: randomUUID(),
    name,
    email: `${randomUUID()}@test.dev`,
    balance,
  }));
  await prisma.user.createMany({ data });
  return data.map((w) => w.id);
}

async function balancesOf(ids: string[]) {
  const users = await prisma.user.findMany({ where: { id: { in: ids } } });
  return new Map(users.map((u) => [u.id, u.balance]));
}

function sum(values: Iterable<bigint>) {
  let total = 0n;
  for (const v of values) total += v;
  return total;
}

// Gom lý do reject để khi test fail thấy ngay lỗi gì (422, deadlock, timeout...)
function rejectReasons(results: PromiseSettledResult<unknown>[]) {
  const counts: Record<string, number> = {};
  for (const r of results) {
    if (r.status !== 'rejected') continue;
    const e = r.reason;
    const key =
      e instanceof HttpError
        ? `${e.status} ${e.message}`
        : `${e?.code ?? e?.name}: ${String(e?.message).split('\n').at(-1)}`;
    counts[key] = (counts[key] ?? 0) + 1;
  }
  return counts;
}

before(async () => {
  await prisma.$executeRaw`TRUNCATE ledgers, transfers, users`;
});

after(async () => {
  await prisma.$disconnect();
});

describe('transferFunds', () => {
  test('Case A — 100 request rút đồng thời: đúng 10 thành công, A về 0', async () => {
    const [a] = await createWallets([1_000_000n]);
    const receivers = await createWallets(Array(100).fill(0n));
    const all = [a!, ...receivers];

    const results = await Promise.allSettled(
      receivers.map((to) => transferFunds(a!, to, 100_000n, randomUUID())),
    );

    const ok = results.filter((r) => r.status === 'fulfilled').length;
    const reasons = rejectReasons(results);

    assert.equal(ok, 10, `thành công ${ok}, lý do reject: ${JSON.stringify(reasons)}`);
    assert.deepEqual(reasons, { '422 INSUFFICIENT_BALANCE': 90 });

    const balances = await balancesOf(all);
    assert.equal(balances.get(a!), 0n);
    assert.ok(
      [...balances.values()].every((b) => b >= 0n),
      'có ví bị âm',
    );
    assert.equal(sum(balances.values()), 1_000_000n, 'tổng tiền bị lệch');

    const ledgerSum = await prisma.ledger.aggregate({
      where: { userId: { in: all } },
      _sum: { amount: true },
      _count: true,
    });
    assert.equal(ledgerSum._count, 20, 'mỗi giao dịch thành công phải có đúng 2 ledger');
    assert.equal(ledgerSum._sum.amount, 0n, 'ledger không cân');
  });

  test('Case B — A→B và B→A đồng thời: cả hai thành công, không deadlock', async () => {
    // Lặp nhiều cặp cùng lúc để tăng xác suất 2 transaction đan xen nhau
    const pairs = 20;
    const [a, b] = await createWallets([10_000_000n, 10_000_000n]);

    const started = Date.now();
    const results = await Promise.allSettled(
      Array.from({ length: pairs }).flatMap(() => [
        transferFunds(a!, b!, 100_000n, randomUUID()),
        transferFunds(b!, a!, 200_000n, randomUUID()),
      ]),
    );
    const elapsed = Date.now() - started;

    assert.deepEqual(rejectReasons(results), {}, 'có giao dịch bị lỗi');
    // deadlock_timeout mặc định của Postgres là 1s: nếu có deadlock sẽ chậm hẳn
    assert.ok(elapsed < 5_000, `mất ${elapsed}ms, nghi có lock chờ lâu`);

    const balances = await balancesOf([a!, b!]);
    assert.equal(balances.get(a!), 10_000_000n + BigInt(pairs) * 100_000n);
    assert.equal(balances.get(b!), 10_000_000n - BigInt(pairs) * 100_000n);
  });

  test('Case C — lỗi sau khi trừ A, trước khi cộng B: rollback toàn bộ', async () => {
    const [a] = await createWallets([500_000n]);
    const [b] = await createWallets([0n], 'crash-target');
    const key = randomUUID();

    // Giả lập crash: trigger làm fail đúng lệnh cộng tiền vào B (chạy sau lệnh trừ A)
    await prisma.$executeRaw`
      CREATE OR REPLACE FUNCTION simulate_crash() RETURNS trigger AS $$
      BEGIN RAISE EXCEPTION 'simulated crash'; END $$ LANGUAGE plpgsql`;
    await prisma.$executeRaw`
      CREATE TRIGGER simulate_crash BEFORE UPDATE ON users FOR EACH ROW
      WHEN (NEW.name = 'crash-target' AND NEW.balance > OLD.balance)
      EXECUTE FUNCTION simulate_crash()`;

    try {
      await assert.rejects(transferFunds(a!, b!, 200_000n, key));
    } finally {
      await prisma.$executeRaw`DROP TRIGGER simulate_crash ON users`;
      await prisma.$executeRaw`DROP FUNCTION simulate_crash()`;
    }

    const balances = await balancesOf([a!, b!]);
    assert.equal(balances.get(a!), 500_000n, 'A bị trừ tiền dù giao dịch lỗi');
    assert.equal(balances.get(b!), 0n);
    assert.equal(await prisma.transfer.count({ where: { idempotencyKey: key } }), 0);
    assert.equal(
      await prisma.ledger.count({ where: { userId: { in: [a!, b!] } } }),
      0,
      'ledger của giao dịch lỗi bị commit',
    );
  });

  test('Case D — 20 request cùng Idempotency-Key: chỉ chuyển 1 lần', async () => {
    const [a, b] = await createWallets([1_000_000n, 0n]);
    const key = randomUUID();

    const results = await Promise.allSettled(
      Array.from({ length: 20 }, () => transferFunds(a!, b!, 100_000n, key)),
    );

    assert.deepEqual(rejectReasons(results), {}, 'contract: mọi request đều nhận kết quả, không lỗi');

    // Contract: các request trùng key nhận lại đúng transfer đã tạo
    const ids = new Set(
      results.map((r) => (r as PromiseFulfilledResult<{ id: string }>).value.id),
    );
    assert.equal(ids.size, 1, 'các request nhận về transfer khác nhau');

    const transfers = await prisma.transfer.findMany({ where: { idempotencyKey: key } });
    assert.equal(transfers.length, 1, 'tạo duplicate transfer');
    assert.equal(transfers[0]!.status, 'COMPLETED');
    assert.equal(
      await prisma.ledger.count({ where: { transferId: transfers[0]!.id } }),
      2,
      'duplicate ledger',
    );

    const balances = await balancesOf([a!, b!]);
    assert.equal(balances.get(a!), 900_000n);
    assert.equal(balances.get(b!), 100_000n);
  });
});
