#!/usr/bin/env node
/**
 * Local parcel database. Import a GeoJSON or CSV download, then search owners,
 * ownership share, and comps without sending the file to the install site.
 *
 *   node analyze.mjs import owners.geojson
 *   node analyze.mjs owners
 *   node analyze.mjs search "ward cove"
 *   node analyze.mjs comps PARCELNO
 *   node analyze.mjs ask PARCELNO
 *   node analyze.mjs serve
 */
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { explainComps } from './lib/comps-ai.js';
import { formatMailing } from './lib/records.js';
import { compsFor, getParcel, importFile, listSearches, openDatabase, ownerReport, searchParcels } from './lib/parcels-db.js';

const root = path.dirname(fileURLToPath(import.meta.url));
const defaultDb = process.env.PARCEL_DB || path.join(root, 'data', 'parcels.sqlite');

function printUsage() {
  console.error('Usage:');
  console.error('  node analyze.mjs import <owners.geojson|owners.contacts.csv>');
  console.error('  node analyze.mjs owners [--limit 25] [--private]');
  console.error('  node analyze.mjs search <text>');
  console.error('  node analyze.mjs searches');
  console.error('  node analyze.mjs comps <parcelno> [--limit 8]');
  console.error('  node analyze.mjs ask <parcelno>');
  console.error('  node analyze.mjs serve [--port 3210]');
  console.error('');
  console.error('The database stays on this computer. npm start does not serve it.');
}

function flag(argv, name, fallback) {
  const index = argv.indexOf(name);
  if (index === -1) return fallback;
  return argv[index + 1];
}

function has(argv, name) {
  return argv.includes(name);
}

function percent(value) {
  return `${(Number(value) * 100).toFixed(1)}%`;
}

function money(value) {
  if (value == null || Number.isNaN(Number(value))) return '';
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 }).format(value);
}

function printOwners(report) {
  console.log(`${report.parcels} parcels, ${report.acres.toFixed(1)} acres, ${report.owners} owners`);
  console.log('');
  for (const owner of report.shown) {
    const kind = owner.publicOwner ? ' public' : '';
    console.log(`${owner.name}${kind}`);
    console.log(`  ${owner.parcelCount} parcels · ${owner.acres.toFixed(2)} acres · ${percent(owner.acreShare)} of land · ${percent(owner.countShare)} of parcels${owner.value ? ` · ${money(owner.value)} assessed` : ''}`);
  }
}

function printParcel(parcel) {
  console.log(`${parcel.parcelno}  ${parcel.owner_name || 'No owner'}`);
  console.log(`  ${parcel.location || 'No location'} · ${parcel.acres?.toFixed?.(2) || parcel.acres || '?'} acres · ${parcel.zoning || 'zoning unknown'} · ${money(parcel.total_value) || 'value unknown'}`);
  console.log(`  mail: ${formatMailing(parcel) || 'none'}`);
}

