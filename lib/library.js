import { geometryAcres, geometryCentroid, ownershipChanges, parties, perAcre, rankComps, resolveOwnerKey, saleYearOf, summarizeOwners } from './ownership.js';
import { formatMailing, recordFromProperties, recordsFromCsv, recordsFromGeoJson } from './records.js';

export function recordsFromText(text, filename = '') {
  if (/\.csv$/i.test(filename)) return recordsFromCsv(text);
  return recordsFromGeoJson(JSON.parse(String(text).replace(/^\uFEFF/, '')));
}

export function normalizeRecord(record, index = 0) {
  const properties = record?.properties || {};
  const mapped = recordFromProperties(properties);
  const parcelno = mapped.parcelno || record?.parcelno || `row-${index + 1}`;
  const geometry = record?.geometry || null;
  const acresFromGeometry = geometryAcres(geometry);
  const acres = mapped.acres ?? (mapped.sqft ? mapped.sqft / 43560 : null) ?? record?.acres ?? acresFromGeometry;
  const center = geometryCentroid(geometry);
  return {
    parcelno,
    owner_name: mapped.owner_name ?? record?.owner_name ?? null,
    owner_2: mapped.owner_2 ?? record?.owner_2 ?? null,
    mailing_address: mapped.mailing_address ?? record?.mailing_address ?? null,
    mailing_city: mapped.mailing_city ?? record?.mailing_city ?? null,
    mailing_state: mapped.mailing_state ?? record?.mailing_state ?? null,
    mailing_zip: mapped.mailing_zip ?? record?.mailing_zip ?? null,
    location: mapped.location ?? record?.location ?? null,
    loc_city: mapped.loc_city ?? record?.loc_city ?? null,
    subdivision: mapped.subdivision ?? record?.subdivision ?? null,
    acres,
    total_value: mapped.total_value ?? record?.total_value ?? null,
    land_value: mapped.land_value ?? record?.land_value ?? null,
    improvement_value: mapped.improvement_value ?? record?.improvement_value ?? null,
    year_built: mapped.year_built ?? record?.year_built ?? null,
    sale_price: mapped.sale_price ?? record?.sale_price ?? null,
    sale_year: saleYearOf(mapped) ?? saleYearOf(record),
    shares: record?.shares && typeof record.shares === 'object' ? record.shares : null,
    zoning: mapped.zoning ?? record?.zoning ?? null,
    lat: center?.lat ?? record?.lat ?? null,
    lon: center?.lon ?? record?.lon ?? null,
    geometry,
  };
}

function dedupe(parcels) {
  const map = new Map();
  for (const parcel of parcels) map.set(parcel.parcelno, parcel);
  return [...map.values()].sort((a, b) => String(a.parcelno).localeCompare(String(b.parcelno)));
}

export function viewParcel(parcel) {
  return {
    parcelno: parcel.parcelno,
    ownerName: parcel.owner_name,
    mailingLine: formatMailing(parcel),
    mailingCity: parcel.mailing_city,
    location: parcel.location,
    locCity: parcel.loc_city,
    subdivision: parcel.subdivision,
    acres: parcel.acres,
    totalValue: parcel.total_value,
    landValue: parcel.land_value,
    improvementValue: parcel.improvement_value,
    yearBuilt: parcel.year_built,
    assessedPerAcre: perAcre(parcel.total_value, parcel.acres),
    salePrice: parcel.sale_price,
    saleYear: parcel.sale_year,
    salePerAcre: perAcre(parcel.sale_price, parcel.acres),
    zoning: parcel.zoning,
    lat: parcel.lat,
    lon: parcel.lon,
    geometry: parcel.geometry,
    parties: parties(parcel.owner_name, parcel.owner_2, parcel.shares).map((party) => ({
      key: party.key,
      name: party.display,
      share: party.share,
    })),
  };
}

