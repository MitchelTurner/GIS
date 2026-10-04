// Runs against a real Postgres only when TEST_DATABASE_URL is set and `npm run build` has run.
// The database is emptied first, so never point TEST_DATABASE_URL at the live one.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const apiEntry = path.join(root, 'api', 'main.js');
const databaseUrl = process.env.TEST_DATABASE_URL;
const testDatabase = databaseUrl ? new URL(databaseUrl).pathname.replace(/^\//, '') : '';
let skip = false;
if (!databaseUrl) skip = 'set TEST_DATABASE_URL to run the server tests';
else if (!/_test$/.test(testDatabase)) skip = 'TEST_DATABASE_URL must name a database ending in _test';
else if (!existsSync(apiEntry)) skip = 'run `npm run build` first';

const fixture = (name) => readFileSync(path.join(root, 'test', 'fixtures', name));

test('signed-in import keeps parcels, flags owner changes and missing parcels', { skip }, async (t) => {
  process.env.DATABASE_URL = databaseUrl;
  process.env.ADMIN_EMAIL = 'ada@example.com';
  const argon2 = (await import('argon2')).default;
  process.env.ADMIN_PASSWORD_HASH = await argon2.hash('correct horse battery');
  execFileSync(process.execPath, [path.join(root, 'node_modules', 'prisma', 'build', 'index.js'), 'migrate', 'deploy'], {
    cwd: root,
    env: { ...process.env, DATABASE_URL: databaseUrl },
    stdio: 'ignore',
  });
  const { createServer } = await import(apiEntry);
  const app = await createServer();
  const { PrismaService } = await import(path.join(root, 'api', 'prisma.service.js'));
  await app.get(PrismaService).$executeRawUnsafe('TRUNCATE parcels, imports, sessions RESTART IDENTITY');
  await app.listen(0, '127.0.0.1');
  t.after(() => app.close());
  const base = await app.getUrl();

  const login = async () => {
    const res = await fetch(`${base}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'ADA@example.com', password: 'correct horse battery' }),
    });
    assert.equal(res.status, 200);
    const cookie = res.headers.get('set-cookie');
    assert.match(cookie, /HttpOnly/);
    assert.match(cookie, /Secure/);
    assert.match(cookie, /SameSite=Lax/);
    return cookie.split(';')[0];
  };
  const upload = async (cookie, name) => {
    const form = new FormData();
    form.append('file', new Blob([fixture(name)]), name);
    const res = await fetch(`${base}/api/imports`, { method: 'POST', headers: { cookie }, body: form });
    assert.equal(res.status, 201);
    return res.json();
  };

  assert.equal((await fetch(`${base}/health`)).status, 200);
  assert.equal((await fetch(`${base}/`)).status, 200);
  assert.equal((await fetch(`${base}/api/parcels`)).status, 401);
  assert.equal((await fetch(`${base}/api/auth/me`)).status, 401);
  assert.equal((await fetch(`${base}/api/explain`, { method: 'POST' })).status, 401);
  const wrong = await fetch(`${base}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'ada@example.com', password: 'wrong password' }),
  });
  assert.equal(wrong.status, 401);

  const browserA = await login();
  const one = await upload(browserA, 'parcels.geojson');
  assert.equal(one.added, 10);

  const browserB = await login();
  assert.notEqual(browserA, browserB);
  const listed = await (await fetch(`${base}/api/parcels`, { headers: { cookie: browserB } })).json();
  assert.equal(listed.parcels.length, 10);

  const two = await upload(browserB, 'parcels-reimport.geojson');
  assert.equal(two.ownerChanged, 1);
  assert.equal(two.missing, 1);
  assert.equal(two.totalParcels, 10);

  const changed = await (await fetch(`${base}/api/parcels/900000000400`, { headers: { cookie: browserA } })).json();
  assert.equal(changed.ownerName, 'LAMARR HEDY');
  assert.equal(changed.previousOwnerName, 'HOPPER GRACE');
  assert.ok(changed.ownerChangedAt);
  const gone = await (await fetch(`${base}/api/parcels/900000000900`, { headers: { cookie: browserA } })).json();
  assert.ok(gone.missingSince);
  assert.equal(gone.ownerName, 'TURING ALAN');

  const geometry = await fetch(`${base}/api/parcels/geometry`, { headers: { cookie: browserA } });
  assert.equal(geometry.status, 200);
  assert.equal(geometry.headers.get('etag'), `"import-${two.importId}"`);
  const collection = await geometry.json();
  assert.equal(collection.features.length, 10);
  const again = await fetch(`${base}/api/parcels/geometry`, {
    headers: { cookie: browserA, 'If-None-Match': geometry.headers.get('etag') },
  });
  assert.equal(again.status, 304);

  const out = await fetch(`${base}/api/auth/logout`, { method: 'POST', headers: { cookie: browserA } });
  assert.equal(out.status, 200);
  assert.equal((await fetch(`${base}/api/parcels`, { headers: { cookie: browserA } })).status, 401);
  assert.equal((await fetch(`${base}/api/parcels`, { headers: { cookie: browserB } })).status, 200);
});
