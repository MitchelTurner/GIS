import {
  classifyArcGisUrl,
  friendlyGeometry,
  readEndpoint,
  recommendedField,
  sampleFill,
  pullFeatures,
  fieldReport,
} from './lib/arcgis.js';

const nf = new Intl.NumberFormat('en-US');

function featureCount(count) {
  return `${nf.format(count)} ${count === 1 ? 'feature' : 'features'}`;
}
const banner = document.querySelector('#banner');
const title = document.querySelector('#title');
const subtitle = document.querySelector('#subtitle');
const connect = document.querySelector('#connect');
const allow = document.querySelector('#allow');
const paste = document.querySelector('#paste');
const pasteUrl = document.querySelector('#paste-url');
const layersSection = document.querySelector('#layers');
const layerList = document.querySelector('#layer-list');
const fieldsSection = document.querySelector('#fields');
const fieldList = document.querySelector('#field-list');
const layerCount = document.querySelector('#layer-count');
const filterInput = document.querySelector('#filter');
const whereInput = document.querySelector('#where');
const tokenInput = document.querySelector('#token');
const downloadButton = document.querySelector('#download');
const backButton = document.querySelector('#back');
const resultSection = document.querySelector('#result');
const resultTitle = document.querySelector('#result-title');
const resultCopy = document.querySelector('#result-copy');
const mapNode = document.querySelector('#map');
const againButton = document.querySelector('#again');
const reportButton = document.querySelector('#report');
const backResult = document.querySelector('#back-result');
const changeFields = document.querySelector('#change-fields');
const closeFileButton = document.querySelector('#close-file');
const reportSection = document.querySelector('#report-view');
const reportTitle = document.querySelector('#report-title');
const reportCopy = document.querySelector('#report-copy');
const reportTable = document.querySelector('#report-table');
const rawSection = document.querySelector('#raw-view');
const rawTitle = document.querySelector('#raw-title');
const rawJson = document.querySelector('#raw-json');
const openInput = document.querySelector('#open-file');

let serviceUrl = null;
let layerUrl = null;
let layerName = 'parcels';
let saved = null;
let map = null;

function showBanner(message) {
  banner.hidden = !message;
  banner.textContent = message || '';
}

function hideAll() {
  for (const node of [connect, paste, layersSection, fieldsSection, resultSection, reportSection, rawSection]) {
    node.hidden = true;
  }
}

function classifyDocument(data) {
  if (data && typeof data === 'object') {
    if (data.type === 'FeatureCollection' || data.type === 'Feature') return 'geojson';
    if (typeof data.type === 'string' && data.coordinates) return 'geojson';
  }
  if (Array.isArray(data) && data.length > 0 && data.every((row) => (
    row && typeof row === 'object' && typeof row.field === 'string' && typeof row.pct === 'number'
  ))) {
    return 'report';
  }
  return 'json';
}

function asFeatureCollection(data) {
  if (data.type === 'FeatureCollection') return data;
  if (data.type === 'Feature') return { type: 'FeatureCollection', features: [data] };
  return {
    type: 'FeatureCollection',
    features: [{ type: 'Feature', geometry: data, properties: {} }],
  };
}

function closeOpenedFile() {
  if (layerUrl) {
    hideAll();
    fieldsSection.hidden = false;
    title.textContent = layerName;
    return;
  }
  if (serviceUrl) {
    inspect(serviceUrl);
    return;
  }
  hideAll();
  paste.hidden = false;
  title.textContent = 'Paste a map service';
  subtitle.textContent = '';
}

function originPattern(url) {
  return `${new URL(url).origin}/*`;
}

async function hasPermission(url) {
  if (!globalThis.chrome?.permissions) return true;
  return chrome.permissions.contains({ origins: [originPattern(url)] });
}

async function requestPermission(url) {
  if (!globalThis.chrome?.permissions) return true;
  return chrome.permissions.request({ origins: [originPattern(url)] });
}

function slug(name) {
  const value = String(name).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  return value || 'parcels';
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (char) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  })[char]);
}

async function saveFile(filename, text, mime) {
  const blob = new Blob([text], { type: mime });
  const url = URL.createObjectURL(blob);
  if (globalThis.chrome?.downloads?.download) {
    await chrome.downloads.download({ url, filename, saveAs: false });
    return;
  }
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  link.click();
}

