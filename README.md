# Ketchikan parcel extract

`extract-parcels.mjs` pulls a parcel layer from an ArcGIS REST service and writes a trimmed GeoJSON file you can use offline. It has no dependencies and needs Node 18 or newer (it uses the built-in `fetch`).

The script is aimed at the Ketchikan Gateway Borough tax parcel layer, but any MapServer or FeatureServer layer that returns polygons or points will work.

## What it does

1. **`discover`** lists the layers on a service, or the fields, geometry type, object-id field, and feature count on a single layer.
2. **`pull`** downloads every feature, reprojects coordinates to WGS 84 (EPSG:4326), and writes GeoJSON.

Paging uses object IDs rather than `resultOffset`, which is missing or unreliable on older ArcGIS Server installs. If the server rejects `f=geojson`, the script falls back to Esri JSON and converts rings itself: a clockwise ring is an outer boundary, and a counter-clockwise ring is a hole on the previous outer ring.

After the pull it also writes a field-population report (`parcels.fields.json` by default). That report shows what share of features actually have a value in each attribute, so you can see which owner, address, and APN columns are safe to build a UI on.

## Finding the layer URL

You need a URL that ends in `/FeatureServer/<n>` or `/MapServer/<n>`.

- **Alaska Geoportal.** Open the "Ketchikan AK Tax Parcels" item, follow it to the underlying service, and copy the REST URL.
- **Borough viewer.** Open the GIS viewer, watch DevTools → Network for `rest/services`, pan the map, and copy the parcel layer request URL.
- **Public Works.** Call (907) 228-6649 and ask for the map service endpoint. That is the sanctioned route; they publish these on request.

Once you have a service root, run `discover` to list its layers and fields.

## Usage

```bash
# List layers under a service root
node extract-parcels.mjs discover https://host/arcgis/rest/services/Parcels/MapServer

# Inspect one layer's fields before committing to a pull
node extract-parcels.mjs discover https://host/.../MapServer/0

# Pull everything
node extract-parcels.mjs pull https://host/.../MapServer/0 --out parcels.geojson

# Pull only the fields you want
node extract-parcels.mjs pull <url> --fields APN,OWNER_NAME,MAIL_ADDR,ZONING
```

### Flags

| Flag | Default | Meaning |
| --- | --- | --- |
| `--out <path>` | `parcels.geojson` | Output GeoJSON path. The field report is written beside it as `<name>.fields.json`. |
| `--fields a,b,c` | all fields | Attribute allowlist. |
| `--where "<sql>"` | `1=1` | Server-side filter. |
| `--precision <n>` | `6` | Coordinate decimal places. Six places is about 11 cm. |
| `--batch <n>` | server `maxRecordCount` (capped at 1000) | Features per request. |
| `--token <t>` | none | Token appended when the service requires one. |

Features with no geometry are skipped. Consecutive duplicate vertices created by rounding are removed, but a ring is never collapsed below the four positions GeoJSON requires.

## Output

`parcels.geojson` is a standard `FeatureCollection`. Load it in QGIS, [geojson.io](https://geojson.io), or any library that reads GeoJSON.

`parcels.fields.json` looks like this:

```json
[
  { "field": "APN", "filled": 8421, "pct": 100 },
  { "field": "OWNER_NAME", "filled": 8012, "pct": 95.1 }
]
```

A field under about 90% filled is not reliable enough to hang a sidebar on.

## Ideas

The extractor is the data step. The comments in the script already assume a map with a sidebar. These are the directions that follow directly from what the script produces.

### Parcel lookup map

A static page that loads the GeoJSON, draws parcel outlines, and shows the clicked feature's APN, owner, mailing address, and zoning. MapLibre GL or Leaflet can do this with no server. The field report tells you which columns to put in that panel and which to leave out.

### Search by APN, owner, or address

A single box that matches those three fields and zooms to the parcel. Owner and address search should be case-insensitive and tolerate partial strings (`"front street"`, `"smith"`). APN search should ignore dashes and spaces, because assessor numbers are typed both ways.

### Public view and staff view

Owner name and mailing address are useful inside the borough and a poor thing to publish. Keep two outputs from the same pull:

- a public file with APN, zoning, lot size, and geometry
- a local file that still has owner and mailing fields, and is never committed or hosted

`--fields` already supports this. A small wrapper that runs `pull` twice with two allowlists would make the split automatic.

### See what changed since the last pull

Borough data moves. Save each pull with a date in the filename and diff features by APN (or by the object-id field if APN is incomplete). Report three lists: new parcels, removed parcels, and parcels whose owner or geometry changed. That is more useful than re-reading a fresh GeoJSON by eye.

### Make the file small enough for a browser

A full parcel layer with six-decimal coordinates can be tens of megabytes. Before putting it on a map:

- drop every attribute the sidebar does not show
- simplify boundaries (Mapshaper or a similar tool) for the overview zoom, and keep the full geometry for the parcel you click
- or build vector tiles so the browser only fetches the parcels in view

`--precision` and `--fields` are the first cut. Tiling is the one that matters once the file is large.

### Check the data before you trust it

The field report covers empty attributes. A second pass could flag:

- duplicate APNs
- features whose geometry was dropped
- rings that are not closed, or polygons with a hole and no outer ring (the converter already keeps those, but they are worth listing)
- parcels whose area is implausibly small after rounding

Print that as a short text report next to the GeoJSON. Fixing the source data is the borough's job; knowing which records are bad is yours.

### Pull the layers that sit on top of parcels

The same `discover` / `pull` commands work for zoning, floodplain, wetlands, and rights-of-way if those layers are on an ArcGIS service. Store each as its own GeoJSON and draw them as toggles. A click can then answer "what zone, and is it in the floodplain?" without a second tool.

### One parcel, one file

From the lookup map, offer "download this parcel" as a single-feature GeoJSON (or a zipped shapefile). That is the handoff someone wants for a permit, a survey, or an email. Generating it in the browser from the feature you already loaded needs no backend.

### A field glossary

ArcGIS names (`MAIL_ADDR`, `OWNERNME1`) are not labels. A small JSON map from field name to a plain label, filled in once after the first `discover`, keeps the sidebar readable and survives a re-pull when the column list changes.

### Keep the extractor boring

Leave `extract-parcels.mjs` as a zero-dependency script. Put the map, the search index, and the diff in separate files so a re-pull never depends on a bundler. The script's job is to get a trustworthy GeoJSON onto disk; everything above is a reader of that file.
