# XSD Explorer

Read-only Next.js app for browsing and navigating the XSD files in this repository.

## Features

- Alphabetical object catalog that abstracts file boundaries
- Search across types, docs, fields, and enumerations
- Explorer and tree views for each object
- Tree breadcrumbs for fast path awareness while drilling into sub-fields
- Definition panel with elements, attributes, type links, restrictions/enums, and reverse "used by" links
- Warning model that keeps browsing non-blocking for unresolved references/imports

## Local development

```bash
cd xsd-explorer
npm install
npm run build:data
npm run dev
```

Open `http://localhost:3000`.

## Build static output

```bash
cd xsd-explorer
npm run build
```

The build pipeline runs the Python indexer first and then builds static Next output.

## Data index generation

The app reads `/public/data/xsd-index.json`.

Generate it manually:

```bash
python3 scripts/build_xsd_index.py --input .. --output public/data/xsd-index.json
```

## Notes

- Current corpus: 15 schemas / 243 components.
- Missing imports are surfaced as warnings (for example missing `Itf_MITS_CoreData2.0.xsd`).
- This version is intentionally read-only and local-first.