async function serve(db, port) {
  const studio = await readFile(path.join(root, 'studio', 'index.html'));
  const leafletRoot = path.join(root, 'extension', 'vendor', 'leaflet');
  const types = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.png': 'image/png' };
  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url || '/', 'http://127.0.0.1');
      if (req.method === 'GET' && url.pathname === '/') {
        return send(res, 200, studio, 'text/html; charset=utf-8');
      }
      if (req.method === 'GET' && url.pathname.startsWith('/vendor/leaflet/')) {
        const relative = url.pathname.slice('/vendor/leaflet/'.length);
        const abs = path.resolve(leafletRoot, relative);
        if (abs !== leafletRoot && !abs.startsWith(leafletRoot + path.sep)) return send(res, 404, 'Not found\n', 'text/plain');
        const body = await readFile(abs);
        return send(res, 200, body, types[path.extname(abs)] || 'application/octet-stream');
      }
      if (req.method === 'GET' && url.pathname === '/api/owners') {
        const report = ownerReport(db, { privateOnly: url.searchParams.get('private') === '1', limit: 40 });
        return sendJson(res, report);
      }
      if (req.method === 'GET' && url.pathname === '/api/search') {
        return sendJson(res, { results: searchParcels(db, url.searchParams.get('q') || '') });
      }
      if (req.method === 'GET' && url.pathname === '/api/searches') {
        return sendJson(res, { searches: listSearches(db) });
      }
      const compsMatch = url.pathname.match(/^\/api\/comps\/(.+)$/);
      if (req.method === 'GET' && compsMatch) {
        const found = compsFor(db, decodeURIComponent(compsMatch[1]));
        if (!found) return sendJson(res, { error: 'Parcel not in the database.' }, 404);
        return sendJson(res, found);
      }
      const explainMatch = url.pathname.match(/^\/api\/explain\/(.+)$/);
      if (req.method === 'POST' && explainMatch) {
        const found = compsFor(db, decodeURIComponent(explainMatch[1]), 8, { save: false });
        if (!found) return sendJson(res, { error: 'Parcel not in the database.' }, 404);
        const explanation = await explainComps(found.subject, found.comps);
        return sendJson(res, explanation);
      }
      return send(res, 404, 'Not found\n', 'text/plain');
    } catch (error) {
      return send(res, 500, `${error.message}\n`, 'text/plain');
    }
  });
  await new Promise((resolve) => server.listen(port, '127.0.0.1', resolve));
  console.log(`Parcel studio at http://127.0.0.1:${port}`);
  console.log('This serves the local database only. It is not the Railway install page.');
  return server;
}

function send(res, status, body, type) {
  res.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-store' });
  res.end(body);
}

function sendJson(res, body, status = 200) {
  send(res, status, JSON.stringify(body), 'application/json; charset=utf-8');
}

async function main(argv = process.argv.slice(2)) {
  const [command, positional] = argv;
  if (!command || command === '--help' || command === 'help') {
    printUsage();
    process.exit(1);
  }
  const { mkdirSync } = await import('node:fs');
  if (defaultDb !== ':memory:') mkdirSync(path.dirname(defaultDb), { recursive: true });
  const db = openDatabase(defaultDb);

  if (command === 'import') {
    if (!positional) throw new Error('Name the GeoJSON or CSV file to import.');
    const result = importFile(db, positional);
    console.log(`Imported ${result.imported} parcels. The database now has ${result.parcels}.`);
    return;
  }
  if (command === 'owners') {
    printOwners(ownerReport(db, { privateOnly: has(argv, '--private'), limit: Number(flag(argv, '--limit', 25)) }));
    return;
  }
  if (command === 'search') {
    const query = argv.slice(1).filter((item) => !item.startsWith('--')).join(' ');
    const rows = searchParcels(db, query);
    console.log(`${rows.length} matches for “${query}”`);
    for (const row of rows) printParcel(row);
    return;
  }
  if (command === 'searches') {
    for (const search of listSearches(db)) console.log(`${search.created_at}  ${search.kind}  ${search.query}`);
    return;
  }
  if (command === 'comps' || command === 'ask') {
    if (!positional) throw new Error('Name a parcel number.');
    const found = compsFor(db, positional, Number(flag(argv, '--limit', 8)));
    if (!found) throw new Error(`No parcel ${positional} in the database.`);
    printParcel(getParcel(db, positional));
    console.log('');
    for (const comp of found.comps) {
      console.log(`${comp.comp.score.toFixed(1)}  ${comp.parcelno}  ${comp.ownerName || ''}`);
      console.log(`  ${(comp.acres || 0).toFixed(2)} acres · ${comp.comp.distanceKm ?? '?'} km · ${comp.comp.reasons.join(', ') || 'loose match'}`);
    }
    if (command === 'ask') {
      console.log('');
      const explanation = await explainComps(found.subject, found.comps);
      console.log(explanation.text);
    }
    return;
  }
  if (command === 'serve') {
    await serve(db, Number(flag(argv, '--port', process.env.PORT || 3210)));
    return;
  }
  throw new Error(`Unknown command "${command}"`);
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  main().catch((error) => {
    console.error(error.message);
    process.exit(1);
  });
}

export { main, serve };
