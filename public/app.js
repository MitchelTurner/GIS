import { createLibrary, recordsFromText } from '/lib/library.js';
import { loadKey, saveKey } from './persist.js';

const emptyNode = document.querySelector('#empty');
const workspaceNode = document.querySelector('#workspace');
const replaceNode = document.querySelector('#replace');
const ownersNode = document.querySelector('#owners');
const resultsNode = document.querySelector('#results');
const detailNode = document.querySelector('#detail');
const compsNode = document.querySelector('#comps');
const mapNode = document.querySelector('#map');
const explainButton = document.querySelector('#explain');
const explanationNode = document.querySelector('#explanation');
const searchesNode = document.querySelector('#searches');
const statusNode = document.querySelector('#status');
const fileInput = document.querySelector('#file');
const drop = document.querySelector('#drop');

let library = createLibrary();
let searches = [];
let selected = null;
let current = null;
let map = null;

function pct(value) {
  return `${(Number(value) * 100).toFixed(1)}%`;
}

function acres(value) {
  return value == null ? '' : `${Number(value).toFixed(2)} ac`;
}

function money(value) {
  if (value == null || Number.isNaN(Number(value))) return '';
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 }).format(value);
}

function showWorkspace(hasParcels) {
  emptyNode.hidden = hasParcels;
  workspaceNode.hidden = !hasParcels;
  replaceNode.hidden = !hasParcels;
  document.querySelector('#clear').hidden = !hasParcels;
}

async function remember(kind, query) {
  const text = String(query || '').trim();
  if (!text) return;
  const latest = searches[0];
  if (latest && latest.kind === kind && latest.query === text) return;
  searches.unshift({ kind, query: text });
  searches = searches.slice(0, 12);
  renderSearches();
  await saveKey('searches', searches);
}

function renderOwners() {
  const report = library.ownerReport({ privateOnly: document.querySelector('#private').checked, limit: 40 });
  const summary = document.createElement('p');
  summary.className = 'fine';
  const assessed = report.value ? ` · ${money(report.value)} assessed` : '';
  summary.textContent = `${report.parcels.toLocaleString()} parcels · ${report.acres.toFixed(1)} acres · ${report.owners.toLocaleString()} owners${assessed}`;
  const table = document.createElement('table');
  const head = document.createElement('tr');
  for (const label of ['Owner', 'Land', 'Assessed']) {
    const cell = document.createElement('th');
    cell.textContent = label;
    head.append(cell);
  }
  table.append(head);
  for (const owner of report.shown) {
    const row = document.createElement('tr');
    row.className = 'clickable';
    const name = document.createElement('td');
    const strong = document.createElement('strong');
    strong.textContent = owner.publicOwner ? `${owner.name} (public)` : owner.name;
    const meta = document.createElement('span');
    meta.className = 'fine';
    meta.textContent = `${owner.parcelCount} ${owner.parcelCount === 1 ? 'parcel' : 'parcels'} · ${acres(owner.acres)}`;
    name.append(strong, meta);
    const land = document.createElement('td');
    land.textContent = pct(owner.acreShare);
    const value = document.createElement('td');
    value.textContent = money(owner.value);
    row.append(name, land, value);
    row.addEventListener('click', () => searchParcels(owner.name));
    table.append(row);
  }
  ownersNode.replaceChildren(summary, table);
}

function renderSearches() {
  searchesNode.replaceChildren();
  for (const search of searches) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'ghost';
    button.textContent = search.query;
    button.addEventListener('click', () => {
      if (search.kind === 'comps') showParcel(search.query);
      else searchParcels(search.query);
    });
    searchesNode.append(button);
  }
}

function resultTable(rows) {
  const table = document.createElement('table');
  const head = document.createElement('tr');
  for (const label of ['Parcel', 'Owner', 'Where']) {
    const cell = document.createElement('th');
    cell.textContent = label;
    head.append(cell);
  }
  table.append(head);
  for (const row of rows) {
    const tr = document.createElement('tr');
    tr.className = 'clickable';
    for (const value of [row.parcelno, row.owner_name || '', [row.location, row.loc_city].filter(Boolean).join(', ')]) {
      const cell = document.createElement('td');
      cell.textContent = value;
      tr.append(cell);
    }
    tr.addEventListener('click', () => showParcel(row.parcelno));
    table.append(tr);
  }
  return table;
}

async function searchParcels(query) {
  document.querySelector('#q').value = query;
  const rows = library.search(query);
  document.querySelector('#results-title').hidden = false;
  if (!rows.length) resultsNode.textContent = 'No parcels matched.';
  else resultsNode.replaceChildren(resultTable(rows));
  await remember('search', query);
}

function featureGeometry(record) {
  if (record.geometry) return record.geometry;
  if (record.lon == null || record.lat == null) return null;
  return { type: 'Point', coordinates: [record.lon, record.lat] };
}

function drawMap(subject, comps) {
  const subjectGeometry = featureGeometry(subject);
  const compFeatures = comps.filter((comp) => featureGeometry(comp)).map((comp) => ({
    type: 'Feature',
    geometry: featureGeometry(comp),
    properties: { parcelno: comp.parcelno },
  }));
  if (!subjectGeometry && !compFeatures.length) {
    mapNode.hidden = true;
    return;
  }
  mapNode.hidden = false;
  if (map) {
    map.remove();
    map = null;
  }
  map = L.map(mapNode);
  L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', {
    maxZoom: 19,
    attribution: 'Tiles © Esri',
  }).addTo(map);
  const subjectLayer = L.geoJSON(subjectGeometry || { type: 'FeatureCollection', features: [] }, {
    style: { color: '#f4efe4', weight: 2, fillColor: '#c46b3a', fillOpacity: 0.55 },
  }).addTo(map);
  const compLayer = L.geoJSON({ type: 'FeatureCollection', features: compFeatures }, {
    style: { color: '#f4efe4', weight: 1, fillColor: '#1e3a32', fillOpacity: 0.35 },
  }).addTo(map);
  const group = L.featureGroup([subjectLayer, compLayer]);
  if (group.getBounds().isValid()) map.fitBounds(group.getBounds(), { padding: [20, 20] });
  requestAnimationFrame(() => map.invalidateSize());
}

