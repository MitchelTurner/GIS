/**
 * ArcGIS REST helpers shared by the command-line pull and the browser extension.
 * No Node APIs — browsers and Node 18+ can both import this file.
 */

const MAX_RETRIES = 4;
const USER_AGENT = 'ketchikan-parcel-extract/1.0';

export function classifyArcGisUrl(raw) {
  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    return null;
  }
  let path = parsed.pathname.replace(/\/(query|export)(\/.*)?$/i, '').replace(/\/+$/, '');
  if (!/\/rest\/services\//i.test(path)) return null;
  const layer = path.match(/\/(MapServer|FeatureServer)\/(\d+)$/i);
  const service = path.match(/\/(MapServer|FeatureServer)$/i);
  if (!layer && !service) return null;
  return {
    url: `${parsed.origin}${path}`,
    kind: layer ? 'layer' : 'service',
    id: layer ? Number(layer[2]) : null,
  };
}

export function friendlyGeometry(type) {
  const names = {
    esriGeometryPolygon: 'Polygons',
    esriGeometryPolyline: 'Lines',
    esriGeometryPoint: 'Points',
    esriGeometryMultipoint: 'Points',
  };
  if (!type) return 'Layer';
  return names[type] || String(type).replace(/^esriGeometry/, '');
}

export async function getJson(baseUrl, params, token) {
  const url = new URL(baseUrl);
  url.search = '';
  url.hash = '';
  const form = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null) form.set(key, String(value));
  }
  if (token) form.set('token', token);

  // ArcGIS Online answers HTTP 404 once a GET /query URL passes about 2,000
  // characters. A few hundred object ids is enough. POST keeps the ids in the body.
  const isQuery = /\/query$/i.test(url.pathname);
  const headers = {};
  if (typeof navigator === 'undefined') headers['User-Agent'] = USER_AGENT;
  const init = { headers };
  if (isQuery) {
    headers['Content-Type'] = 'application/x-www-form-urlencoded';
    init.method = 'POST';
    init.body = form.toString();
  } else {
    for (const [key, value] of form) url.searchParams.set(key, value);
  }

  let lastError;
  let attempts = 0;
  for (let attempt = 0; attempt < MAX_RETRIES; attempt += 1) {
    attempts += 1;
    if (attempt > 0) {
      const waitMs = 500 * 2 ** attempt;
      await new Promise((resolve) => setTimeout(resolve, waitMs));
    }
    try {
      const res = await fetch(url, init);
      if (!res.ok) {
        const error = new Error(`HTTP ${res.status} ${res.statusText}`);
        error.permanent = res.status >= 400 && res.status < 500;
        throw error;
      }
      const body = await res.json();
      if (body && body.error) {
        const error = new Error(`ArcGIS error ${body.error.code}: ${body.error.message}`);
        error.permanent = true;
        throw error;
      }
      return body;
    } catch (err) {
      lastError = err;
      if (err.permanent) break;
    }
  }
  const times = attempts === 1 ? '1 attempt' : `${attempts} attempts`;
  throw new Error(`Request failed after ${times}: ${url.pathname} — ${lastError.message}`);
}

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

export function esriPolygonToGeoJson(rings) {
  const polygons = [];
  let current = null;

  for (const raw of rings) {
    const ring = closeRing(raw.map(([x, y]) => [x, y]));
    if (ring.length < 4) continue;

    if (ringIsClockwise(ring)) {
      if (current) polygons.push(current);
      current = [ring];
    } else if (current) {
      current.push(ring);
    } else {
      current = [ring];
    }
  }
  if (current) polygons.push(current);

  if (polygons.length === 0) return null;
  if (polygons.length === 1) return { type: 'Polygon', coordinates: polygons[0] };
  return { type: 'MultiPolygon', coordinates: polygons };
}

export function esriFeatureToGeoJson(feature) {
  const geom = feature.geometry;
  let geometry = null;
  if (geom && Array.isArray(geom.rings)) {
    geometry = esriPolygonToGeoJson(geom.rings);
  } else if (geom && Array.isArray(geom.paths)) {
    const paths = geom.paths.map((path) => path.map(([x, y]) => [x, y]));
    geometry = paths.length === 1
      ? { type: 'LineString', coordinates: paths[0] }
      : { type: 'MultiLineString', coordinates: paths };
  } else if (geom && typeof geom.x === 'number' && typeof geom.y === 'number') {
    geometry = { type: 'Point', coordinates: [geom.x, geom.y] };
  }
  return { type: 'Feature', geometry, properties: feature.attributes || feature.properties || {} };
}

export function roundCoords(coords, precision) {
  if (typeof coords[0] === 'number') {
    const factor = 10 ** precision;
    return [Math.round(coords[0] * factor) / factor, Math.round(coords[1] * factor) / factor];
  }
  return coords.map((part) => roundCoords(part, precision));
}

