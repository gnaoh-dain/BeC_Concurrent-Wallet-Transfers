import 'dotenv/config';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { after, before, describe, test } from 'node:test';

const testUrl = new URL(process.env.DATABASE_URL!);
testUrl.pathname = '/app_db_test';
process.env.DATABASE_URL = testUrl.toString();

execFileSync('node_modules/.bin/prisma', ['migrate', 'deploy'], {
  env: process.env,
  stdio: 'ignore',
});

const { prisma } = await import('../src/config/prisma.ts');
const { app } = await import('../src/app.ts');

let server: Server;
let baseUrl: string;

before(async () => {
  server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(async () => {
  await new Promise((r) => server.close(r));
  await prisma.$disconnect();
});

function uniqueEmail() {
  return `${randomUUID()}@test.dev`;
}

async function postUser(body: unknown) {
  const res = await fetch(`${baseUrl}/users`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: res.status, json: await res.json() };
}

describe('POST /users', () => {
  test('tạo user: trim name, chuẩn hoá email về lowercase, balance mặc định 0', async () => {
    const email = uniqueEmail();

    const { status, json } = await postUser({
      name: '  Alice  ',
      email: `  ${email.toUpperCase()} `,
    });

    assert.equal(status, 201);
    assert.equal(json.name, 'Alice');
    assert.equal(json.email, email);
    assert.equal(json.balance, '0');

    const saved = await prisma.user.findUnique({ where: { email } });
    assert.equal(saved?.id, json.id);
  });

  const invalidBodies: [string, unknown][] = [
    ['thiếu name', { email: uniqueEmail() }],
    ['thiếu email', { name: 'Bob' }],
    ['name rỗng sau trim', { name: '   ', email: uniqueEmail() }],
    ['name quá 255 ký tự', { name: 'a'.repeat(256), email: uniqueEmail() }],
    ['email sai định dạng', { name: 'Bob', email: 'not-an-email' }],
    ['name không phải string', { name: 123, email: uniqueEmail() }],
  ];

  for (const [label, body] of invalidBodies) {
    test(`400 INVALID_DATA khi ${label}, không tạo user`, async () => {
      const { status, json } = await postUser(body);

      assert.equal(status, 400);
      assert.equal(json.error, 'INVALID_DATA');
      assert.ok(Array.isArray(json.details) && json.details.length > 0);

      const { email } = body as { email?: string };
      if (typeof email === 'string') {
        assert.equal(
          await prisma.user.count({ where: { email: email.toLowerCase() } }),
          0,
        );
      }
    });
  }

  test('409 khi email đã tồn tại, kể cả khác hoa/thường', async () => {
    const email = uniqueEmail();
    assert.equal((await postUser({ name: 'Carol', email })).status, 201);

    const { status, json } = await postUser({
      name: 'Carol 2',
      email: email.toUpperCase(),
    });

    assert.equal(status, 409);
    assert.equal(json.message, 'Email already exists');
    assert.equal(await prisma.user.count({ where: { email } }), 1);
  });
});

describe('GET /users', () => {
  test('trả về danh sách mới nhất trước', async () => {
    const first = (await postUser({ name: 'Old', email: uniqueEmail() })).json;
    const second = (await postUser({ name: 'New', email: uniqueEmail() })).json;

    const res = await fetch(`${baseUrl}/users`);
    const users: { id: string }[] = await res.json();

    assert.equal(res.status, 200);
    const ids = users.map((u) => u.id);
    assert.ok(ids.includes(first.id) && ids.includes(second.id));
    assert.ok(
      ids.indexOf(second.id) < ids.indexOf(first.id),
      'không sắp xếp createdAt desc',
    );
  });
});
