import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import {
  geometryAcres,
  geometryCentroid,
  parties,
  rankComps,
  summarizeOwners,
} from './ownership.js';
import { formatMailing, recordFromProperties, recordsFromCsv, recordsFromGeoJson } from './records.js';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS parcels (
  parcelno TEXT PRIMARY KEY,
  owner_name TEXT,
  owner_2 TEXT,
  mailing_address TEXT,
  mailing_city TEXT,
  mailing_state TEXT,
  mailing_zip TEXT,
  location TEXT,
  loc_city TEXT,
  subdivision TEXT,
  acres REAL,
  sqft REAL,
  land_value REAL,
  improvement_value REAL,
  total_value REAL,
  sale_price REAL,
  sale_year INTEGER,
  shares_json TEXT,
  zoning TEXT,
  year_built INTEGER,
  prop_use TEXT,
  bedrooms REAL,
  bathrooms REAL,
  lat REAL,
  lon REAL,
  geometry_json TEXT,
  properties_json TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS holdings (
  owner_key TEXT NOT NULL,
  display_name TEXT NOT NULL,
  public_owner INTEGER NOT NULL,
  parcelno TEXT NOT NULL,
  share REAL NOT NULL,
  acres REAL,
  value REAL,
  PRIMARY KEY (owner_key, parcelno)
);
CREATE TABLE IF NOT EXISTS searches (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  kind TEXT NOT NULL,
  query TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_parcels_owner ON parcels(owner_name);
CREATE INDEX IF NOT EXISTS idx_holdings_owner ON holdings(owner_key);
`;

export function openDatabase(file = ':memory:') {
  const db = new DatabaseSync(file);
  db.exec(SCHEMA);
  const names = new Set(db.prepare('PRAGMA table_info(parcels)').all().map((column) => column.name));
  if (!names.has('sale_price')) db.exec('ALTER TABLE parcels ADD COLUMN sale_price REAL');
  if (!names.has('sale_year')) db.exec('ALTER TABLE parcels ADD COLUMN sale_year INTEGER');
  if (!names.has('shares_json')) db.exec('ALTER TABLE parcels ADD COLUMN shares_json TEXT');
  return db;
}

export function importText(db, text, filename = '') {
  const records = /\.csv$/i.test(filename)
    ? recordsFromCsv(text)
    : recordsFromGeoJson(JSON.parse(String(text).replace(/^\uFEFF/, '')));
  return importRecords(db, records);
}

export function importFile(db, file) {
  return importText(db, readFileSync(file, 'utf8'), file);
}

export function importRecords(db, records) {
  const now = new Date().toISOString();
  const upsert = db.prepare(`
    INSERT INTO parcels (
      parcelno, owner_name, owner_2, mailing_address, mailing_city, mailing_state, mailing_zip,
      location, loc_city, subdivision, acres, sqft, land_value, improvement_value, total_value,
      sale_price, sale_year, shares_json,
      zoning, year_built, prop_use, bedrooms, bathrooms, lat, lon, geometry_json, properties_json, updated_at
    ) VALUES (
      ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
    )
    ON CONFLICT(parcelno) DO UPDATE SET
      owner_name = excluded.owner_name,
      owner_2 = excluded.owner_2,
      mailing_address = excluded.mailing_address,
      mailing_city = excluded.mailing_city,
      mailing_state = excluded.mailing_state,
      mailing_zip = excluded.mailing_zip,
      location = excluded.location,
      loc_city = excluded.loc_city,
      subdivision = excluded.subdivision,
      acres = excluded.acres,
      sqft = excluded.sqft,
      land_value = excluded.land_value,
      improvement_value = excluded.improvement_value,
      total_value = excluded.total_value,
      sale_price = COALESCE(excluded.sale_price, parcels.sale_price),
      sale_year = COALESCE(excluded.sale_year, parcels.sale_year),
      shares_json = COALESCE(excluded.shares_json, parcels.shares_json),
      zoning = excluded.zoning,
      year_built = excluded.year_built,
      prop_use = excluded.prop_use,
      bedrooms = excluded.bedrooms,
      bathrooms = excluded.bathrooms,
      lat = excluded.lat,
      lon = excluded.lon,
      geometry_json = excluded.geometry_json,
      properties_json = excluded.properties_json,
      updated_at = excluded.updated_at
  `);
  db.exec('BEGIN');
  try {
    let imported = 0;
    records.forEach((record, index) => {
      const row = parcelRow(record, index, now);
      if (!row) return;
      upsert.run(...row);
      imported += 1;
    });
    rebuildHoldings(db);
    db.exec('COMMIT');
    return { imported, parcels: countParcels(db) };
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

export function listParcels(db) {
  return db.prepare('SELECT * FROM parcels ORDER BY parcelno').all();
}

export function getParcel(db, parcelno) {
  return db.prepare('SELECT * FROM parcels WHERE parcelno = ?').get(parcelno) || null;
}

export function ownerReport(db, { privateOnly = false, limit = 25 } = {}) {
  const parcels = listParcels(db);
  const holdings = db.prepare('SELECT * FROM holdings').all();
  const owners = summarizeOwners(holdings, parcels)
    .filter((owner) => !privateOnly || !owner.publicOwner);
  const shown = owners.slice(0, limit);
  const acres = parcels.reduce((sum, parcel) => sum + (Number(parcel.acres) || 0), 0);
  const value = parcels.reduce((sum, parcel) => sum + (Number(parcel.total_value) || 0), 0);
  return {
    parcels: parcels.length,
    acres,
    value,
    owners: owners.length,
    shown,
  };
}

export function searchParcels(db, query, { save = true } = {}) {
  const text = String(query || '').trim();
  if (save && text) rememberSearch(db, 'search', text);
  if (!text) return [];
  const like = `%${text.replace(/[\\%_]/g, '')}%`;
  return db.prepare(`
    SELECT parcelno, owner_name, owner_2, mailing_city, mailing_state, location, loc_city, subdivision,
           acres, total_value, zoning, lat, lon
    FROM parcels
    WHERE parcelno LIKE ? OR owner_name LIKE ? OR owner_2 LIKE ? OR mailing_city LIKE ?
       OR loc_city LIKE ? OR location LIKE ? OR subdivision LIKE ? OR mailing_address LIKE ?
    ORDER BY owner_name, parcelno
    LIMIT 100
  `).all(like, like, like, like, like, like, like, like);
}

export function compsFor(db, parcelno, limit = 8, { save = true } = {}) {
  const subject = getParcel(db, parcelno);
  if (!subject) return null;
  if (save) rememberSearch(db, 'comps', parcelno);
  const others = db.prepare('SELECT * FROM parcels WHERE parcelno != ?').all(parcelno);
  return {
    subject: publicParcel(subject),
    comps: rankComps(subject, others, limit).map((parcel) => ({
      ...publicParcel(parcel),
      comp: parcel.comp,
    })),
  };
}

export function listSearches(db, limit = 20) {
  return db.prepare('SELECT id, kind, query, created_at FROM searches ORDER BY id DESC LIMIT ?').all(limit);
}

export function rememberSearch(db, kind, query) {
  const latest = db.prepare('SELECT kind, query FROM searches ORDER BY id DESC LIMIT 1').get();
  if (latest && latest.kind === kind && latest.query === query) return;
  db.prepare('INSERT INTO searches (kind, query, created_at) VALUES (?, ?, ?)').run(kind, query, new Date().toISOString());
}

function rebuildHoldings(db) {
  db.exec('DELETE FROM holdings');
  const insert = db.prepare(`
    INSERT INTO holdings (owner_key, display_name, public_owner, parcelno, share, acres, value)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);
  for (const parcel of listParcels(db)) {
    const shares = parseShares(parcel.shares_json);
    for (const party of parties(parcel.owner_name, parcel.owner_2, shares)) {
      insert.run(party.key, party.display, party.publicOwner ? 1 : 0, parcel.parcelno, party.share, parcel.acres, parcel.total_value);
    }
  }
}