export function dedupeConsecutive(coords) {
  if (typeof coords[0] === 'number') return coords;
  if (typeof coords[0][0] === 'number') {
    const out = [coords[0]];
    for (let i = 1; i < coords.length; i += 1) {
      const [px, py] = out[out.length - 1];
      const [x, y] = coords[i];
      if (x !== px || y !== py) out.push(coords[i]);
    }
    return out.length >= 4 ? out : coords;
  }
  return coords.map(dedupeConsecutive);
}

export function cleanFeature(feature, precision) {
  if (!feature?.geometry?.coordinates) return null;
  return {
    type: 'Feature',
    geometry: {
      type: feature.geometry.type,
      coordinates: dedupeConsecutive(roundCoords(feature.geometry.coordinates, precision)),
    },
    properties: feature.properties || {},
  };
}

export function fieldReport(features) {
  if (!features.length) return [];
  const counts = new Map();
  for (const feature of features) {
    for (const [key, value] of Object.entries(feature.properties || {})) {
      if (!counts.has(key)) counts.set(key, 0);
      if (value !== null && value !== undefined && String(value).trim() !== '') {
        counts.set(key, counts.get(key) + 1);
      }
    }
  }
  return [...counts.entries()]
    .map(([field, filled]) => ({
      field,
      filled,
      pct: Math.round((filled / features.length) * 1000) / 10,
    }))
    .sort((a, b) => b.filled - a.filled);
}

export function isSystemField(field) {
  const type = `${field.esriType || ''} ${field.type || ''}`;
  if (/FieldType(OID|Geometry|GlobalID)\b/i.test(type) || /^(OID|Geometry|GlobalID)$/i.test(field.type || '')) return true;
  const name = field.name || '';
  if (/^(objectid|fid|globalid|shape)$/i.test(name)) return true;
  return /shape.*(length|area|len)/i.test(name);
}

export function recommendedField(field, pct) {
  if (isSystemField(field)) return false;
  if (pct === undefined || pct === null || Number.isNaN(pct)) return true;
  return pct >= 90;
}

const CONTACT_ORDER = [
  'parcelno', 'parcel_num', 'apn',
  'owner_name', 'owner', 'ownernme1', 'owner_2', 'ownernme2',
  'address', 'city', 'state', 'zip', 'zipcode', 'address_full', 'mail_addr',
  'location', 'loc_city', 'subname',
];

const CONTACT_EXACT = new Set(CONTACT_ORDER);

export function contactField(field) {
  if (isSystemField(field)) return false;
  const name = String(field.name || '').toLowerCase();
  if (CONTACT_EXACT.has(name)) return true;
  const blob = `${name} ${String(field.alias || '').toLowerCase()}`;
  return /owner.?name|^owner$|mail(ing)?_?addr|situs/.test(blob);
}

export function orderContactNames(names) {
  const rank = (name) => {
    const index = CONTACT_ORDER.indexOf(String(name).toLowerCase());
    return index === -1 ? CONTACT_ORDER.length : index;
  };
  return [...names].sort((a, b) => rank(a) - rank(b) || String(a).localeCompare(String(b)));
}

export function contactColumns(features) {
  const names = new Set();
  for (const feature of features) {
    for (const name of Object.keys(feature.properties || {})) {
      if (contactField({ name, alias: name, type: 'String' })) names.add(name);
    }
  }
  return orderContactNames([...names]);
}

export function displayProperties(properties, limit = 12) {
  const entries = Object.entries(properties || {})
    .filter(([, value]) => value !== null && value !== undefined && String(value).trim() !== '');
  const contact = contactColumns([{ properties: Object.fromEntries(entries) }]);
  const rank = new Map(contact.map((name, index) => [name, index]));
  entries.sort((a, b) => (rank.get(a[0]) ?? 1000) - (rank.get(b[0]) ?? 1000) || a[0].localeCompare(b[0]));
  return entries.slice(0, limit);
}

