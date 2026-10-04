import { createLibrary, recordsFromText } from '/lib/library.js';
import { OWNER_COLORS, parties } from '/lib/ownership.js';
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
let changes = { gained: [], lost: [] };
let selected = null;
let current = null;
let map = null;
let parcelLayer = null;
let focusIds = new Set();
const ownerColorMap = new Map();

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

function paintColors() {
  ownerColorMap.clear();
  const ranked = library.ownerReport({ privateOnly: false, limit: OWNER_COLORS.length });
  ranked.shown.forEach((owner, index) => ownerColorMap.set(owner.ownerKey, OWNER_COLORS[index]));
}

function primaryOwnerKey(parcel) {
  const list = parties(parcel.owner_name, parcel.owner_2, parcel.shares);
  if (!list.length) return '';
  return list.reduce((best, party) => (party.share > best.share ? party : best)).key;
}

function renderOwners() {
  paintColors();
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
    const swatch = document.createElement('span');
    swatch.className = 'swatch';
    swatch.style.background = ownerColorMap.get(owner.ownerKey) || '#8d8478';
    const strong = document.createElement('strong');
    strong.textContent = owner.publicOwner ? `${owner.name} (public)` : owner.name;
    const meta = document.createElement('span');
    meta.className = 'fine';
    meta.textContent = `${owner.parcelCount} ${owner.parcelCount === 1 ? 'parcel' : 'parcels'} · ${acres(owner.acres)}`;
    name.append(swatch, strong, meta);
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
  focusIds = new Set(rows.map((row) => row.parcelno));
  refreshStyles();
  zoomTo(focusIds);
  await remember('search', query);
}

function styleFor(feature) {
  const fill = ownerColorMap.get(feature.properties.ownerKey) || '#8d8478';
  const id = feature.properties.parcelno;
  if (id === selected) return { color: '#fffaf3', weight: 3, fillColor: fill, fillOpacity: 0.85 };
  if (focusIds.has(id)) return { color: '#fffaf3', weight: 2.5, fillColor: fill, fillOpacity: 0.7 };
  return { color: '#fffaf3', weight: 1.2, fillColor: fill, fillOpacity: 0.55 };
}

function refreshStyles() {
  if (parcelLayer) parcelLayer.setStyle(styleFor);
}

function zoomTo(ids) {
  if (!map || !parcelLayer) return;
  const bounds = L.latLngBounds([]);
  parcelLayer.eachLayer((layer) => {
    const id = layer.feature?.properties?.parcelno;
    if (ids && ids.size && !ids.has(id)) return;
    if (layer.getBounds) bounds.extend(layer.getBounds());
    else if (layer.getLatLng) bounds.extend(layer.getLatLng());
  });
  if (bounds.isValid()) map.fitBounds(bounds, { padding: [24, 24], maxZoom: 16 });
}

function syncFeatureOwners() {
  if (!parcelLayer) return;
  parcelLayer.eachLayer((layer) => {
    const id = layer.feature?.properties?.parcelno;
    const parcel = library.parcels.find((item) => item.parcelno === id);
    if (parcel && layer.feature) layer.feature.properties.ownerKey = primaryOwnerKey(parcel);
  });
  refreshStyles();
}

function renderChanges() {
  const section = document.querySelector('#changes');
  const list = document.querySelector('#change-list');
  const lines = [
    ...(changes.gained || []).map((row) => `${row.name} gained ${row.count} ${row.count === 1 ? 'parcel' : 'parcels'}`),
    ...(changes.lost || []).map((row) => `${row.name} lost ${row.count} ${row.count === 1 ? 'parcel' : 'parcels'}`),
  ];
  list.replaceChildren(...lines.map((text) => {
    const item = document.createElement('li');
    item.textContent = text;
    return item;
  }));
  section.hidden = lines.length === 0;
}

function showMap() {
  paintColors();
  const note = document.querySelector('#map-note');
  const features = library.parcels.filter((parcel) => parcel.geometry).map((parcel) => ({
    type: 'Feature',
    geometry: parcel.geometry,
    properties: { parcelno: parcel.parcelno, ownerKey: primaryOwnerKey(parcel) },
  }));
  if (!features.length) {
    mapNode.hidden = true;
    note.hidden = false;
    note.textContent = 'This file has the owners and no parcel outlines. Drop the .geojson to see the map.';
    if (map) {
      map.remove();
      map = null;
      parcelLayer = null;
    }
    return;
  }
  note.hidden = true;
  mapNode.hidden = false;
  mapNode.getBoundingClientRect();
  if (!map) {
    map = L.map(mapNode, { preferCanvas: true });
    L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', {
      maxZoom: 19,
      attribution: 'Tiles © Esri',
    }).addTo(map);
  }
  if (parcelLayer) map.removeLayer(parcelLayer);
  parcelLayer = L.geoJSON({ type: 'FeatureCollection', features }, {
    style: styleFor,
    onEachFeature(feature, layer) {
      layer.on('click', () => showParcel(feature.properties.parcelno));
    },
  }).addTo(map);
  const fit = () => {
    map.invalidateSize();
    const bounds = parcelLayer.getBounds();
    if (bounds.isValid()) map.fitBounds(bounds, { padding: [16, 16] });
  };
  requestAnimationFrame(fit);
  setTimeout(fit, 250);
}