function checkedFields() {
  return [...fieldList.querySelectorAll('input:checked')].map((input) => input.value);
}

function applyCheck(mode) {
  for (const row of fieldList.querySelectorAll('.field')) {
    const input = row.querySelector('input');
    if (mode === 'all') input.checked = true;
    else if (mode === 'none') input.checked = false;
    else input.checked = row.dataset.recommended === 'yes';
  }
}

function renderLayers(info) {
  hideAll();
  layersSection.hidden = false;
  title.textContent = info.name || 'Map service';
  layerList.replaceChildren();
  for (const layer of info.layers) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'layer';
    const name = document.createElement('strong');
    name.textContent = layer.name;
    const meta = document.createElement('span');
    meta.textContent = `${friendlyGeometry(layer.geometryType)} · layer ${layer.id}`;
    const text = document.createElement('span');
    text.append(name, meta);
    button.append(text);
    button.addEventListener('click', async () => {
      const allowed = await requestPermission(layer.url);
      if (!allowed) {
        showBanner('The map service stays blocked until you allow it.');
        return;
      }
      serviceUrl = subtitle.dataset.service || serviceUrl;
      await inspect(layer.url);
    });
    layerList.append(button);
  }
}

function renderFields(info, fill) {
  hideAll();
  fieldsSection.hidden = false;
  layerName = info.name || 'parcels';
  title.textContent = layerName;
  const count = Number.isFinite(info.count) ? featureCount(info.count) : 'Feature count unavailable';
  const sampled = fill ? ` · sampled ${nf.format(fill.sampled)} for field coverage` : '';
  layerCount.textContent = `${friendlyGeometry(info.geometryType)} · ${count}${sampled}`;
  downloadButton.textContent = Number.isFinite(info.count)
    ? `Download ${featureCount(info.count)}`
    : 'Download GeoJSON';
  fieldList.replaceChildren();

  for (const field of info.fields) {
    const pct = fill && Object.hasOwn(fill.fill, field.name) ? fill.fill[field.name] : undefined;
    const recommended = recommendedField(field, pct);
    const row = document.createElement('label');
    row.className = 'field';
    row.dataset.recommended = recommended ? 'yes' : 'no';
    row.dataset.search = `${field.alias} ${field.name}`.toLowerCase();
    const input = document.createElement('input');
    input.type = 'checkbox';
    input.value = field.name;
    input.checked = recommended;
    const alias = document.createElement('span');
    alias.className = 'alias';
    alias.textContent = field.alias;
    const meta = document.createElement('span');
    meta.className = 'meta';
    const coverage = pct === undefined ? field.type : `${field.type} · ${pct}% filled`;
    meta.textContent = field.alias === field.name ? coverage : `${field.name} · ${coverage}`;
    const text = document.createElement('span');
    text.append(alias, meta);
    row.append(input, text);
    fieldList.append(row);
  }
  backButton.hidden = !serviceUrl;
}

function drawMap(collection) {
  if (map) {
    map.remove();
    map = null;
  }
  mapNode.replaceChildren();
  if (!collection.features.length || !globalThis.L) {
    mapNode.hidden = true;
    return;
  }
  mapNode.hidden = false;
  map = L.map(mapNode, { scrollWheelZoom: true });
  L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', {
    maxZoom: 19,
    attribution: 'Tiles &copy; Esri',
  }).addTo(map);
  const layer = L.geoJSON(collection, {
    style: {
      color: '#1e3a32',
      weight: 1,
      fillColor: '#c46b3a',
      fillOpacity: 0.45,
    },
    onEachFeature(feature, leafletLayer) {
      const rows = Object.entries(feature.properties || {})
        .filter(([, value]) => value !== null && value !== undefined && String(value).trim() !== '')
        .slice(0, 10)
        .map(([key, value]) => `<div><strong>${escapeHtml(key)}</strong> ${escapeHtml(value)}</div>`)
        .join('');
      if (rows) leafletLayer.bindPopup(rows);
    },
  }).addTo(map);
  const bounds = layer.getBounds();
  if (bounds.isValid()) map.fitBounds(bounds, { padding: [24, 24] });
  else map.setView([55.342, -131.646], 11);
  requestAnimationFrame(() => map.invalidateSize());
}

