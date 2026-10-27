import 'dotenv/config';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { after, before, describe, test } from 'node:test';

const testUrl = new URL(process.env.DATABASE_URL!);
testUrl.pathname = '/app_db_test';
process.env.DATABASE_URL = testUrl.toString();

execFileSync('node_modules/.bin/prisma', ['migrate', 'deploy'], {
  env: process.env,
  stdio: 'ignore',
});

const { prisma } = await import('../src/config/prisma.ts');
const { transferFunds } =
  await import('../src/services/transaction.service.ts');
const { HttpError, checkConstraintError } =
  await import('../src/utils/index.ts');

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

    assert.equal(
      ok,
      10,
      `thành công ${ok}, lý do reject: ${JSON.stringify(reasons)}`,
    );
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
    assert.equal(
      ledgerSum._count,
      20,
      'mỗi giao dịch thành công phải có đúng 2 ledger',
    );
    assert.equal(ledgerSum._sum.amount, 0n, 'ledger không cân');
  });

  test('Case B — A→B và B→A đồng thời: cả hai thành công, không deadlock', async () => {
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
    assert.ok(elapsed < 5_000, `mất ${elapsed}ms, nghi có lock chờ lâu`);

    const balances = await balancesOf([a!, b!]);
    assert.equal(balances.get(a!), 10_000_000n + BigInt(pairs) * 100_000n);
    assert.equal(balances.get(b!), 10_000_000n - BigInt(pairs) * 100_000n);
  });

  test('Case C — lỗi sau khi trừ A, trước khi cộng B: rollback toàn bộ', async () => {
    const [a] = await createWallets([500_000n]);
    const [b] = await createWallets([0n], 'crash-target');
    const key = randomUUID();

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
    assert.equal(
      await prisma.transfer.count({ where: { idempotencyKey: key } }),
      0,
    );
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

    assert.deepEqual(
      rejectReasons(results),
      {},
      'contract: mọi request đều nhận kết quả, không lỗi',
    );

    const ids = new Set(
      results.map(
        (r) => (r as PromiseFulfilledResult<{ id: string }>).value.id,
      ),
    );
    assert.equal(ids.size, 1, 'các request nhận về transfer khác nhau');

    const transfers = await prisma.transfer.findMany({
      where: { idempotencyKey: key },
    });
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

  test('Case E — retry key đã hoàn tất không phải chờ lock ví', async () => {
    const [a, b] = await createWallets([1_000_000n, 0n]);
    const key = randomUUID();
    const first = await transferFunds(a!, b!, 100_000n, key);

    let release!: () => void;
    let locked!: () => void;
    const isLocked = new Promise<void>((r) => (locked = r));
    const holder = prisma.$transaction(
      async (tx) => {
        await tx.$queryRaw`SELECT 1 FROM "users" WHERE id = ${a!} FOR NO KEY UPDATE`;
        locked();
        await new Promise<void>((r) => (release = r));
      },
      { timeout: 10_000 },
    );
    await isLocked;

    try {
      const retry = await Promise.race([
        transferFunds(a!, b!, 100_000n, key),
        new Promise((r) => setTimeout(r, 2_000, 'TIMEOUT')),
      ]);
      assert.notEqual(retry, 'TIMEOUT', 'retry bị kẹt chờ lock ví');
      assert.equal((retry as { id: string }).id, first.id);
    } finally {
      release();
      await holder;
    }
  });

  async function seedTransfer(
    status: 'PENDING' | 'FAILED',
    failureReason?: string,
  ) {
    const [a, b] = await createWallets([1_000_000n, 0n]);
    const key = randomUUID();
    await prisma.transfer.create({
      data: {
        fromUserId: a!,
        toUserId: b!,
        amount: 100_000n,
        idempotencyKey: key,
        status,
        failureReason,
      },
    });
    return { a: a!, b: b!, key };
  }

  function isHttpError(status: number, message: string) {
    return (e: unknown) =>
      e instanceof HttpError && e.status === status && e.message === message;
  }

  test('Case F — retry key đang PENDING: 409 TRANSFER_IN_PROGRESS, không chuyển tiền', async () => {
    const { a, b, key } = await seedTransfer('PENDING');

    await assert.rejects(
      transferFunds(a, b, 100_000n, key),
      isHttpError(409, 'TRANSFER_IN_PROGRESS'),
    );

    const balances = await balancesOf([a, b]);
    assert.equal(balances.get(a), 1_000_000n);
    assert.equal(balances.get(b), 0n);
  });

  test('Case G — retry key đã FAILED: trả lại đúng lỗi cũ, không chạy lại', async () => {
    const { a, b, key } = await seedTransfer('FAILED', 'INSUFFICIENT_BALANCE');

    await assert.rejects(
      transferFunds(a, b, 100_000n, key),
      isHttpError(422, 'INSUFFICIENT_BALANCE'),
    );

    const balances = await balancesOf([a, b]);
    assert.equal(balances.get(a), 1_000_000n);
    assert.equal(balances.get(b), 0n);
  });

  test('Case H — cùng key khác payload: IDEMPOTENCY_KEY_REUSED', async () => {
    const [a, b] = await createWallets([1_000_000n, 0n]);
    const key = randomUUID();
    await transferFunds(a!, b!, 100_000n, key);

    await assert.rejects(
      transferFunds(a!, b!, 200_000n, key),
      isHttpError(409, 'IDEMPOTENCY_KEY_REUSED'),
    );

    const balances = await balancesOf([a!, b!]);
    assert.equal(
      balances.get(a!),
      900_000n,
      'request khác payload vẫn chuyển tiền',
    );
  });

  test('Case I — ví không tồn tại: 404 WALLET_NOT_FOUND, không tạo transfer', async () => {
    const [a] = await createWallets([1_000_000n]);
    const key = randomUUID();

    await assert.rejects(
      transferFunds(a!, randomUUID(), 100_000n, key),
      isHttpError(404, 'WALLET_NOT_FOUND'),
    );

    assert.equal(
      await prisma.transfer.count({ where: { idempotencyKey: key } }),
      0,
    );
    assert.equal((await balancesOf([a!])).get(a!), 1_000_000n);
  });

  test('Case J — amount <= 0: CHECK constraint map về 400 INVALID_AMOUNT', async () => {
    const [a, b] = await createWallets([1_000_000n, 0n]);

    for (const amount of [0n, -100n]) {
      const key = randomUUID();
      await assert.rejects(
        transferFunds(a!, b!, amount, key),
        isHttpError(400, 'INVALID_AMOUNT'),
      );
      assert.equal(
        await prisma.transfer.count({ where: { idempotencyKey: key } }),
        0,
      );
    }

    const balances = await balancesOf([a!, b!]);
    assert.equal(balances.get(a!), 1_000_000n);
    assert.equal(balances.get(b!), 0n);
  });

  test('Case K — tự chuyển cho chính mình: CHECK constraint map về 400 SAME_WALLET', async () => {
    const [a] = await createWallets([1_000_000n]);
    const key = randomUUID();

    await assert.rejects(
      transferFunds(a!, a!, 100_000n, key),
      isHttpError(400, 'SAME_WALLET'),
    );

    assert.equal(
      await prisma.transfer.count({ where: { idempotencyKey: key } }),
      0,
    );
    assert.equal((await balancesOf([a!])).get(a!), 1_000_000n);
  });

  test('Case L — balance âm bị DB chặn: map về 422 INSUFFICIENT_BALANCE', async () => {
    const [a] = await createWallets([100n]);

    const error = await prisma.user
      .update({ where: { id: a! }, data: { balance: { decrement: 101n } } })
      .then(
        () => assert.fail('balance âm vẫn được ghi'),
        (e: unknown) => e,
      );

    assert.ok(
      isHttpError(422, 'INSUFFICIENT_BALANCE')(checkConstraintError(error)),
    );
    assert.equal((await balancesOf([a!])).get(a!), 100n);
  });

  test('Case M — không đủ số dư: lưu FAILED, nạp thêm tiền rồi retry cùng key vẫn 422', async () => {
    const [a, b] = await createWallets([50_000n, 0n]);
    const key = randomUUID();

    await assert.rejects(
      transferFunds(a!, b!, 100_000n, key),
      isHttpError(422, 'INSUFFICIENT_BALANCE'),
    );

    const transfer = await prisma.transfer.findUnique({
      where: { idempotencyKey: key },
    });
    assert.equal(
      transfer?.status,
      'FAILED',
      'key bị rollback, có thể dùng lại',
    );
    assert.equal(transfer?.failureReason, 'INSUFFICIENT_BALANCE');
    assert.equal(
      await prisma.ledger.count({ where: { transferId: transfer!.id } }),
      0,
      'transfer FAILED không được có ledger',
    );

    await prisma.user.update({
      where: { id: a! },
      data: { balance: 1_000_000n },
    });
    await assert.rejects(
      transferFunds(a!, b!, 100_000n, key),
      isHttpError(422, 'INSUFFICIENT_BALANCE'),
    );

    const balances = await balancesOf([a!, b!]);
    assert.equal(
      balances.get(a!),
      1_000_000n,
      'retry key FAILED vẫn chuyển tiền',
    );
    assert.equal(balances.get(b!), 0n);
    assert.equal(
      await prisma.transfer.count({ where: { idempotencyKey: key } }),
      1,
    );
  });

  test('Case N — 20 request cùng key khi không đủ số dư: tất cả 422, chỉ 1 transfer FAILED', async () => {
    const [a, b] = await createWallets([50_000n, 0n]);
    const key = randomUUID();

    const results = await Promise.allSettled(
      Array.from({ length: 20 }, () => transferFunds(a!, b!, 100_000n, key)),
    );

    assert.deepEqual(rejectReasons(results), {
      '422 INSUFFICIENT_BALANCE': 20,
    });

    const transfers = await prisma.transfer.findMany({
      where: { idempotencyKey: key },
    });
    assert.equal(transfers.length, 1);
    assert.equal(transfers[0]!.status, 'FAILED');

    const balances = await balancesOf([a!, b!]);
    assert.equal(balances.get(a!), 50_000n);
    assert.equal(balances.get(b!), 0n);
  });

  test('checkConstraintError bỏ qua lỗi không phải CHECK constraint', () => {
    assert.equal(checkConstraintError(new Error('boom')), undefined);
    assert.equal(
      checkConstraintError(new HttpError(404, 'WALLET_NOT_FOUND')),
      undefined,
    );
  });
});
