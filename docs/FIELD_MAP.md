# Field map

What the extension's **Owners and mailing** export contains, and where each property lands on the server (`prisma/schema.prisma`, built by `lib/canonical.js`).

Source layer: Ketchikan Gateway Borough `Parcel_Ketchikan/FeatureServer/0` (named `Parcel_Sept25`, 8,445 features, 121 fields). The extension picks fields with `contactField` and orders them with `CONTACT_ORDER` in `extension/lib/arcgis.js`, keeping the layer's own property names. The import reads names case-insensitively.

Samples come from the live layer. Owner and mailing values for private owners are left as placeholders on purpose: this file is committed, and real exports are not.

## Exported properties

| Property | Sample | Canonical field | Notes |
| --- | --- | --- | --- |
| `PARCELNO` | `011224000200CMN1` | `parcelNo`; fallback for `parcelId` | Shared by every unit of a condo or mobile-home park. See "Parcel id" below. |
| `Parcel_Num` | `0112240002000039` | `parcelId` | Unique per unit. Blank on 104 rows. Equal to `PARCELNO` on 7,504 of the 8,341 rows that have both. |
| `Owner_Name` | `" CITY OF KETCHIKAN "` | `ownerName`, `ownerKey`, `ownerSignature` | Padded with spaces; trimmed on import. Private sample: `<owner name>`. |
| `Owner_2` | `<second owner or blank>` | `ownerName2` | |
| `Address` | `334 FRONT ST` | `mailingAddress` | Mailing street. 2,377 rows are PO boxes. |
| `CITY` | `KETCHIKAN` | `mailingCity` | |
| `STATE` | `AK` | `mailingState` | 50 distinct values, including `BC`, `PR`, `VI`, and blank. |
| `ZIP` | `99901` | `mailingZip` | Kept as text. |
| `Address_full` | `334 FRONT ST, KETCHIKAN, AK 99901` | — (kept in `raw`) | The browser uses it for the one-line mailing label. |
| `Location` | `DENALI AVE 3250 CONDO 39` | `situsAddress` | Street name first, then the number. |
| `LOC_CITY` | `KETCHIKAN` | `situsCity` | Values seen: blank, `KETCHIKAN`, `KETCHIKAN, AK`. |
| `SUBNAME` | `SITE PLAN` | `subdivision` | |
| `Land_Acres` | `0` | `landAcres` | `0` on condo units. |
| `Land_Sq_Ft` | `0` | `landSqFt` | `0` on condo units. |
| `Total_Appr` | `111100` | `appraisedCents` | Dollars in the export; cents on the server. |
| `Total_Asse` | `0` | `taxableCents` | The taxable amount after exemptions. |
| `Total_Exem` | `111100` | `exemptCents` | |
| `Exempt_1` | `CTKET` | `exemptCodes[]` | Codes are stored as written. `NONE` is dropped. |
| `Exempt_2` | `NONE` | `exemptCodes[]` | |
| `Exempt_3` | `NONE` | `exemptCodes[]` | |
| `Apr_Land_V` | `0` | `landValueCents` | Appraised land. |
| `Asd_Land_V` | `0` | — (kept in `raw`) | Assessed land. |
| `Apr_Imps` | `111100` | `improvementValueCents` | Appraised improvements. |
| `Asd_Imp_Va` | `0` | — (kept in `raw`) | Assessed improvements. |
| `Water_Fron` | `12` | `waterfrontCode` | Integer, about 502 distinct values. Not a reliable length in feet. The page shows "Yes" when above 0. |
| `D_Ref_Date` | `14-JUN-16` | `deedRefDate` | Text with a two-digit year, stored as written. |
| `Zoning_Typ` | `RH` | `zoning` | Codes are stored as written. |
| `Year_Built` | `1974` | `yearBuilt` | `0` becomes null. |
| `PropUse` | `CONDO` | `propUse` | Codes are stored as written. |
| `Asse_Year1` … `Asse_Year5` | `2026`, `2025`, `2024`, `2023`, `2022` | `valueHistory[].year` | |
| `Total_Apr1` … `Total_Apr5` | `111100`, `107500`, `102300`, `94900`, `92700` | `valueHistory[].appraisedCents` | Paired with the `Asse_Year` of the same number. Zero rows are dropped. |

