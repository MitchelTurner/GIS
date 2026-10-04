import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { promisify } from 'node:util';
import { createApp } from '../server.mjs';

const execFileAsync = promisify(execFile);

test('install page serves the extension zip', async () => {
  const server = await createApp();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  try {
    const health = await fetch(`http://127.0.0.1:${port}/health`);
    assert.equal(health.status, 200);
    assert.equal(await health.text(), 'ok\n');

    const page = await fetch(`http://127.0.0.1:${port}/`);
    assert.equal(page.status, 200);
    const html = await page.text();
    assert.match(html, /Download the extension/);
    assert.match(html, /Who owns the land/);
    assert.match(html, /Since the last file/);
    assert.match(html, /app\.js\?v=13/);
    assert.match(html, /Ask the comparison/);
    assert.match(html, /Mail elsewhere/);
    assert.match(html, /id="peek"/);
    assert.match(html, /Draw an area/);
    assert.match(html, /Export labels/);
    assert.match(html, /Export contacts/);
    assert.match(html, /href="\/extension\.zip"/);
    assert.equal(html.includes('View a downloaded file'), false);
    assert.equal(html.includes('Load the extension'), false);

    const library = await fetch(`http://127.0.0.1:${port}/lib/library.js`);
    assert.equal(library.status, 200);
    assert.match(await library.text(), /createLibrary/);
    const hidden = await fetch(`http://127.0.0.1:${port}/lib/parcels-db.js`);
    assert.equal(hidden.status, 404);
    const escapedLib = await fetch(`http://127.0.0.1:${port}/lib/../package.json`);
    assert.equal(escapedLib.status, 404);

    const missing = await fetch(`http://127.0.0.1:${port}/../package.json`);
    assert.equal(missing.status, 404);

    const leaflet = await fetch(`http://127.0.0.1:${port}/vendor/leaflet/leaflet.js`);
    assert.equal(leaflet.status, 200);
    assert.match(await leaflet.text(), /geoJSON/);
    const marker = await fetch(`http://127.0.0.1:${port}/vendor/leaflet/images/marker-icon.png`);
    assert.equal(marker.status, 200);
    const escaped = await fetch(`http://127.0.0.1:${port}/vendor/leaflet/../../package.json`);
    assert.equal(escaped.status, 404);

    const zip = await fetch(`http://127.0.0.1:${port}/extension.zip`);
    assert.equal(zip.status, 200);
    assert.match(zip.headers.get('content-type'), /zip/);
    assert.match(zip.headers.get('content-disposition'), /ketchikan-parcel-extract\.zip/);
    const bytes = Buffer.from(await zip.arrayBuffer());
    const dir = await mkdtemp(path.join(tmpdir(), 'parcel-zip-'));
    const zipPath = path.join(dir, 'extension.zip');
    await writeFile(zipPath, bytes);
    const listed = await execFileAsync('unzip', ['-t', zipPath]);
    assert.match(listed.stdout, /ketchikan-parcel-extract\/manifest\.json/);
    assert.match(listed.stdout, /ketchikan-parcel-extract\/lib\/arcgis\.js/);
    assert.match(listed.stdout, /ketchikan-parcel-extract\/vendor\/leaflet\/leaflet\.js/);
    await rm(dir, { recursive: true, force: true });
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('compare sends the comps and does not require a stored parcel file', async () => {
  let asked = null;
  const server = await createApp({
    explain: async (subject, comps, options = {}) => {
      asked = options.question;
      return { available: true, text: `${subject.parcelno} against ${comps.length}` };
    },
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/explain`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ subject: { parcelno: '1002', ownerName: 'Ada' }, comps: [{ parcelno: '1003' }] }),
    });
    assert.equal(res.status, 200);
    assert.equal((await res.json()).text, '1002 against 1');
    const askedRes = await fetch(`http://127.0.0.1:${port}/api/explain`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ subject: { parcelno: '1002' }, comps: [], question: 'Is it exempt?' }),
    });
    assert.equal(askedRes.status, 200);
    assert.equal(asked, 'Is it exempt?');
    const bad = await fetch(`http://127.0.0.1:${port}/api/explain`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{',
    });
    assert.equal(bad.status, 400);
    const status = await fetch(`http://127.0.0.1:${port}/api/ai`);
    assert.equal(status.status, 200);
    const ai = await status.json();
    assert.equal(typeof ai.available, 'boolean');
    assert.equal(JSON.stringify(ai).includes('sk-'), false);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('command line prints usage without a url', async () => {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const result = await execFileAsync(process.execPath, ['extract-parcels.mjs'], { cwd: root }).then(
    () => ({ code: 0, stderr: '' }),
    (err) => err,
  );
  assert.equal(result.code, 1);
  assert.match(result.stderr, /PARCEL_LAYER_URL/);
});
