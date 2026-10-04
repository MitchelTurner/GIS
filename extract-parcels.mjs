#!/usr/bin/env node
/**
 * extract-parcels.mjs — one-time (or occasional) pull of a parcel layer from an
 * ArcGIS REST service into a trimmed GeoJSON file for offline use.
 *
 * Zero dependencies. Requires Node 18+ (uses global fetch).
 *
 * The browser extension is the everyday way to do this. This script is the
 * same pull, for a terminal or a scheduled job. `npm start` serves the
 * extension's install page instead of running a pull.
 *
 * ---------------------------------------------------------------------------
 * FINDING YOUR LAYER URL
 * ---------------------------------------------------------------------------
 * You need a URL ending in /FeatureServer/<n> or /MapServer/<n>.
 *
 *   Option A — Alaska Geoportal: open the "Ketchikan AK Tax Parcels" item,
 *     click through to the underlying service, copy the REST URL.
 *   Option B — Borough viewer: open the GIS viewer, DevTools > Network,
 *     filter "rest/services", pan the map, grab the parcel layer request URL.
 *   Option C — Call Public Works, (907) 228-6649, and ask for the map service
 *     endpoint. This is the sanctioned route and they publish these on request.
 *
 * Once you have a service root, run `discover` to list its layers and fields.
 *
 * ---------------------------------------------------------------------------
 * USAGE
 * ---------------------------------------------------------------------------
 *   # List layers under a service root:
 *   node extract-parcels.mjs discover https://host/arcgis/rest/services/Parcels/MapServer
 *
 *   # Inspect one layer's fields before committing to a pull:
 *   node extract-parcels.mjs discover https://host/.../MapServer/0
 *
 *   # Pull everything:
 *   node extract-parcels.mjs pull https://host/.../MapServer/0 --out parcels.geojson
 *
 *   # Pull only the fields you want:
 *   node extract-parcels.mjs pull <url> --fields APN,OWNER_NAME,MAIL_ADDR,ZONING
 *
 *   # Owner, town, and mailing address, plus a spreadsheet:
 *   node extract-parcels.mjs pull <url> --contact --out owners.geojson
 *
 * Flags:
 *   --out <path>      Output file (default: parcels.geojson)
 *   --fields a,b,c    Attribute allowlist (default: all)
 *   --contact         Keep owner, town, and mailing fields, and write a CSV
 *   --where "<sql>"   Server-side filter (default: 1=1)
 *   --precision <n>   Coordinate decimal places (default: 6, ~11cm)
 *   --batch <n>       Features per request (default: server maxRecordCount)
 *   --token <t>       Append a token if the service requires one
 *
 * With no arguments, the same values are read from the environment:
 * PARCEL_LAYER_URL, PARCEL_COMMAND (discover|pull, default pull), PARCEL_OUT,
 * PARCEL_FIELDS, PARCEL_WHERE, PARCEL_PRECISION, PARCEL_BATCH, PARCEL_TOKEN.
 */

import { readEndpoint, pullFeatures, contactField, contactColumns, featuresToCsv } from './extension/lib/arcgis.js';

function parseArgs(argv) {
  const [command, url, ...rest] = argv;
  const opts = {
    out: 'parcels.geojson',
    fields: null,
    where: '1=1',
    precision: 6,
    batch: null,
    token: null,
    contact: false,
  };
  for (let i = 0; i < rest.length; i += 1) {
    const flag = rest[i];
    if (!flag.startsWith('--')) continue;
    if (flag === '--contact') {
      opts.contact = true;
      continue;
    }
    const key = flag.slice(2);
    const value = rest[i + 1];
    if (value === undefined || value.startsWith('--')) {
      throw new Error(`Flag --${key} needs a value`);
    }
    i += 1;
    switch (key) {
      case 'out': opts.out = value; break;
      case 'where': opts.where = value; break;
      case 'token': opts.token = value; break;
      case 'fields': opts.fields = value.split(',').map((field) => field.trim()).filter(Boolean); break;
      case 'precision': opts.precision = Number(value); break;
      case 'batch': opts.batch = Number(value); break;
      default: throw new Error(`Unknown flag --${key}`);
    }
  }
  return { command, url, opts };
}

function fromEnv() {
  const url = process.env.PARCEL_LAYER_URL || '';
  const fields = process.env.PARCEL_FIELDS;
  const precision = process.env.PARCEL_PRECISION;
  const batch = process.env.PARCEL_BATCH;
  return {
    command: process.env.PARCEL_COMMAND || (url ? 'pull' : ''),
    url,
    opts: {
      out: process.env.PARCEL_OUT || 'parcels.geojson',
      fields: fields ? fields.split(',').map((field) => field.trim()).filter(Boolean) : null,
      where: process.env.PARCEL_WHERE || '1=1',
      precision: precision === undefined || precision === '' ? 6 : Number(precision),
      batch: batch === undefined || batch === '' ? null : Number(batch),
      token: process.env.PARCEL_TOKEN || null,
      contact: process.env.PARCEL_CONTACT === '1',
    },
  };
}

