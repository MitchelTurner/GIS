import { createLibrary, recordsFromText } from '/lib/library.js';
import { OWNER_COLORS, parties, perAcre } from '/lib/ownership.js';
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
let outreach = {};
let links = {};
let indexedFeatures = [];
let moveTimer = null;
const CONTACT_STATUS = {
  contact: 'Want to contact',
  called: 'Called',
  pass: 'Not interested',
};
let selected = null;
let current = null;
let map = null;
let parcelLayer = null;
let focusIds = new Set();
const ownerColorMap = new Map();
let importToken = 0;
let pendingFileKey = '';

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
  document.querySelector('#export').hidden = !hasParcels;
}

function rateLabel(value, size) {
  const rate = perAcre(value, size);
  return rate == null ? '' : `${money(rate)}/ac`;
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

function primaryParty(parcel) {
  const list = parties(parcel.owner_name, parcel.owner_2, parcel.shares);
  if (!list.length) return null;
  return list.reduce((best, party) => (party.share > best.share ? party : best));
}

function primaryOwnerKey(parcel) {
  const party = primaryParty(parcel);
  return party ? library.resolve(party.key) : '';
}

function parcelPasses(parcel) {
  if (document.querySelector('#private').checked && primaryParty(parcel)?.publicOwner) return false;
  const zoning = document.querySelector('#zoning').value;
  if (zoning && String(parcel.zoning || '') !== zoning) return false;
  const max = Number(String(document.querySelector('#max-acre').value || '').replace(/[$,]/g, ''));
  if (Number.isFinite(max) && max > 0) {
    const rate = perAcre(parcel.total_value, parcel.acres);
    if (rate == null || rate > max) return false;
  }
  return true;
}

function fillZoning() {
  const select = document.querySelector('#zoning');
  const current = select.value;
  const zones = [...new Set(library.parcels.map((parcel) => parcel.zoning).filter(Boolean))]
    .sort((a, b) => String(a).localeCompare(String(b)));
  select.replaceChildren(new Option('All zoning', ''));
  for (const zone of zones) select.append(new Option(zone, zone));
  if ([...select.options].some((option) => option.value === current)) select.value = current;
}

function renderOwners() {
  paintColors();
  fillZoning();
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
    const bits = [`${owner.parcelCount} ${owner.parcelCount === 1 ? 'parcel' : 'parcels'}`, acres(owner.acres)];
    if (outreach[owner.ownerKey]?.status) bits.push(CONTACT_STATUS[outreach[owner.ownerKey].status]);
    meta.textContent = bits.filter(Boolean).join(' · ');
    name.append(swatch, strong, meta);
    const land = document.createElement('td');
    land.textContent = pct(owner.acreShare);
    const value = document.createElement('td');
    value.textContent = money(owner.value);
    const per = document.createElement('span');
    per.className = 'fine';
    per.textContent = rateLabel(owner.value, owner.acres);
    value.append(per);
    row.append(name, land, value);
    row.addEventListener('click', () => showOwner(owner.ownerKey));
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

function bboxOf(geometry) {
  let minLon = Infinity;
  let minLat = Infinity;
  let maxLon = -Infinity;
  let maxLat = -Infinity;
  let count = 0;
  const walk = (node) => {
    if (!Array.isArray(node)) return;
    if (typeof node[0] === 'number' && typeof node[1] === 'number') {
      count += 1;
      minLon = Math.min(minLon, node[0]);
      maxLon = Math.max(maxLon, node[0]);
      minLat = Math.min(minLat, node[1]);
      maxLat = Math.max(maxLat, node[1]);
      return;
    }
    for (const child of node) walk(child);
  };
  walk(geometry?.coordinates);
  if (!count) return null;
  return { minLon, minLat, maxLon, maxLat };
}

function intersects(box, bounds) {
  if (!box || !bounds) return true;
  return box.maxLat >= bounds.getSouth() && box.minLat <= bounds.getNorth()
    && box.maxLon >= bounds.getWest() && box.minLon <= bounds.getEast();
}

function zoomTo(ids) {
  if (!map) return;
  const bounds = L.latLngBounds([]);
  for (const parcel of library.parcels) {
    if (ids?.size && !ids.has(parcel.parcelno)) continue;
    const box = bboxOf(parcel.geometry);
    if (box) bounds.extend([[box.minLat, box.minLon], [box.maxLat, box.maxLon]]);
  }
  if (bounds.isValid()) map.fitBounds(bounds, { padding: [24, 24], maxZoom: 16 });
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

function indexFeatures() {
  indexedFeatures = library.parcels.filter((parcel) => parcel.geometry).map((parcel) => ({
    type: 'Feature',
    geometry: parcel.geometry,
    bbox: bboxOf(parcel.geometry),
    properties: {
      parcelno: parcel.parcelno,
      ownerKey: primaryOwnerKey(parcel),
      ownerName: parcel.owner_name || 'No owner',
    },
  }));
}

function drawVisible() {
  if (!map) return;
  let view = null;
  try {
    const bounds = map.getBounds();
    view = bounds?.isValid() ? bounds.pad(0.2) : null;
  } catch {
    view = null;
  }
  const byParcel = new Map(library.parcels.map((parcel) => [parcel.parcelno, parcel]));
  const visible = indexedFeatures.filter((feature) => {
    const parcel = byParcel.get(feature.properties.parcelno);
    return parcel && parcelPasses(parcel) && intersects(feature.bbox, view);
  });
  if (parcelLayer) map.removeLayer(parcelLayer);
  parcelLayer = L.geoJSON({ type: 'FeatureCollection', features: visible }, {
    style: styleFor,
    onEachFeature(feature, layer) {
      layer.bindTooltip(`${feature.properties.parcelno} · ${feature.properties.ownerName}`, { sticky: true });
      layer.on('click', () => showParcel(feature.properties.parcelno));
    },
  }).addTo(map);
  mapNode.dataset.shown = String(visible.length);
  const note = document.querySelector('#map-note');
  const anyGeometry = indexedFeatures.length > 0;
  const anyMatch = library.parcels.some((parcel) => parcel.geometry && parcelPasses(parcel));
  if (anyGeometry && !anyMatch) {
    note.hidden = false;
    note.textContent = 'No parcels match these filters.';
  } else if (anyGeometry) {
    note.hidden = true;
  }
}

function showMap({ fit = true } = {}) {
  paintColors();
  indexFeatures();
  const note = document.querySelector('#map-note');
  const features = indexedFeatures;
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
    map.on('moveend', () => {
      clearTimeout(moveTimer);
      moveTimer = setTimeout(drawVisible, 120);
    });
  }
  const place = () => {
    map.invalidateSize();
    if (fit) {
      const bounds = L.latLngBounds([]);
      for (const feature of indexedFeatures) {
        if (feature.bbox) bounds.extend([[feature.bbox.minLat, feature.bbox.minLon], [feature.bbox.maxLat, feature.bbox.maxLon]]);
      }
      if (bounds.isValid()) map.fitBounds(bounds, { padding: [16, 16] });
    }
    drawVisible();
  };
  requestAnimationFrame(place);
  setTimeout(place, 250);
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
  document.querySelector('#detail-title').textContent = 'Parcel';
  detailNode.replaceChildren();
  const title = document.createElement('strong');
  title.textContent = `${found.subject.parcelno} · ${found.subject.ownerName || 'No owner'}`;
  const copy = document.createElement('p');
  const assessedRate = rateLabel(found.subject.totalValue, found.subject.acres);
  const saleRate = rateLabel(found.subject.salePrice, found.subject.acres);
  copy.textContent = [
    [found.subject.location, found.subject.locCity].filter(Boolean).join(', '),
    acres(found.subject.acres),
    found.subject.zoning,
    found.subject.totalValue != null ? `Assessed ${money(found.subject.totalValue)}${assessedRate ? ` (${assessedRate})` : ''}` : '',
    found.subject.salePrice != null ? `Sold ${money(found.subject.salePrice)}${saleRate ? ` (${saleRate})` : ''}${found.subject.saleYear ? ` in ${found.subject.saleYear}` : ''}` : '',
    found.subject.mailingLine,
  ].filter(Boolean).join(' · ');
  detailNode.append(title, copy);
  const extra = [
    found.subject.landValue != null ? `Land ${money(found.subject.landValue)}` : '',
    found.subject.improvementValue != null ? `Improvements ${money(found.subject.improvementValue)}` : '',
    found.subject.yearBuilt ? `Built ${found.subject.yearBuilt}` : '',
  ].filter(Boolean);
  if (extra.length) {
    const built = document.createElement('p');
    built.textContent = extra.join(' · ');
    detailNode.append(built);
  }
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

async function showOwner(ownerKey) {
  const owner = library.ownerDetail(ownerKey);
  if (!owner) return;
  selected = null;
  current = null;
  document.querySelector('#detail-title').textContent = 'Owner';
  detailNode.replaceChildren();
  compsNode.replaceChildren();
  explainButton.hidden = true;
  explanationNode.textContent = '';
  const title = document.createElement('strong');
  title.textContent = owner.publicOwner ? `${owner.name} (public)` : owner.name;
  const copy = document.createElement('p');
  copy.textContent = [
    owner.mailingLine,
    `${owner.parcelCount} ${owner.parcelCount === 1 ? 'parcel' : 'parcels'}`,
    acres(owner.acres),
    money(owner.value),
    rateLabel(owner.value, owner.acres),
  ].filter(Boolean).join(' · ');
  detailNode.append(title, copy);
  const form = document.createElement('form');
  form.className = 'edit';
  const status = document.createElement('select');
  status.setAttribute('aria-label', 'Contact status');
  status.append(new Option('No status', ''));
  for (const [value, label] of Object.entries(CONTACT_STATUS)) status.append(new Option(label, value));
  status.value = outreach[owner.ownerKey]?.status || '';
  const note = document.createElement('textarea');
  note.setAttribute('aria-label', 'Contact note');
  note.placeholder = 'Note';
  note.value = outreach[owner.ownerKey]?.note || '';
  const save = document.createElement('button');
  save.type = 'submit';
  save.className = 'ghost';
  save.textContent = 'Save contact';
  form.append(status, note, save);
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    if (!status.value && !note.value.trim()) delete outreach[owner.ownerKey];
    else outreach[owner.ownerKey] = { status: status.value, note: note.value.trim() };
    await saveKey('outreach', outreach);
    renderOwners();
    await showOwner(owner.ownerKey);
  });
  detailNode.append(form);
  if (owner.linked.length) {
    const linked = document.createElement('p');
    linked.textContent = `Same owner as ${owner.linked.map((item) => item.name).join(', ')}`;
    const unlink = document.createElement('button');
    unlink.type = 'button';
    unlink.className = 'ghost';
    unlink.textContent = 'Unlink';
    unlink.addEventListener('click', async () => {
      for (const item of owner.linked) delete links[item.key];
      library.setLinks(links);
      await saveKey('links', links);
      renderOwners();
      indexFeatures();
      drawVisible();
      await showOwner(owner.ownerKey);
    });
    detailNode.append(linked, unlink);
  }
  const linkForm = document.createElement('form');
  linkForm.className = 'edit';
  const linkInput = document.createElement('input');
  linkInput.setAttribute('aria-label', 'Same owner as');
  linkInput.placeholder = 'Same owner as';
  const linkButton = document.createElement('button');
  linkButton.type = 'submit';
  linkButton.className = 'ghost';
  linkButton.textContent = 'Link';
  const linkNote = document.createElement('span');
  linkNote.className = 'fine';
  linkForm.append(linkInput, linkButton, linkNote);
  linkForm.addEventListener('submit', async (event) => {
    event.preventDefault();
    const needle = linkInput.value.trim().toLowerCase();
    const owners = library.ownerReport({ limit: 10000 }).shown
      .filter((item) => item.ownerKey !== owner.ownerKey);
    const exact = owners.filter((item) => item.name.toLowerCase() === needle);
    const loose = owners.filter((item) => item.name.toLowerCase().includes(needle));
    const chosen = exact[0] || (loose.length === 1 ? loose[0] : null);
    if (!needle || !chosen) {
      linkNote.textContent = 'Type the other owner’s full name.';
      return;
    }
    links[chosen.ownerKey] = owner.ownerKey;
    if (outreach[chosen.ownerKey] && !outreach[owner.ownerKey]) outreach[owner.ownerKey] = outreach[chosen.ownerKey];
    delete outreach[chosen.ownerKey];
    library.setLinks(links);
    await saveKey('links', links);
    await saveKey('outreach', outreach);
    renderOwners();
    indexFeatures();
    drawVisible();
    await showOwner(owner.ownerKey);
  });
  detailNode.append(linkForm);
  const parcels = document.createElement('div');
  parcels.className = 'owner-parcels';
  for (const parcel of owner.parcelList) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'ghost';
    button.textContent = parcel.parcelno;
    button.addEventListener('click', () => showParcel(parcel.parcelno));
    parcels.append(button);
  }
  detailNode.append(parcels);
  focusIds = new Set(owner.parcelList.map((parcel) => parcel.parcelno));
  refreshStyles();
  zoomTo(focusIds);
  mapNode.scrollIntoView({ block: 'nearest' });
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
  const yearInput = document.createElement('input');
  yearInput.inputMode = 'numeric';
  yearInput.autocomplete = 'off';
  yearInput.placeholder = 'Sale year';
  yearInput.setAttribute('aria-label', 'Sale year');
  yearInput.value = subject.saleYear ?? '';
  const button = document.createElement('button');
  button.type = 'submit';
  button.className = 'ghost';
  button.textContent = 'Save sale';
  const note = document.createElement('span');
  note.className = 'fine';
  form.append(input, yearInput, button, note);
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    const raw = input.value.trim().replace(/[$,]/g, '');
    const yearRaw = yearInput.value.trim();
    if (raw !== '' && !Number.isFinite(Number(raw))) {
      note.textContent = 'Enter a sale price, or leave it blank to clear it.';
      return;
    }
    const year = yearRaw === '' ? null : Number(yearRaw);
    if (year != null && (!Number.isInteger(year) || year < 1800 || year > 2100)) {
      note.textContent = 'Enter a sale year, or leave it blank.';
      return;
    }
    const sale = raw === '' || Number(raw) === 0 ? null : Number(raw);
    library.update(subject.parcelno, { sale_price: sale, sale_year: sale == null ? null : year });
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
    indexFeatures();
    drawVisible();
    renderOwners();
    await showParcel(subject.parcelno);
  });
  return form;
}