function csvCell(value) {
  if (value === null || value === undefined) return '';
  const text = String(value);
  if (/[",\r\n]/.test(text)) return `"${text.replaceAll('"', '""')}"`;
  return text;
}

export function featuresToCsv(features, columns) {
  const lines = [columns.map(csvCell).join(',')];
  for (const feature of features) {
    const props = feature.properties || {};
    lines.push(columns.map((key) => csvCell(props[key])).join(','));
  }
  return `${lines.join('\n')}\n`;
}

export async function readEndpoint(url, { token, where = '1=1' } = {}) {
  const meta = await getJson(url, { f: 'json' }, token);
  const base = url.replace(/\/$/, '');

  if (Array.isArray(meta.layers) && meta.layers.length && meta.id === undefined) {
    return {
      kind: 'service',
      name: meta.serviceDescription || meta.mapName || 'Map service',
      version: meta.currentVersion ?? null,
      layers: meta.layers.map((layer) => ({
        id: layer.id,
        name: layer.name,
        geometryType: layer.geometryType || '',
        url: `${base}/${layer.id}`,
      })),
    };
  }

  const queryUrl = `${base}/query`;
  let count = null;
  try {
    const countBody = await getJson(queryUrl, {
      where,
      returnCountOnly: 'true',
      f: 'json',
    }, token);
    count = Number.isFinite(countBody.count) ? countBody.count : null;
  } catch {
    count = null;
  }

  return {
    kind: 'layer',
    name: meta.name || 'Layer',
    geometryType: meta.geometryType || '',
    objectIdField: meta.objectIdField
      || (meta.fields || []).find((field) => field.type === 'esriFieldTypeOID')?.name
      || 'OBJECTID',
    maxRecordCount: meta.maxRecordCount || 1000,
    wkid: meta.extent?.spatialReference?.latestWkid || meta.extent?.spatialReference?.wkid || null,
    count,
    fields: (meta.fields || []).map((field) => ({
      name: field.name,
      alias: field.alias && field.alias !== field.name ? field.alias : field.name,
      type: String(field.type || '').replace(/^esriFieldType/, ''),
      esriType: field.type || '',
    })),
  };
}

export async function sampleFill(url, { token, where = '1=1', limit = 200 } = {}) {
  const body = await getJson(`${url.replace(/\/$/, '')}/query`, {
    where,
    outFields: '*',
    returnGeometry: 'false',
    resultRecordCount: String(limit),
    f: 'json',
  }, token);
  const rows = body.features || [];
  const counts = new Map();
  for (const feature of rows) {
    const props = feature.attributes || feature.properties || {};
    for (const [key, value] of Object.entries(props)) {
      if (!counts.has(key)) counts.set(key, 0);
      if (value !== null && value !== undefined && String(value).trim() !== '') {
        counts.set(key, counts.get(key) + 1);
      }
    }
  }
  const fill = {};
  for (const [field, filled] of counts) {
    fill[field] = rows.length ? Math.round((filled / rows.length) * 1000) / 10 : 0;
  }
  return { sampled: rows.length, fill };
}

function toGeoJsonFeatures(body, asGeoJson) {
  const incoming = body.features || [];
  if (asGeoJson) return incoming;
  return incoming.map(esriFeatureToGeoJson);
}

export async function pullFeatures(url, opts, onProgress) {
  const layerUrl = url.replace(/\/$/, '');
  const queryUrl = `${layerUrl}/query`;
  const token = opts.token || null;
  const where = opts.where || '1=1';
  const precision = opts.precision ?? 6;

  const meta = await getJson(layerUrl, { f: 'json' }, token);
  const batchSize = opts.batch || Math.min(meta.maxRecordCount || 1000, 1000);
  const idResponse = await getJson(queryUrl, {
    where,
    returnIdsOnly: 'true',
    f: 'json',
  }, token);
  const objectIds = idResponse.objectIds || [];
  if (objectIds.length === 0) {
    throw new Error('The service returned no parcels. Change the filter and try again.');
  }

  const outFields = opts.fields?.length ? opts.fields.join(',') : '*';
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
      body = await getJson(queryUrl, params, token);
    } catch (err) {
      const canFallback = geojsonSupported && /geojson|format|output|HTTP 400/i.test(err.message);
      if (!canFallback) throw err;
      geojsonSupported = false;
      opts.onStatus?.('This server does not speak GeoJSON. Reading the older Esri format instead.');
      params.f = 'json';
      body = await getJson(queryUrl, params, token);
    }

    features.push(...toGeoJsonFeatures(body, geojsonSupported && Array.isArray(body.features) && body.type === 'FeatureCollection'));
    onProgress?.({
      done: Math.min(i + batchSize, objectIds.length),
      total: objectIds.length,
    });
  }

  // A server can accept f=geojson and still return an Esri feature set.
  const normalized = features.map((feature) => (
    feature.type === 'Feature' && feature.geometry && !feature.attributes
      ? feature
      : esriFeatureToGeoJson(feature)
  ));

  let dropped = 0;
  const cleaned = [];
  for (const feature of normalized) {
    const next = cleanFeature(feature, precision);
    if (!next) {
      dropped += 1;
      continue;
    }
    cleaned.push(next);
  }

  return {
    name: meta.name || 'Layer',
    features: cleaned,
    dropped,
    report: fieldReport(cleaned),
    collection: { type: 'FeatureCollection', features: cleaned },
  };
}