function assertOpts(opts) {
  if (!Number.isInteger(opts.precision) || opts.precision < 0) {
    throw new Error('--precision / PARCEL_PRECISION must be a non-negative integer');
  }
  if (opts.batch !== null && (!Number.isInteger(opts.batch) || opts.batch < 1)) {
    throw new Error('--batch / PARCEL_BATCH must be a positive integer');
  }
}

function printUsage() {
  console.error('Usage:');
  console.error('  node extract-parcels.mjs discover <serviceOrLayerUrl>');
  console.error('  node extract-parcels.mjs pull <layerUrl> [--out f.geojson] [--fields A,B] [--contact] [--where "1=1"]');
  console.error('');
  console.error('With no arguments, the script reads PARCEL_LAYER_URL and the PARCEL_* flags.');
  console.error('npm start serves the browser-extension install page.');
}

async function discover(url, opts) {
  const info = await readEndpoint(url, opts);
  if (info.kind === 'service') {
    console.log(`Service: ${info.name}`);
    console.log(`ArcGIS version: ${info.version}\n`);
    console.log('Layers:');
    for (const layer of info.layers) {
      console.log(`  [${layer.id}] ${layer.name}${layer.geometryType ? ` (${layer.geometryType})` : ''}`);
    }
    console.log('\nRe-run discover against a specific layer URL to see its fields:');
    const example = info.layers[0]?.url || `${url.replace(/\/$/, '')}/0`;
    console.log(`  node extract-parcels.mjs discover ${example}`);
    return;
  }

  console.log(`Layer: ${info.name}`);
  console.log(`Geometry: ${info.geometryType}`);
  console.log(`Object ID field: ${info.objectIdField}`);
  console.log(`maxRecordCount: ${info.maxRecordCount}`);
  console.log(`Spatial ref (wkid): ${info.wkid}`);
  console.log(`Feature count (where ${opts.where}): ${info.count}\n`);
  console.log('Fields:');
  for (const field of info.fields) {
    const alias = field.alias !== field.name ? `  — ${field.alias}` : '';
    const contact = contactField(field) ? '  contact' : '';
    console.log(`  ${field.name.padEnd(28)} ${field.type.padEnd(10)}${alias}${contact}`);
  }
  console.log('\nOwner, town, and mailing address:');
  console.log(`  node extract-parcels.mjs pull ${url} --contact --out owners.geojson`);
}

async function pull(url, opts) {
  if (opts.contact && !opts.fields) {
    const info = await readEndpoint(url, opts);
    if (info.kind !== 'layer') throw new Error('--contact needs a layer URL, not a service root.');
    opts.fields = info.fields.filter(contactField).map((field) => field.name);
    if (!opts.fields.length) {
      throw new Error('This layer has no owner or mailing fields. For Ketchikan, use Parcel_Ketchikan/FeatureServer/0.');
    }
  }
  const result = await pullFeatures(url, {
    ...opts,
    onStatus: (message) => console.error(message),
  }, (progress) => {
    process.stderr.write(`\r  fetched ${progress.done}/${progress.total}`);
  });
  process.stderr.write('\n');

  const json = JSON.stringify(result.collection);
  const { writeFile } = await import('node:fs/promises');
  await writeFile(opts.out, json, 'utf8');
  const reportPath = opts.out.replace(/\.geojson$/, '') + '.fields.json';
  await writeFile(reportPath, JSON.stringify(result.report, null, 2), 'utf8');
  const columns = contactColumns(result.features);
  let csvPath = '';
  if (columns.length) {
    csvPath = opts.out.replace(/\.geojson$/i, '') + '.contacts.csv';
    await writeFile(csvPath, featuresToCsv(result.features, columns), 'utf8');
  }

  console.error(`\nWrote ${opts.out} — ${result.features.length} features, ${(json.length / 1e6).toFixed(1)} MB`);
  if (csvPath) console.error(`Wrote ${csvPath} — owners, town, and mailing address.`);
  if (result.dropped) console.error(`Skipped ${result.dropped} feature(s) with no geometry.`);
  console.error('\nField population:');
  for (const row of result.report.slice(0, 25)) {
    console.error(`  ${row.field.padEnd(28)} ${String(row.pct).padStart(5)}%  (${row.filled})`);
  }
  console.error('\nAnything under ~90% is a field you cannot rely on in the sidebar.');
}

async function main() {
  const argv = process.argv.slice(2);
  const { command, url, opts } = argv.length > 0 ? parseArgs(argv) : fromEnv();
  assertOpts(opts);

  if (!command || !url || command === '--help' || command === 'help') {
    printUsage();
    process.exit(1);
  }

  if (command === 'discover') await discover(url, opts);
  else if (command === 'pull') await pull(url, opts);
  else throw new Error(`Unknown command "${command}" — expected discover or pull`);
}

main().catch((err) => {
  console.error(`\nError: ${err.message}`);
  process.exit(1);
});
