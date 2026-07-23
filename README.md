# Data Dictionary

A Cribl Stream app for **mapping and documenting the data flowing through your deployment** — every source → route → destination path in a worker group, enriched with the fields each path carries and human-authored metadata (owner, criticality, notes). It runs as an app inside a Cribl Stream instance and talks to the Cribl API to discover data paths and sample live events.

## Installation

1. Log in to Cribl and then click on **Apps->View All**
2. Click **Add App->Import from Git**.
3. Paste the repo url and "latest" for the release tag.
4. Click **Import**.

## What it does

Understanding what data moves through a Cribl deployment usually means clicking through Routes, Sources, Destinations, and QuickConnect one screen at a time and holding the whole picture in your head. Data Dictionary assembles that picture for you:

1. **Pick a worker group** — choose a group and the app builds its full data dictionary: every path from a source, through the Routes table (or QuickConnect), to a destination.
2. **Follow the paths** — routes are resolved against source `__inputId` constraints (exact match plus `startsWith` / `endsWith` / `includes` filter predicates) so each destination is tied to the sources that actually reach it. QuickConnect links that bypass the Routes table are surfaced too.
3. **Explore the fields** — for any path, the **Field Explorer** captures live events at a chosen stage (Before Routes, Before Post-Processing Pipeline, or Before Destination) and analyzes them: field names, observed types, fill rate, and a representative sample value. Cribl-internal `__*` fields are flagged.
4. **Annotate each path** — attach an **owner**, **criticality** (low / medium / high / critical), a data-source label, and free-form notes. Metadata persists in the Cribl KV store, so it's shared across everyone using the app.
5. **Group and scan** — view paths grouped by owner, criticality, or destination to quickly find unowned or business-critical flows.
6. **See inside packs** — sources, destinations, and routes defined inside installed packs are surfaced too (badged with the pack name). When a pack hands events back to the worker group routing table, the full flow is stitched together: pack source → pack pipeline → routing table → group pipeline → destination.
7. **Export** — download the currently visible paths (respecting search and the Active/All filter) as **CSV**, **JSON**, or **Markdown** from the Export menu in the header.

### How discovery works

Data is loaded lazily per worker group to avoid the platform proxy's 30s request timeout — the app fetches sources, destinations, routes, and pipelines and stitches them into `DataPath`s in [src/dataPathBuilder.ts](src/dataPathBuilder.ts). Field sampling uses Cribl's capture API at a selectable `level`; results are summarized by [src/fieldAnalysis.ts](src/fieldAnalysis.ts). Path metadata is stored in the `data-dictionary/metadata` KV collection ([src/metadata.ts](src/metadata.ts)), keyed by `source::route::destination` so annotations stay attached even as the UI regroups.

## Project structure

- [src/App.tsx](src/App.tsx) — top-level flow: select group → view data paths → explore fields → annotate
- [src/api.ts](src/api.ts) — all Cribl API calls (groups, sources, destinations, routes, pipelines, status, event capture) with a 25s timeout guard
- [src/dataPathBuilder.ts](src/dataPathBuilder.ts) — resolves routes against source `__inputId` constraints and builds the group data dictionary (including QuickConnect paths, pack scopes, and pack → routing-table stitching)
- [src/export.ts](src/export.ts) — serializes the visible data paths to CSV / JSON / Markdown and triggers the browser download
- [src/fieldAnalysis.ts](src/fieldAnalysis.ts) — summarizes captured events into per-field type / fill-rate / sample stats
- [src/metadata.ts](src/metadata.ts) — load/save path metadata in the Cribl KV store, keyed by `source::route::destination`
- [src/types.ts](src/types.ts) — WorkerGroup / Source / Destination / Route / Pipeline / DataPath type definitions

## Development

Clone this repo. Install dependencies and start the app.
```bash
npm install
npm run dev
```

Log into Cribl Cloud, 
Go to App Platform > Development > Live Preview

## Release Versions

Version is tracked in [package.json](package.json) (`version`). Bump it before packaging so each release is a distinct artifact. Follow semantic versioning:

- **Patch** (`1.1.0` → `1.1.1`) — bug fixes, no new capabilities.
- **Minor** (`1.1.0` → `1.2.0`) — new, backward-compatible features.
- **Major** (`1.1.0` → `2.0.0`) — breaking changes.

To cut a release: update `version` in `package.json`, add a note below, then run `npm run package` to produce `build/CC-data-dictionary-<version>.tgz`.

| Version | Changes |
| --- | --- |
| 1.1.0 | Added pack support (sources/destinations/routes inside packs, including pack → worker group routing table stitching) and data dictionary export (CSV, JSON, Markdown). |

## License

Licensed under the [Apache License 2.0](LICENSE).