export function createLibrary(initial = []) {
  let parcels = [];
  let links = {};

  function resolve(key) {
    return resolveOwnerKey(key, links);
  }

  function setParcels(next) {
    parcels = dedupe(next);
  }

  function replace(records) {
    const prior = parcels.map((parcel) => ({ ...parcel }));
    const next = records.map((record, index) => {
      const parcel = normalizeRecord(record, index);
      const old = parcels.find((item) => item.parcelno === parcel.parcelno);
      if (old) {
        if (parcel.sale_price == null && old.sale_price != null) parcel.sale_price = old.sale_price;
        if (parcel.sale_year == null && old.sale_year != null) parcel.sale_year = old.sale_year;
        if (!parcel.shares && old.shares) parcel.shares = { ...old.shares };
      }
      return parcel;
    });
    const changes = prior.length ? ownershipChanges(prior, next) : { gained: [], lost: [] };
    setParcels(next);
    return { count: parcels.length, changes };
  }

  function update(parcelno, patch) {
    const parcel = parcels.find((item) => item.parcelno === parcelno);
    if (!parcel) return null;
    Object.assign(parcel, patch);
    return parcel;
  }

  if (initial.length && initial[0].parcelno && !initial[0].properties) setParcels(initial);
  else if (initial.length) replace(initial);

  function holdings() {
    const rows = [];
    for (const parcel of parcels) {
      for (const party of parties(parcel.owner_name, parcel.owner_2, parcel.shares)) {
        rows.push({
          owner_key: resolve(party.key),
          display_name: party.display,
          canonical: resolve(party.key) === party.key ? 1 : 0,
          public_owner: party.publicOwner ? 1 : 0,
          parcelno: parcel.parcelno,
          share: party.share,
          acres: parcel.acres,
          value: parcel.total_value,
        });
      }
    }
    return rows;
  }

  return {
    get parcels() {
      return parcels;
    },
    replace,
    update,
    resolve,
    setLinks(next) {
      links = next && typeof next === 'object' ? { ...next } : {};
    },
    ownerDetail(ownerKey) {
      const key = resolve(ownerKey);
      const owner = summarizeOwners(holdings(), parcels).find((item) => item.ownerKey === key);
      if (!owner) return null;
      const parcelList = parcels.filter((parcel) => parties(parcel.owner_name, parcel.owner_2, parcel.shares)
        .some((party) => resolve(party.key) === key)).map(viewParcel);
      const mailings = new Map();
      for (const parcel of parcelList) {
        if (!parcel.mailingLine) continue;
        mailings.set(parcel.mailingLine, (mailings.get(parcel.mailingLine) || 0) + 1);
      }
      const mailingLine = [...mailings.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0]?.[0] || '';
      const linked = [];
      for (const parcel of parcels) {
        for (const party of parties(parcel.owner_name, parcel.owner_2, parcel.shares)) {
          if (resolve(party.key) !== key || party.key === key) continue;
          const existing = linked.find((item) => item.key === party.key);
          if (!existing) linked.push({ key: party.key, name: party.display });
          else if (party.display.length > existing.name.length) existing.name = party.display;
        }
      }
      return {
        ...owner,
        mailingLine,
        assessedPerAcre: perAcre(owner.value, owner.acres),
        parcelList,
        linked,
      };
    },
    ownerReport({ privateOnly = false, limit = 40 } = {}) {
      const owners = summarizeOwners(holdings(), parcels)
        .filter((owner) => !privateOnly || !owner.publicOwner);
      const acres = parcels.reduce((sum, parcel) => sum + (Number(parcel.acres) || 0), 0);
      const value = parcels.reduce((sum, parcel) => sum + (Number(parcel.total_value) || 0), 0);
      return {
        parcels: parcels.length,
        acres,
        value,
        owners: owners.length,
        shown: owners.slice(0, limit),
      };
    },
    search(query) {
      const needle = String(query || '').trim().toLowerCase();
      if (!needle) return [];
      return parcels.filter((parcel) => [
        parcel.parcelno,
        parcel.owner_name,
        parcel.owner_2,
        parcel.mailing_city,
        parcel.loc_city,
        parcel.location,
        parcel.subdivision,
        parcel.mailing_address,
      ].some((value) => String(value || '').toLowerCase().includes(needle))).slice(0, 80);
    },
    comps(parcelno, limit = 6) {
      const subject = parcels.find((parcel) => parcel.parcelno === parcelno);
      if (!subject) return null;
      const others = parcels.filter((parcel) => parcel.parcelno !== parcelno);
      return {
        subject: viewParcel(subject),
        comps: rankComps(subject, others, limit).map((parcel) => ({
          ...viewParcel(parcel),
          comp: parcel.comp,
        })),
      };
    },
  };
}
