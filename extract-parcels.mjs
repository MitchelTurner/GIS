#!/usr/bin/env node
/**
 * extract-parcels.mjs — one-time (or occasional) pull of a parcel layer from an
 * ArcGIS REST service into a trimmed GeoJSON file for offline use.
 *
 * Zero dependencies. Requires Node 18+ (uses global fetch).
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
 * Flags:
 *   --out <path>      Output file (default: parcels.geojson)
 *   --fields a,b,c    Attribute allowlist (default: all)
 *   --where "<sql>"   Server-side filter (default: 1=1)
 *   --precision <n>   Coordinate decimal places (default: 6, ~11cm)
 *   --batch <n>       Features per request (default: server maxRecordCount)
 *   --token <t>       Append a token if the service requires one
 */

const UA = 'ketchikan-parcel-extract/1.0';
const MAX_RETRIES = 4;

// ---------------------------------------------------------------------------
// arg parsing
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const [command, url, ...rest] = argv;
  const opts = {
    out: 'parcels.geojson',
    fields: null,
    where: '1=1',
    precision: 6,
    batch: null,
    token: null,
  };
  for (let i = 0; i < rest.length; i += 1) {
    const flag = rest[i];
    if (!flag.startsWith('--')) continue;
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
      case 'fields': opts.fields = value.split(',').map((f) => f.trim()).filter(Boolean); break;
      case 'precision': opts.precision = Number(value); break;
      case 'batch': opts.batch = Number(value); break;
      default: throw new Error(`Unknown flag --${key}`);
    }
  }
  return { command, url, opts };
}

// ---------------------------------------------------------------------------
// http
// ---------------------------------------------------------------------------

async function getJson(baseUrl, params, token) {
  const url = new URL(baseUrl);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  if (token) url.searchParams.set('token', token);

  let lastError;
  for (let attempt = 0; attempt < MAX_RETRIES; attempt += 1) {
    if (attempt > 0) {
      const waitMs = 500 * 2 ** attempt;
      await new Promise((r) => setTimeout(r, waitMs));
    }
    try {
      const res = await fetch(url, { headers: { 'User-Agent': UA } });
      if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
      const body = await res.json();
      // ArcGIS returns HTTP 200 with an error envelope. Surface it properly.
      if (body && body.error) {
        throw new Error(`ArcGIS error ${body.error.code}: ${body.error.message}`);
      }
      return body;
    } catch (err) {
      lastError = err;
    }
  }
  throw new Error(`Request failed after ${MAX_RETRIES} attempts: ${url.pathname} — ${lastError.message}`);
}

// ---------------------------------------------------------------------------
// esri JSON -> GeoJSON
//
// Older ArcGIS Server installs (10.x MapServer) do not support f=geojson, so we
// convert ourselves. Esri encodes polygons as a flat list of rings where a
// clockwise ring is an outer boundary and a counter-clockwise ring is a hole
// belonging to the most recent outer ring.
// ---------------------------------------------------------------------------

function ringIsClockwise(ring) {
  let area = 0;
  for (let i = 0; i < ring.length - 1; i += 1) {
    const [x1, y1] = ring[i];
    const [x2, y2] = ring[i + 1];
    area += (x2 - x1) * (y2 + y1);
  }
  return area > 0;
}

function closeRing(ring) {
  if (ring.length === 0) return ring;
  const [fx, fy] = ring[0];
  const [lx, ly] = ring[ring.length - 1];
  return fx === lx && fy === ly ? ring : [...ring, [fx, fy]];
}

function esriPolygonToGeoJson(rings) {
  const polygons = [];
  let current = null;

  for (const raw of rings) {
    // Drop any Z/M values; we only want [x, y].
    const ring = closeRing(raw.map(([x, y]) => [x, y]));
    if (ring.length < 4) continue;

    if (ringIsClockwise(ring)) {
      if (current) polygons.push(current);
      current = [ring];
    } else if (current) {
      current.push(ring);
    } else {
      // Hole with no preceding outer ring — treat it as an outer ring rather
      // than silently dropping geometry.
      current = [ring];
    }
  }
  if (current) polygons.push(current);

  if (polygons.length === 0) return null;
  if (polygons.length === 1) return { type: 'Polygon', coordinates: polygons[0] };
  return { type: 'MultiPolygon', coordinates: polygons };
}