function parseShares(value) {
  if (!value) return null;
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

export function updateParcel(db, parcelno, patch) {
  const parcel = getParcel(db, parcelno);
  if (!parcel) return null;
  if ('sale_price' in patch) {
    db.prepare('UPDATE parcels SET sale_price = ? WHERE parcelno = ?').run(patch.sale_price, parcelno);
  }
  if ('sale_year' in patch) {
    db.prepare('UPDATE parcels SET sale_year = ? WHERE parcelno = ?').run(patch.sale_year, parcelno);
  }
  if ('shares' in patch) {
    db.prepare('UPDATE parcels SET shares_json = ? WHERE parcelno = ?').run(
      patch.shares ? JSON.stringify(patch.shares) : null,
      parcelno,
    );
  }
  rebuildHoldings(db);
  return getParcel(db, parcelno);
}

function parcelRow(record, index, now) {
  const properties = record.properties || {};
  const mapped = recordFromProperties(properties);
  const parcelno = mapped.parcelno || `row-${index + 1}`;
  const acresFromGeometry = geometryAcres(record.geometry);
  const acres = mapped.acres ?? (mapped.sqft ? mapped.sqft / 43560 : null) ?? acresFromGeometry;
  const center = geometryCentroid(record.geometry);
  return [
    parcelno,
    mapped.owner_name,
    mapped.owner_2,
    mapped.mailing_address,
    mapped.mailing_city,
    mapped.mailing_state,
    mapped.mailing_zip,
    mapped.location,
    mapped.loc_city,
    mapped.subdivision,
    acres,
    mapped.sqft,
    mapped.land_value,
    mapped.improvement_value,
    mapped.total_value,
    mapped.sale_price ?? record.sale_price ?? null,
    mapped.sale_year ?? record.sale_year ?? null,
    record.shares ? JSON.stringify(record.shares) : null,
    mapped.zoning,
    mapped.year_built,
    mapped.prop_use,
    mapped.bedrooms,
    mapped.bathrooms,
    center?.lat ?? null,
    center?.lon ?? null,
    record.geometry ? JSON.stringify(record.geometry) : null,
    JSON.stringify(properties),
    now,
  ];
}

function countParcels(db) {
  return db.prepare('SELECT COUNT(*) AS count FROM parcels').get().count;
}

function publicParcel(parcel) {
  return {
    parcelno: parcel.parcelno,
    ownerName: parcel.owner_name,
    owner2: parcel.owner_2,
    mailingAddress: parcel.mailing_address,
    mailingCity: parcel.mailing_city,
    mailingState: parcel.mailing_state,
    mailingZip: parcel.mailing_zip,
    location: parcel.location,
    locCity: parcel.loc_city,
    subdivision: parcel.subdivision,
    mailingLine: formatMailing(parcel),
    acres: parcel.acres,
    totalValue: parcel.total_value,
    landValue: parcel.land_value,
    improvementValue: parcel.improvement_value,
    assessedPerAcre: parcel.acres ? (Number(parcel.total_value) || 0) / parcel.acres : null,
    salePrice: parcel.sale_price,
    saleYear: parcel.sale_year,
    zoning: parcel.zoning,
    yearBuilt: parcel.year_built,
    lat: parcel.lat,
    lon: parcel.lon,
    geometry: parcel.geometry_json ? JSON.parse(parcel.geometry_json) : null,
    parties: parties(parcel.owner_name, parcel.owner_2, parseShares(parcel.shares_json)).map((party) => ({
      name: party.display,
      share: party.share,
      publicOwner: party.publicOwner,
    })),
  };
}