function showResult(result) {
  saved = result;
  fieldsSection.hidden = true;
  resultSection.hidden = false;
  const name = slug(result.name || layerName);
  resultTitle.textContent = `Saved ${name}.geojson`;
  const dropped = result.dropped ? ` ${nf.format(result.dropped)} had no geometry and were skipped.` : '';
  resultCopy.textContent = `${featureCount(result.features.length)} downloaded to your computer.${dropped}`;
  backResult.hidden = !serviceUrl;
  changeFields.hidden = false;
  closeFileButton.hidden = true;
  drawMap(result.collection);
}

function showOpenedGeoJson(name, data) {
  const collection = asFeatureCollection(data);
  const features = collection.features || [];
  saved = {
    name: name.replace(/\.(geo)?json$/i, ''),
    features,
    collection,
    dropped: 0,
    report: fieldReport(features),
  };
  hideAll();
  resultSection.hidden = false;
  title.textContent = name;
  resultTitle.textContent = name;
  resultCopy.textContent = `${featureCount(features.length)}. Click a shape to read its fields.`;
  backResult.hidden = !serviceUrl;
  changeFields.hidden = true;
  closeFileButton.hidden = false;
  drawMap(collection);
}

function showOpenedReport(name, rows) {
  hideAll();
  reportSection.hidden = false;
  title.textContent = name;
  reportTitle.textContent = name;
  reportCopy.textContent = `${nf.format(rows.length)} ${rows.length === 1 ? 'field' : 'fields'}.`;
  reportTable.replaceChildren();
  const table = document.createElement('table');
  const head = document.createElement('tr');
  for (const label of ['Field', 'Filled', 'Percent']) {
    const cell = document.createElement('th');
    cell.textContent = label;
    head.append(cell);
  }
  table.append(head);
  const sorted = [...rows].sort((a, b) => b.pct - a.pct);
  for (const row of sorted) {
    const tr = document.createElement('tr');
    for (const value of [row.field, row.filled, `${row.pct}%`]) {
      const cell = document.createElement('td');
      cell.textContent = value === undefined || value === null ? '' : String(value);
      tr.append(cell);
    }
    table.append(tr);
  }
  reportTable.append(table);
}

function showOpenedJson(name, data) {
  hideAll();
  rawSection.hidden = false;
  title.textContent = name;
  rawTitle.textContent = name;
  const text = JSON.stringify(data, null, 2);
  rawJson.textContent = text.length > 200000 ? `${text.slice(0, 200000)}\n\n… file continues …` : text;
}

async function inspect(url) {
  const classified = classifyArcGisUrl(url);
  if (!classified) {
    showBanner('Use a URL that ends in MapServer, FeatureServer, or a layer number.');
    return;
  }
  showBanner('');
  hideAll();
  title.textContent = 'Reading the map service…';
  subtitle.textContent = classified.url;
  try {
    const info = await readEndpoint(classified.url, {
      token: tokenInput.value || null,
      where: whereInput.value.trim() || '1=1',
    });
    if (info.kind === 'service') {
      serviceUrl = classified.url;
      subtitle.dataset.service = classified.url;
      renderLayers(info);
      return;
    }
    layerUrl = classified.url;
    let fill = null;
    try {
      fill = await sampleFill(classified.url, {
        token: tokenInput.value || null,
        where: whereInput.value.trim() || '1=1',
      });
      if (!fill.sampled) fill = null;
    } catch {
      fill = null;
    }
    renderFields(info, fill);
  } catch (err) {
    hideAll();
    connect.hidden = false;
    title.textContent = 'Could not read the service';
    allow.textContent = (await hasPermission(classified.url)) ? 'Try again' : 'Continue';
    showBanner(err.message);
  }
}

allow.addEventListener('click', async () => {
  const url = subtitle.textContent;
  const allowed = await requestPermission(url);
  if (!allowed) {
    showBanner('The map service stays blocked until you allow it.');
    return;
  }
  await inspect(url);
});

paste.addEventListener('submit', async (event) => {
  event.preventDefault();
  const item = classifyArcGisUrl(pasteUrl.value.trim());
  if (!item) {
    showBanner('Use a URL that ends in MapServer, FeatureServer, or a layer number.');
    return;
  }
  subtitle.textContent = item.url;
  const allowed = await requestPermission(item.url);
  if (!allowed) {
    showBanner('The map service stays blocked until you allow it.');
    return;
  }
  await inspect(item.url);
});