function esriFeatureToGeoJson(feature) {
  const geom = feature.geometry;
  let geometry = null;
  if (geom && Array.isArray(geom.rings)) {
    geometry = esriPolygonToGeoJson(geom.rings);
  } else if (geom && typeof geom.x === 'number' && typeof geom.y === 'number') {
    geometry = { type: 'Point', coordinates: [geom.x, geom.y] };
  }
  return { type: 'Feature', geometry, properties: feature.attributes || {} };
}

// ---------------------------------------------------------------------------
// geometry post-processing
// ---------------------------------------------------------------------------

function roundCoords(coords, precision) {
  if (typeof coords[0] === 'number') {
    const f = 10 ** precision;
    return [Math.round(coords[0] * f) / f, Math.round(coords[1] * f) / f];
  }
  return coords.map((c) => roundCoords(c, precision));
}

function dedupeConsecutive(coords) {
  if (typeof coords[0] === 'number') return coords;
  if (typeof coords[0][0] === 'number') {
    const out = [coords[0]];
    for (let i = 1; i < coords.length; i += 1) {
      const [px, py] = out[out.length - 1];
      const [x, y] = coords[i];
      if (x !== px || y !== py) out.push(coords[i]);
    }
    // Never collapse a ring below the 4 points GeoJSON requires.
    return out.length >= 4 ? out : coords;
  }
  return coords.map(dedupeConsecutive);
}

// ---------------------------------------------------------------------------
// commands
// ---------------------------------------------------------------------------

async function discover(url, opts) {
  const meta = await getJson(url, { f: 'json' }, opts.token);

  if (Array.isArray(meta.layers) && meta.layers.length && meta.id === undefined) {
    console.log(`Service: ${meta.serviceDescription || meta.mapName || '(unnamed)'}`);
    console.log(`ArcGIS version: ${meta.currentVersion}\n`);
    console.log('Layers:');
    for (const layer of meta.layers) {
      console.log(`  [${layer.id}] ${layer.name}${layer.geometryType ? ` (${layer.geometryType})` : ''}`);
    }
    console.log('\nRe-run discover against a specific layer URL to see its fields:');
    console.log(`  node extract-parcels.mjs discover ${url.replace(/\/$/, '')}/0`);
    return;
  }

  console.log(`Layer: ${meta.name}`);
  console.log(`Geometry: ${meta.geometryType}`);
  console.log(`Object ID field: ${meta.objectIdField || '(unreported)'}`);
  console.log(`maxRecordCount: ${meta.maxRecordCount}`);
  console.log(`Spatial ref (wkid): ${meta.extent?.spatialReference?.latestWkid || meta.extent?.spatialReference?.wkid}`);

  const count = await getJson(`${url.replace(/\/$/, '')}/query`,
    { where: opts.where, returnCountOnly: 'true', f: 'json' }, opts.token);
  console.log(`Feature count (where ${opts.where}): ${count.count}\n`);

  console.log('Fields:');
  for (const field of meta.fields || []) {
    const alias = field.alias && field.alias !== field.name ? `  — ${field.alias}` : '';
    console.log(`  ${field.name.padEnd(28)} ${String(field.type).replace('esriFieldType', '').padEnd(10)}${alias}`);
  }
  console.log('\nPick your owner/address/APN fields from that list, then:');
  console.log(`  node extract-parcels.mjs pull ${url} --fields FIELD1,FIELD2,...`);
}

