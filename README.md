# Ketchikan parcel extract

A browser extension saves a borough parcel layer as GeoJSON. The public site reads that file and shows who owns what share of the land, then ranks similar parcels. The same pull is available as `extract-parcels.mjs` for a terminal or a scheduled job.

It is aimed at the Ketchikan Gateway Borough tax parcels. Any ArcGIS MapServer or FeatureServer layer of polygons, lines, or points will work. Node 18 or newer is enough to run the install page and the command-line pull. There are no packages to install.

## Browser extension

`npm start` serves the install page. On Railway that page is the public site. The download is `/extension.zip`.

After installing:

1. Open the [borough GIS viewer](https://www.kgbak.us/432/GIS-Viewer) and pan the map.
2. Click the Parcel Extract icon and choose **Owners and mailing**. The files save in your Downloads folder: a `.contacts.csv` spreadsheet and a `.geojson` map. World Imagery is only the basemap. The page is not asking you to open a file you already have.

Open the public site and drop that GeoJSON on the page. The browser saves the parcels, shows each owner's share of the land, and keeps every search for the next visit. Use **Open a file you already saved** in the extension when you want the map without the ownership page.

The long download runs in an extension tab so the browser does not cancel it. The extension asks permission for the map host you choose. Parcel data is written to the Downloads folder and is not sent to the install site.

Chrome and Edge: unzip, open `chrome://extensions` or `edge://extensions`, turn on Developer mode, and choose **Load unpacked** on the unzipped folder. Firefox can load `manifest.json` as a temporary add-on from `about:debugging`. Those steps are repeated on the install page and in `extension/INSTALL.txt`.

## Owners and mailing addresses

Lot outlines (`KetchikanAK_LotPolys`) repeat `LotNum` because that layer has no owner. The tax parcels are a different layer, about 8,400 polygons, and each one has the owner and the mailing address:

`https://services2.arcgis.com/65jtiGuzdaRB5FxF/arcgis/rest/services/Parcel_Ketchikan/FeatureServer/0`

In the extension, that layer is preselected to owner, town, mailing address, acres, assessed value, and zoning. From the terminal:

```bash
node extract-parcels.mjs pull \
  https://services2.arcgis.com/65jtiGuzdaRB5FxF/arcgis/rest/services/Parcel_Ketchikan/FeatureServer/0 \
  --contact --out owners.geojson
```

`owners.contacts.csv` is the spreadsheet. `CITY` is the mailing town. `Location` is the property. Drop either file on the public site. The browser keeps the copy it needs for the next search.

## Parcel studio

After a download, drop the GeoJSON on the public site. The map draws every parcel right away and colors the largest owners. A dot in the owner list matches those shapes. Click a shape, or an owner, and the map zooms there. The page saves the file in that browser and, on the next visit, starts from those same parcels. It lists who owns what share of the acres. “SMITH JOHN” and “Smith, John A” count as one owner. A parcel shows the mailing address, the ownership split, and comps ranked by size, value, zoning, subdivision, and distance. Type a sale price when you have one: comps use that price when both parcels have it, and the assessed value stays labeled. Two names start at an even split. Type 60 and 40 when the deed says so. Replacing the file lists who gained parcels and who lost them. The contacts spreadsheet has the owners and no outlines, so the map stays empty until the GeoJSON is the file on the page. **Compare with AI** writes the comparison when the server has `AI_API_KEY`. The ranked comps still work without a key.

The same work can run on this computer with Node 22 or newer:

```bash
node analyze.mjs import owners.geojson
node analyze.mjs owners
node analyze.mjs search "ward cove"
node analyze.mjs comps PARCELNO
node analyze.mjs serve
```

`serve` opens http://127.0.0.1:3210. A GeoJSON import is the useful one. Acres come from `Land_Acres` when that column is present, and from the polygon when it is not. A contacts CSV can be imported too, but it has no map shape.

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
| `--contact` | off | Owner, town, and mailing fields, and a `.contacts.csv` spreadsheet. |
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
| `PARCEL_CONTACT` | `--contact` when set to `1` |
| `PARCEL_WHERE` | `--where` |
| `PARCEL_PRECISION` | `--precision` |
| `PARCEL_BATCH` | `--batch` |
| `PARCEL_TOKEN` | `--token` |

## Install page on Railway

`npm start` runs a small web server. Railway should keep that process up. `railway.json` sets the start command, a health check at `/health`, and a restart policy of `ON_FAILURE`.

The site serves `/extension.zip` and reads a GeoJSON or CSV you drop on the page. The saved parcels stay in that browser. Set `AI_API_KEY` on the server when you want the written comparison.

## Output

`parcels.geojson` is a standard `FeatureCollection`. Open it on the install page, in the extension, in QGIS, or in any library that reads GeoJSON.

`parcels.fields.json` looks like this:

```json
[
  { "field": "APN", "filled": 8421, "pct": 100 },
  { "field": "OWNER_NAME", "filled": 8012, "pct": 95.1 }
]
```

A field under about 90% filled is not reliable enough to hang a sidebar on.

## Ideas

The public page already does the comparisons that the borough layer leaves out:

- The map colors the largest owners, and the same color sits beside the name in the list.
- A sale price typed on a parcel is kept with that parcel. Comps use it when both parcels have one.
- A typed share, such as 60 and 40, replaces the even split for that deed.
- “SMITH JOHN” and “Smith, John A” are the same owner, so the acres stay on one row.
- The next file lists who gained parcels and who lost them.
- Government owners can be set aside when the question is private land. The studio checkbox does that.
- Leave `data/parcels.sqlite` on this computer. The public page keeps its copy in the browser.

## Ideas for later tools

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