filterInput.addEventListener('input', () => {
  const query = filterInput.value.trim().toLowerCase();
  for (const row of fieldList.querySelectorAll('.field')) {
    row.hidden = query ? !row.dataset.search.includes(query) : false;
  }
});

document.querySelector('#use-recommended').addEventListener('click', () => applyCheck('recommended'));
document.querySelector('#use-all').addEventListener('click', () => applyCheck('all'));
document.querySelector('#use-none').addEventListener('click', () => applyCheck('none'));

backButton.addEventListener('click', () => {
  if (serviceUrl) inspect(serviceUrl);
});
backResult.addEventListener('click', () => {
  if (serviceUrl) inspect(serviceUrl);
});

tokenInput.addEventListener('change', () => {
  chrome.storage?.local.set({ token: tokenInput.value });
});

async function runDownload() {
  const fields = checkedFields();
  if (!fields.length) {
    showBanner('Choose at least one field.');
    return;
  }
  showBanner('');
  downloadButton.disabled = true;
  const where = whereInput.value.trim() || '1=1';
  try {
    const result = await pullFeatures(layerUrl, {
      fields,
      where,
      token: tokenInput.value || null,
      precision: 6,
      batch: 500,
      onStatus: (message) => showBanner(message),
    }, ({ done, total }) => {
      downloadButton.textContent = `Fetched ${nf.format(done)} of ${nf.format(total)}`;
    });
    const filename = `${slug(result.name || layerName)}.geojson`;
    await saveFile(filename, JSON.stringify(result.collection), 'application/geo+json');
    showBanner('');
    showResult(result);
  } catch (err) {
    showBanner(err.message);
  } finally {
    downloadButton.disabled = false;
    if (downloadButton.textContent.startsWith('Fetched')) {
      downloadButton.textContent = 'Download GeoJSON';
    }
  }
}

downloadButton.addEventListener('click', runDownload);

changeFields.addEventListener('click', () => {
  resultSection.hidden = true;
  fieldsSection.hidden = false;
  if (map) {
    map.remove();
    map = null;
  }
});

againButton.addEventListener('click', async () => {
  if (!saved) return;
  try {
    const filename = `${slug(saved.name || layerName)}.geojson`;
    await saveFile(filename, JSON.stringify(saved.collection), 'application/geo+json');
  } catch (err) {
    showBanner(err.message);
  }
});

closeFileButton.addEventListener('click', closeOpenedFile);
document.querySelector('#close-report').addEventListener('click', closeOpenedFile);
document.querySelector('#close-raw').addEventListener('click', closeOpenedFile);

openInput.addEventListener('change', () => {
  const file = openInput.files?.[0];
  openInput.value = '';
  if (!file) return;
  file.text().then((text) => {
    try {
      const data = JSON.parse(text.replace(/^\uFEFF/, ''));
      const kind = classifyDocument(data);
      showBanner('');
      if (kind === 'geojson') showOpenedGeoJson(file.name, data);
      else if (kind === 'report') showOpenedReport(file.name, data);
      else showOpenedJson(file.name, data);
    } catch (err) {
      showBanner(`${file.name} is not JSON. ${err.message}`);
    }
  }).catch((err) => showBanner(err.message));
});

reportButton.addEventListener('click', async () => {
  if (!saved) return;
  try {
    const filename = `${slug(saved.name || layerName)}.fields.json`;
    await saveFile(filename, JSON.stringify(saved.report, null, 2), 'application/json');
  } catch (err) {
    showBanner(err.message);
  }
});

const params = new URLSearchParams(location.search);
const initial = classifyArcGisUrl(params.get('url') || '');
const stored = globalThis.chrome?.storage
  ? await chrome.storage.local.get({ token: '' })
  : { token: '' };
tokenInput.value = stored.token || '';

if (!initial) {
  hideAll();
  paste.hidden = false;
  title.textContent = 'Paste a map service';
} else {
  subtitle.textContent = initial.url;
  title.textContent = 'Map service';
  if (await hasPermission(initial.url)) {
    await inspect(initial.url);
  } else {
    hideAll();
    connect.hidden = false;
  }
}