async function pull(url, opts) {
  const layerUrl = url.replace(/\/$/, '');
  const queryUrl = `${layerUrl}/query`;

  const meta = await getJson(layerUrl, { f: 'json' }, opts.token);
  const oidField = meta.objectIdField
    || (meta.fields || []).find((f) => f.type === 'esriFieldTypeOID')?.name
    || 'OBJECTID';
  const batchSize = opts.batch || Math.min(meta.maxRecordCount || 1000, 1000);

  console.error(`Layer: ${meta.name}`);
  console.error(`Paging by ${oidField} in batches of ${batchSize}\n`);

  // Ask for IDs first. This is more reliable than resultOffset paging, which
  // is unsupported or subtly broken on a lot of older ArcGIS Server builds.
  const idResponse = await getJson(queryUrl,
    { where: opts.where, returnIdsOnly: 'true', f: 'json' }, opts.token);
  const objectIds = idResponse.objectIds || [];
  if (objectIds.length === 0) {
    throw new Error('Query returned zero object IDs. Check your --where clause.');
  }
  console.error(`${objectIds.length} features to fetch`);

  const outFields = opts.fields ? opts.fields.join(',') : '*';
  const features = [];
  let geojsonSupported = true;

  for (let i = 0; i < objectIds.length; i += batchSize) {
    const batch = objectIds.slice(i, i + batchSize);
    const params = {
      objectIds: batch.join(','),
      outFields,
      outSR: '4326',
      returnGeometry: 'true',
      f: geojsonSupported ? 'geojson' : 'json',
    };

    let body;
    try {
      body = await getJson(queryUrl, params, opts.token);
    } catch (err) {
      if (geojsonSupported && /geojson|format/i.test(err.message)) {
        console.error('Server rejected f=geojson — falling back to esri JSON.');
        geojsonSupported = false;
        params.f = 'json';
        body = await getJson(queryUrl, params, opts.token);
      } else {
        throw err;
      }
    }

    if (geojsonSupported && Array.isArray(body.features)) {
      features.push(...body.features);
    } else {
      features.push(...(body.features || []).map(esriFeatureToGeoJson));
    }

    const done = Math.min(i + batchSize, objectIds.length);
    process.stderr.write(`\r  fetched ${done}/${objectIds.length}`);
  }
  process.stderr.write('\n');

  // Trim geometry and drop features that came back without any.
  let dropped = 0;
  const cleaned = [];
  for (const feature of features) {
    if (!feature.geometry || !feature.geometry.coordinates) {
      dropped += 1;
      continue;
    }
    const coords = dedupeConsecutive(roundCoords(feature.geometry.coordinates, opts.precision));
    cleaned.push({
      type: 'Feature',
      geometry: { type: feature.geometry.type, coordinates: coords },
      properties: feature.properties || {},
    });
  }

  const collection = { type: 'FeatureCollection', features: cleaned };
  const json = JSON.stringify(collection);
  const { writeFile } = await import('node:fs/promises');
  await writeFile(opts.out, json, 'utf8');

  // Field population report — tells you which owner fields are actually usable
  // before you design a UI around them.
  const counts = new Map();
  for (const feature of cleaned) {
    for (const [key, value] of Object.entries(feature.properties)) {
      if (!counts.has(key)) counts.set(key, 0);
      if (value !== null && value !== undefined && String(value).trim() !== '') {
        counts.set(key, counts.get(key) + 1);
      }
    }
  }

  const report = [...counts.entries()]
    .map(([field, filled]) => ({ field, filled, pct: Math.round((filled / cleaned.length) * 1000) / 10 }))
    .sort((a, b) => b.filled - a.filled);

  await writeFile(
    opts.out.replace(/\.geojson$/, '') + '.fields.json',
    JSON.stringify(report, null, 2),
    'utf8',
  );

  console.error(`\nWrote ${opts.out} — ${cleaned.length} features, ${(json.length / 1e6).toFixed(1)} MB`);
  if (dropped) console.error(`Skipped ${dropped} feature(s) with no geometry.`);
  console.error('\nField population:');
  for (const row of report.slice(0, 25)) {
    console.error(`  ${row.field.padEnd(28)} ${String(row.pct).padStart(5)}%  (${row.filled})`);
  }
  console.error('\nAnything under ~90% is a field you cannot rely on in the sidebar.');
}

// ---------------------------------------------------------------------------

async function main() {
  const { command, url, opts } = parseArgs(process.argv.slice(2));

  if (!command || !url || command === '--help') {
    console.error('Usage:');
    console.error('  node extract-parcels.mjs discover <serviceOrLayerUrl>');
    console.error('  node extract-parcels.mjs pull <layerUrl> [--out f.geojson] [--fields A,B] [--where "1=1"]');
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