async function showParcel(parcelno) {
  const found = library.comps(parcelno);
  if (!found) {
    detailNode.textContent = 'That parcel is not in the saved file.';
    compsNode.replaceChildren();
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
    found.subject.totalValue != null ? `Assessed ${money(found.subject.totalValue)}` : '',
    found.subject.salePrice != null ? `Sold ${money(found.subject.salePrice)}` : '',
    found.subject.mailingLine,
  ].filter(Boolean).join(' · ');
  detailNode.append(title, copy);
  detailNode.append(saleForm(found.subject));
  if (found.subject.parties.length > 1) {
    const shares = document.createElement('p');
    shares.textContent = found.subject.parties.map((party) => `${party.name} ${pct(party.share)}`).join(' · ');
    detailNode.append(shares, shareForm(found.subject));
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
  focusIds = new Set([found.subject.parcelno, ...found.comps.map((comp) => comp.parcelno)]);
  refreshStyles();
  zoomTo(focusIds);
  mapNode.scrollIntoView({ block: 'nearest' });
  await remember('comps', parcelno);
}

function saleForm(subject) {
  const form = document.createElement('form');
  form.className = 'edit';
  const input = document.createElement('input');
  input.inputMode = 'decimal';
  input.autocomplete = 'off';
  input.placeholder = 'Sale price';
  input.setAttribute('aria-label', 'Sale price');
  input.value = subject.salePrice ?? '';
  const button = document.createElement('button');
  button.type = 'submit';
  button.className = 'ghost';
  button.textContent = 'Save sale';
  const note = document.createElement('span');
  note.className = 'fine';
  form.append(input, button, note);
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    const raw = input.value.trim().replace(/[$,]/g, '');
    if (raw !== '' && !Number.isFinite(Number(raw))) {
      note.textContent = 'Enter a sale price, or leave it blank to clear it.';
      return;
    }
    const sale = raw === '' || Number(raw) === 0 ? null : Number(raw);
    library.update(subject.parcelno, { sale_price: sale });
    await saveKey('parcels', library.parcels);
    renderOwners();
    await showParcel(subject.parcelno);
  });
  return form;
}

function shareForm(subject) {
  const form = document.createElement('form');
  form.className = 'edit';
  const inputs = subject.parties.map((party) => {
    const label = document.createElement('label');
    label.append(document.createTextNode(party.name));
    const input = document.createElement('input');
    input.inputMode = 'decimal';
    input.autocomplete = 'off';
    input.setAttribute('aria-label', `${party.name} percent`);
    const percent = Math.round(party.share * 1000) / 10;
    input.value = Number.isInteger(percent) ? String(percent) : percent.toFixed(1);
    label.append(input);
    form.append(label);
    return { key: party.key, input };
  });
  const button = document.createElement('button');
  button.type = 'submit';
  button.className = 'ghost';
  button.textContent = 'Save shares';
  const note = document.createElement('span');
  note.className = 'fine';
  form.append(button, note);
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    const shares = {};
    let total = 0;
    for (const row of inputs) {
      const percent = Number(row.input.value);
      if (!Number.isFinite(percent) || percent < 0) {
        note.textContent = 'Shares need to add up to 100.';
        return;
      }
      shares[row.key] = percent / 100;
      total += percent;
    }
    if (Math.abs(total - 100) >= 2) {
      note.textContent = 'Shares need to add up to 100.';
      return;
    }
    library.update(subject.parcelno, { shares });
    await saveKey('parcels', library.parcels);
    paintColors();
    syncFeatureOwners();
    renderOwners();
    await showParcel(subject.parcelno);
  });
  return form;
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
    if (library.parcels.length) {
      const result = library.replace(records);
      changes = result.changes;
    } else {
      library = createLibrary(records);
      changes = { gained: [], lost: [] };
    }
    await saveKey('parcels', library.parcels);
    await saveKey('changes', changes);
    selected = null;
    current = null;
    focusIds = new Set();
    detailNode.textContent = 'Click a parcel on the map, or an owner in the list.';
    compsNode.replaceChildren();
    explainButton.hidden = true;
    explanationNode.textContent = '';
    resultsNode.textContent = '';
    document.querySelector('#results-title').hidden = true;
    showWorkspace(true);
    showMap();
    renderOwners();
    renderChanges();
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
  changes = { gained: [], lost: [] };
  selected = null;
  current = null;
  await saveKey('parcels', []);
  await saveKey('searches', []);
  await saveKey('changes', changes);
  ownersNode.replaceChildren();
  resultsNode.replaceChildren();
  document.querySelector('#results-title').hidden = true;
  searchesNode.replaceChildren();
  detailNode.textContent = 'Click a parcel on the map, or an owner in the list.';
  renderChanges();
  compsNode.replaceChildren();
  mapNode.hidden = true;
  document.querySelector('#map-note').hidden = true;
  if (map) {
    map.remove();
    map = null;
    parcelLayer = null;
  }
  focusIds = new Set();
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
changes = (await loadKey('changes')) || { gained: [], lost: [] };
if (Array.isArray(savedParcels) && savedParcels.length) {
  library = createLibrary(savedParcels);
  showWorkspace(true);
  showMap();
  renderOwners();
  renderSearches();
  renderChanges();
}