The extension also saves a `.contacts.csv` with the same columns and no outlines.

## Computed on import

| Canonical field | From |
| --- | --- |
| `parcelId` | `Parcel_Num`, else `PARCELNO` (rules below) |
| `ownerKey` | `ownerKey()` in `lib/ownership.js` on the first party of `Owner_Name` + `Owner_2`. This is the same grouping that **Largest owners** uses. |
| `ownerSignature` | Every party key, sorted. A change here is an owner change. Padding and punctuation alone are not. |
| `areaSqFt` | The outline's area via `@turf/area`, in square feet |
| `centroidLat`, `centroidLng` | The average of the outer-ring vertices (`geometryCentroid` in `lib/ownership.js`) |
| `raw` | Every exported property, unchanged |
| `ownerChangedAt`, `previousOwnerName` | Set when a later import has a different `ownerSignature` |
| `missingSince` | Set when a later import leaves the parcel out. Cleared when it comes back. Rows are never deleted. |

## Parcel id

`PARCELNO` repeats across units. The largest groups have 128, 125, and 100 rows. Before this change, the browser keyed on `PARCELNO` and kept one row per group, so about 900 condo and mobile-home units collapsed into their building. `Parcel_Num` gives 8,335 distinct values.

Rules, in `lib/parcel-ids.js` (used by both the browser and the server):

1. Use the trimmed `Parcel_Num`. If it is blank, use the trimmed `PARCELNO`.
2. A value with no digit is a placeholder. The layer has `<NA>` (72 rows), `STATE DOT` (3), and `AKDOT` (2). It gets `~` plus an 8-character hash of the outline, for example `<NA>~1a2b3c4d`.
3. A row that repeats an earlier row exactly (same properties and outline) is dropped. The layer has a few of these, for example `307490034000` three times.
4. A different row under a number already used gets `~` plus the outline hash. The first row in file order keeps the bare number.

## Missing in export

These canonical fields have no source in today's export. They stay null on the server and show as unknown on the page:

- **Sale price and sale date.** Alaska does not disclose sale prices. Prices come only from comps you enter.
- **Units** (`No_Units`), **living area** (`Total_Area`), **bedrooms** and **bathrooms** (`Bedrooms`, `Bathrooms`). These are in the layer but not in the export.
- **Assessor area** (`Region`; values include `CITY`, `NORTH`, `SOUTH`, `PENNOCK`, `GRAVINA`), **property type** (`Prop_Type`), **legal description** (`Legal_Desc`), **deed reference** (`Deed_Ref`), **situs ZIP and state** (`LOC_ZIP`, `LOC_STATE`), and **owner name parts** (`NLAST`, `NFIRST`, `NMID`). These are in the layer but not in the export.
- **Usable square feet.** No slope, wetland, or setback data is in the layer.

Adding layer fields to `CONTACT_ORDER` would fill some of these on the next export.

## Observations

- **Owner name order.** `NFIRST` and `NLAST` are filled on only a few rows. On those rows, `Owner_Name` reads first-name-first 41 times and last-name-first 6 times. This is not confirmed for the whole layer. `ownerKey()` sorts name tokens, so either order groups together.
- **Owners.** 43 owner names contain a comma, and 21 contain `ESTATE` or `HEIRS`.
- **Blank mailing state.** One blank-`STATE` row has ZIP `96326`.
- **`PropUse` counts.** RES SFR 2648, VACANT 1334, REMOTE VACANT 954, RES 2-3 854, CONDO 545, COMM 438, COMM VACANT 400, REMOTE IMP 305, MBHM 175, COMM INDUST 154, COMM CONDO 133, blank 105, RES MFG 85, RES 4+ 84, RES TOWN 69, PUBLIC 60, RES AUX 51, ATS 20, REMOTE COMM 11, RES CABIN 8, COMM RES 7, OTHER 5.
- **`Zoning_Typ` counts.** RL 2612, RM 2240, CG 830, FD 660, RH 334, RS 281, IH 272, CC 268, NO DATA 264, RR 235, IL 149, blank 105, PLI 99, RN 41, HD 30, PUD 13, AD 10, `0` 2.
