// Runs against a real Postgres only when TEST_DATABASE_URL is set and `npm run build` has run.
// The database is emptied first, so never point TEST_DATABASE_URL at the live one.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { createServer as createHttpServer } from 'node:http';
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

test('server import keeps parcels, flags owner changes and missing parcels', { skip }, async (t) => {
  process.env.DATABASE_URL = databaseUrl;
  execFileSync(process.execPath, [path.join(root, 'node_modules', 'prisma', 'build', 'index.js'), 'migrate', 'deploy'], {
    cwd: root,
    env: { ...process.env, DATABASE_URL: databaseUrl },
    stdio: 'ignore',
  });
  const { createServer } = await import(apiEntry);
  const app = await createServer();
  const { PrismaService } = await import(path.join(root, 'api', 'prisma.service.js'));
  await app.get(PrismaService).$executeRawUnsafe('TRUNCATE parcels, imports RESTART IDENTITY');
  await app.listen(0, '127.0.0.1');
  t.after(() => app.close());
  const base = await app.getUrl();

  const upload = async (name, headers = {}) => {
    const form = new FormData();
    form.append('file', new Blob([fixture(name)]), name);
    return fetch(`${base}/api/imports`, { method: 'POST', headers, body: form });
  };

  assert.equal((await fetch(`${base}/health`)).status, 200);
  assert.equal((await fetch(`${base}/`)).status, 200);
  assert.deepEqual(await (await fetch(`${base}/api/server`)).json(), { database: true });
  assert.equal((await fetch(`${base}/api/auth/login`, { method: 'POST' })).status, 404);

  const one = await (await upload('parcels.geojson')).json();
  assert.equal(one.added, 10);

  const listed = await (await fetch(`${base}/api/parcels`)).json();
  assert.equal(listed.parcels.length, 10);

  const two = await (await upload('parcels-reimport.geojson')).json();
  assert.equal(two.ownerChanged, 1);
  assert.equal(two.missing, 1);
  assert.equal(two.totalParcels, 10);

  const changed = await (await fetch(`${base}/api/parcels/900000000400`)).json();
  assert.equal(changed.ownerName, 'LAMARR HEDY');
  assert.equal(changed.previousOwnerName, 'HOPPER GRACE');
  assert.ok(changed.ownerChangedAt);
  const gone = await (await fetch(`${base}/api/parcels/900000000900`)).json();
  assert.ok(gone.missingSince);
  assert.equal(gone.ownerName, 'TURING ALAN');

  const geometry = await fetch(`${base}/api/parcels/geometry`);
  assert.equal(geometry.status, 200);
  assert.equal(geometry.headers.get('etag'), `"import-${two.importId}"`);
  const collection = await geometry.json();
  assert.equal(collection.features.length, 10);
  const again = await fetch(`${base}/api/parcels/geometry`, { headers: { 'If-None-Match': geometry.headers.get('etag') } });
  assert.equal(again.status, 304);

  const foreign = await upload('parcels.geojson', { Origin: 'https://elsewhere.example' });
  assert.equal(foreign.status, 403);

  // A stand-in for Claude: asks for owner changes, then repeats what the database returned.
  const seen = [];
  const fakeClaude = createHttpServer(async (req, res) => {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw);
    seen.push(body);
    const reply = seen.length === 1
      ? { stop_reason: 'tool_use', content: [{ type: 'tool_use', id: 't1', name: 'search_parcels', input: { owner_changed: true } }] }
      : { stop_reason: 'end_turn', content: [{ type: 'text', text: `Found: ${body.messages.at(-1).content[0].content}` }] };
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify(reply));
  });
  await new Promise((resolve) => fakeClaude.listen(0, '127.0.0.1', resolve));
  t.after(() => fakeClaude.close());
  const saved = { AI_API_KEY: process.env.AI_API_KEY, ANTHROPIC_BASE_URL: process.env.ANTHROPIC_BASE_URL, AI_MODEL: process.env.AI_MODEL };
  process.env.AI_API_KEY = 'sk-ant-test-0000';
  process.env.ANTHROPIC_BASE_URL = `http://127.0.0.1:${fakeClaude.address().port}`;
  process.env.AI_MODEL = 'claude-test';
  t.after(() => {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
  assert.equal((await (await fetch(`${base}/api/ai`)).json()).available, true);
  const asked = await (await fetch(`${base}/api/ask`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ question: 'Which parcels changed owner?' }),
  })).json();
  assert.match(asked.text, /LAMARR HEDY/);
  assert.match(asked.text, /HOPPER GRACE/);
  assert.match(asked.text, /"matches":1/);
  assert.deepEqual(asked.lookups, ['search_parcels']);
  assert.equal(seen[0].model, 'claude-test');
  assert.ok(seen[0].tools.some((tool) => tool.name === 'get_parcels'));
  const blank = await fetch(`${base}/api/ask`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
  assert.equal(blank.status, 400);
});