async function showParcel(parcelno) {
  const found = library.comps(parcelno);
  if (!found) {
    detailNode.textContent = 'That parcel is not in the saved file.';
    compsNode.replaceChildren();
    mapNode.hidden = true;
    explainButton.hidden = true;
    return;
  }
  selected = parcelno;
  current = found;
  detailNode.replaceChildren();
  const title = document.createElement('strong');
  title.textContent = `${found.subject.parcelno} · ${found.subject.ownerName || 'No owner'}`;
  const copy = document.createElement('p');
  copy.textContent = [
    [found.subject.location, found.subject.locCity].filter(Boolean).join(', '),
    acres(found.subject.acres),
    found.subject.zoning,
    money(found.subject.totalValue),
    found.subject.mailingLine,
  ].filter(Boolean).join(' · ');
  detailNode.append(title, copy);
  if (found.subject.parties.length > 1) {
    const shares = document.createElement('p');
    shares.textContent = found.subject.parties.map((party) => `${party.name} ${pct(party.share)}`).join(' · ');
    detailNode.append(shares);
  }
  const list = document.createElement('ol');
  list.className = 'comps';
  for (const comp of found.comps) {
    const item = document.createElement('li');
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'ghost';
    button.textContent = `${comp.comp.score.toFixed(0)} · ${comp.ownerName || comp.parcelno}`;
    button.addEventListener('click', () => showParcel(comp.parcelno));
    const why = document.createElement('span');
    why.textContent = comp.comp.reasons.join(', ') || 'loose match';
    item.append(button, why);
    list.append(item);
  }
  compsNode.replaceChildren(list);
  explainButton.hidden = false;
  explanationNode.textContent = '';
  drawMap(found.subject, found.comps);
  await remember('comps', parcelno);
}

async function useFile(file) {
  statusNode.textContent = `Reading ${file.name}…`;
  try {
    const text = await file.text();
    const records = recordsFromText(text, file.name);
    if (!records.length) {
      statusNode.textContent = `${file.name} has no parcels.`;
      return;
    }
    library = createLibrary(records);
    await saveKey('parcels', library.parcels);
    selected = null;
    current = null;
    detailNode.textContent = 'Choose an owner.';
    compsNode.replaceChildren();
    mapNode.hidden = true;
    explainButton.hidden = true;
    explanationNode.textContent = '';
    resultsNode.textContent = '';
    document.querySelector('#results-title').hidden = true;
    showWorkspace(true);
    renderOwners();
    statusNode.textContent = '';
    fileInput.value = '';
  } catch (error) {
    statusNode.textContent = `${file.name} could not be read. ${error.message}`;
  }
}

document.querySelector('#drop').addEventListener('click', () => fileInput.click());
replaceNode.addEventListener('click', () => fileInput.click());

fileInput.addEventListener('change', () => {
  const file = fileInput.files?.[0];
  if (file) useFile(file);
});

drop.addEventListener('dragover', (event) => {
  event.preventDefault();
  drop.classList.add('dragging');
});
drop.addEventListener('dragleave', () => drop.classList.remove('dragging'));
drop.addEventListener('drop', (event) => {
  event.preventDefault();
  drop.classList.remove('dragging');
  const file = event.dataTransfer?.files?.[0];
  if (file) useFile(file);
});

document.querySelector('#search-form').addEventListener('submit', (event) => {
  event.preventDefault();
  searchParcels(document.querySelector('#q').value);
});
document.querySelector('#private').addEventListener('change', renderOwners);
document.querySelector('#clear').addEventListener('click', async () => {
  library = createLibrary();
  searches = [];
  selected = null;
  current = null;
  await saveKey('parcels', []);
  await saveKey('searches', []);
  ownersNode.replaceChildren();
  resultsNode.replaceChildren();
  document.querySelector('#results-title').hidden = true;
  searchesNode.replaceChildren();
  detailNode.textContent = 'Choose an owner.';
  compsNode.replaceChildren();
  mapNode.hidden = true;
  explainButton.hidden = true;
  explanationNode.textContent = '';
  showWorkspace(false);
});
explainButton.addEventListener('click', async () => {
  if (!current) return;
  explanationNode.textContent = 'Comparing…';
  try {
    const slim = ({ geometry, ...parcel }) => parcel;
    const res = await fetch('/api/explain', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        subject: slim(current.subject),
        comps: current.comps.map(slim),
      }),
    });
    const body = await res.json();
    explanationNode.textContent = body.text || body.error || 'No comparison came back.';
  } catch {
    explanationNode.textContent = 'The comparison did not finish. The ranked comps are still on this page.';
  }
});

const savedParcels = await loadKey('parcels');
searches = (await loadKey('searches')) || [];
if (Array.isArray(savedParcels) && savedParcels.length) {
  library = createLibrary(savedParcels);
  showWorkspace(true);
  renderOwners();
  renderSearches();
}
