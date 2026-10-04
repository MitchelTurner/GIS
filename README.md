# Ketchikan parcel extract

A browser extension saves a borough parcel layer as GeoJSON. Railway hosts the page where people download that extension. The same pull is available as `extract-parcels.mjs` for a terminal or a scheduled job.

It is aimed at the Ketchikan Gateway Borough tax parcels. Any ArcGIS MapServer or FeatureServer layer of polygons, lines, or points will work. Node 18 or newer is enough to run the install page and the command-line pull. There are no packages to install.

## Browser extension

`npm start` serves the install page. On Railway that page is the public site. The download is `/extension.zip`.

After installing:

1. Open the [borough GIS viewer](https://www.kgbak.us/432/GIS-Viewer) and pan the map.
2. Click the Parcel Extract icon. It lists MapServer and FeatureServer addresses the page already requested.
3. Pick the parcel layer. Recommended fields are the ones filled on at least 90% of a sample, with object id and shape columns left off.
4. Download the GeoJSON. A map of the file opens in the extension, and a field report is a second download.

The long download runs in an extension tab so the browser does not cancel it. The extension asks permission for the map host you choose. Parcel data is written to the Downloads folder and is not sent to the install site.

Chrome and Edge: unzip, open `chrome://extensions` or `edge://extensions`, turn on Developer mode, and choose **Load unpacked** on the unzipped folder. Firefox can load `manifest.json` as a temporary add-on from `about:debugging`. Those steps are repeated on the install page and in `extension/INSTALL.txt`.

## Command line

`discover` lists the layers on a service, or the fields and feature count on one layer. `pull` downloads every feature, reprojects to WGS 84 (EPSG:4326), and writes GeoJSON plus a field-population report.

Paging uses object IDs rather than `resultOffset`. If the server rejects GeoJSON, the pull falls back to Esri JSON. A clockwise ring is an outer boundary, and a counter-clockwise ring is a hole on the previous outer ring.

### Finding the layer URL

You need a URL that ends in `/FeatureServer/<n>` or `/MapServer/<n>`.

- **The extension.** Open the GIS viewer, pan the map, and use the address it found.
- **Alaska Geoportal.** Open the "Ketchikan AK Tax Parcels" item and copy the REST URL of the underlying service.
- **Public Works.** Call (907) 228-6649 and ask for the map service endpoint. That is the sanctioned route; they publish these on request.

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

With no arguments, `node extract-parcels.mjs` reads the layer URL and flags from the environment:

| Variable | Maps to |
| --- | --- |
| `PARCEL_LAYER_URL` | layer or service URL (required) |
| `PARCEL_COMMAND` | `discover` or `pull` (default `pull`) |
| `PARCEL_OUT` | `--out` |
| `PARCEL_FIELDS` | `--fields` |
| `PARCEL_WHERE` | `--where` |
| `PARCEL_PRECISION` | `--precision` |
| `PARCEL_BATCH` | `--batch` |
| `PARCEL_TOKEN` | `--token` |

## Install page on Railway

`npm start` runs a small web server. Railway should keep that process up. `railway.json` sets the start command, a health check at `/health`, and a restart policy of `ON_FAILURE`.

The site has two jobs: explain how to load the extension, and serve `/extension.zip`. It does not call the map service and it does not store parcels.

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
