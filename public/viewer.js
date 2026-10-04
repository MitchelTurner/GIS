export function classifyDocument(data) {
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

export function asFeatureCollection(data) {
  if (data.type === 'FeatureCollection') return data;
  if (data.type === 'Feature') return { type: 'FeatureCollection', features: [data] };
  return {
    type: 'FeatureCollection',
    features: [{ type: 'Feature', geometry: data, properties: {} }],
  };
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

function popupHtml(properties) {
  const rows = Object.entries(properties || {})
    .filter(([, value]) => value !== null && value !== undefined && String(value).trim() !== '')
    .slice(0, 12);
  if (!rows.length) return 'No attributes';
  return rows.map(([key, value]) => `<div><strong>${escapeHtml(key)}</strong> ${escapeHtml(value)}</div>`).join('');
}

let map = null;

function hideOutputs() {
  for (const id of ['view-map', 'view-table', 'view-raw']) {
    const node = document.getElementById(id);
    if (node) node.hidden = true;
  }
}

function drawMap(collection) {
  const node = document.getElementById('view-map');
  node.hidden = false;
  if (map) {
    map.remove();
    map = null;
  }
  node.replaceChildren();
  map = L.map(node);
  L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', {
    maxZoom: 19,
    attribution: 'Tiles &copy; Esri',
  }).addTo(map);
  const layer = L.geoJSON(collection, {
    style: {
      color: '#f4efe4',
      weight: 1.5,
      fillColor: '#c46b3a',
      fillOpacity: 0.35,
    },
    onEachFeature(feature, leafletLayer) {
      leafletLayer.bindPopup(popupHtml(feature.properties));
    },
  }).addTo(map);
  const bounds = layer.getBounds();
  if (bounds.isValid()) map.fitBounds(bounds, { padding: [24, 24] });
  else map.setView([55.342, -131.646], 11);
  requestAnimationFrame(() => map.invalidateSize());
  return layer;
}

function drawReport(rows) {
  const wrap = document.getElementById('view-table');
  wrap.hidden = false;
  wrap.replaceChildren();
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
  wrap.append(table);
}

function drawJson(data) {
  const pre = document.getElementById('view-raw');
  pre.hidden = false;
  const text = JSON.stringify(data, null, 2);
  pre.textContent = text.length > 200000 ? `${text.slice(0, 200000)}\n\n… file continues …` : text;
}

export function showDocument(name, data) {
  const status = document.getElementById('file-status');
  hideOutputs();
  const kind = classifyDocument(data);
  if (kind === 'geojson') {
    const collection = asFeatureCollection(data);
    const count = collection.features?.length || 0;
    status.textContent = `${name}: ${count.toLocaleString()} ${count === 1 ? 'feature' : 'features'}. Click a shape to read its fields.`;
    drawMap(collection);
    return;
  }
  if (kind === 'report') {
    status.textContent = `${name}: ${data.length.toLocaleString()} fields.`;
    drawReport(data);
    return;
  }
  status.textContent = `${name}: JSON.`;
  drawJson(data);
}

function readFile(file) {
  const status = document.getElementById('file-status');
  file.text().then((text) => {
    try {
      showDocument(file.name, JSON.parse(text.replace(/^\uFEFF/, '')));
    } catch (err) {
      hideOutputs();
      status.textContent = `${file.name} is not JSON. ${err.message}`;
    }
  }).catch((err) => {
    status.textContent = err.message;
  });
}

const input = typeof document === 'undefined' ? null : document.getElementById('file');
const drop = typeof document === 'undefined' ? null : document.getElementById('drop');
if (input && drop) {
  input.addEventListener('change', () => {
    if (input.files?.[0]) readFile(input.files[0]);
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
    if (file) readFile(file);
  });
}