async function useFile(file) {
  const key = `${file.name}:${file.size}:${file.lastModified}`;
  if (key === pendingFileKey) return;
  pendingFileKey = key;
  const token = ++importToken;
  statusNode.textContent = `Reading ${file.name}…`;
  try {
    const text = await file.text();
    if (token !== importToken) return;
    const records = recordsFromText(text, file.name);
    if (!records.length) {
      statusNode.textContent = `${file.name} has no parcels.`;
      if (pendingFileKey === key) pendingFileKey = '';
      return;
    }
    if (library.parcels.length) {
      const result = library.replace(records);
      changes = result.changes;
    } else {
      library = createLibrary(records);
      library.setLinks(links);
      changes = { gained: [], lost: [] };
    }
    await saveKey('parcels', library.parcels);
    await saveKey('changes', changes);
    if (token !== importToken) return;
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
    if (token === importToken) {
      statusNode.textContent = `${file.name} could not be read. ${error.message}`;
      if (pendingFileKey === key) pendingFileKey = '';
    }
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
document.querySelector('#private').addEventListener('change', () => {
  renderOwners();
  if (map) drawVisible();
});
document.querySelector('#zoning').addEventListener('change', () => {
  if (map) drawVisible();
});
document.querySelector('#max-acre').addEventListener('change', () => {
  if (map) drawVisible();
});
document.querySelector('#export').addEventListener('click', () => {
  const rows = library.ownerReport({ limit: 10000 }).shown
    .map((owner) => ({ owner, contact: outreach[owner.ownerKey] }))
    .filter((row) => row.contact?.status);
  if (!rows.length) {
    statusNode.textContent = 'Mark an owner to build the contact list.';
    return;
  }
  const lines = [[
    'Name', 'Mailing', 'Status', 'Note', 'Parcels', 'Acres', 'Assessed',
  ].join(',')];
  for (const row of rows) {
    const detail = library.ownerDetail(row.owner.ownerKey);
    lines.push([
      row.owner.name,
      detail?.mailingLine || '',
      CONTACT_STATUS[row.contact.status] || '',
      row.contact.note || '',
      detail?.parcelList.map((parcel) => parcel.parcelno).join(' ') || '',
      row.owner.acres == null ? '' : Number(row.owner.acres).toFixed(2),
      row.owner.value == null ? '' : Math.round(row.owner.value),
    ].map(csvCell).join(','));
  }
  const blob = new Blob([`${lines.join('\n')}\n`], { type: 'text/csv' });
  const link = document.createElement('a');
  link.href = URL.createObjectURL(blob);
  link.download = 'ketchikan-contacts.csv';
  link.click();
  URL.revokeObjectURL(link.href);
  statusNode.textContent = '';
});
document.querySelector('#clear').addEventListener('click', async () => {
  library = createLibrary();
  searches = [];
  changes = { gained: [], lost: [] };
  outreach = {};
  links = {};
  selected = null;
  current = null;
  await saveKey('parcels', []);
  await saveKey('searches', []);
  await saveKey('changes', changes);
  await saveKey('outreach', outreach);
  await saveKey('links', links);
  document.querySelector('#detail-title').textContent = 'Parcel';
  document.querySelector('#zoning').replaceChildren(new Option('All zoning', ''));
  document.querySelector('#max-acre').value = '';
  document.querySelector('#private').checked = false;
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

function csvCell(value) {
  const text = String(value ?? '');
  return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

const savedParcels = await loadKey('parcels');
searches = (await loadKey('searches')) || [];
changes = (await loadKey('changes')) || { gained: [], lost: [] };
outreach = (await loadKey('outreach')) || {};
links = (await loadKey('links')) || {};
if (Array.isArray(savedParcels) && savedParcels.length) {
  library = createLibrary(savedParcels);
  library.setLinks(links);
  showWorkspace(true);
  showMap();
  renderOwners();
  renderSearches();
  renderChanges();
}
