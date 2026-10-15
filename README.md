# Data Dictionary

A Cribl Stream app for **mapping and documenting the data flowing through your deployment** — every source → route → destination path in a worker group, enriched with the fields each path carries and human-authored metadata (owner, criticality, notes). It runs as an app inside a Cribl Stream instance and talks to the Cribl API to discover data paths and sample live events.

## Installation

Install directly from the Cribl Marketplace (Organization administrators only):

1. Log in to Cribl and click **Apps** in the top navigation.
2. Open the **Cribl Marketplace** catalog and find **Data Dictionary**.
3. Review the app's **Overview**, **Permissions**, and **External API Access**, then click **Install**.
4. Complete any pre-install checks Cribl prompts you with.

## What it does

Understanding what data moves through a Cribl deployment usually means clicking through Routes, Sources, Destinations, and QuickConnect one screen at a time and holding the whole picture in your head. Data Dictionary assembles that picture for you:

1. **Pick a worker group — or all of them** — choose a group and the app builds its full data dictionary: every path from a source, through the Routes table (or QuickConnect), to a destination. Choose **All worker groups** and it does the same for every group in the deployment, grouping the results by worker group so you can audit the whole thing in one pass. Groups load a few at a time and appear as they arrive; a group that can't be read is listed on its own rather than blocking the rest.
2. **Follow the paths** — routes are resolved against source `__inputId` constraints (exact match plus `startsWith` / `endsWith` / `includes` filter predicates) so each destination is tied to the sources that actually reach it. QuickConnect links that bypass the Routes table are surfaced too. A route with no `__inputId` constraint isn't tied to one source, so it's labelled by whatever identifies the data it carries — its description, its `index`/`sourcetype` qualifiers, its filter expression, or failing those its route name.
3. **Explore the fields** — for any path, the **Field Explorer** captures live events at a chosen stage (Before Routes, Before Post-Processing Pipeline, or Before Destination) and analyzes them: field names, observed types, fill rate, and a representative sample value. Cribl-internal `__*` fields are flagged.
4. **Annotate each path** — attach an **owner**, **criticality** (low / medium / high / critical), a data-source label, and free-form notes. Metadata persists in the Cribl KV store, so it's shared across everyone using the app.
5. **Group and scan** — view paths grouped by worker group, owner, criticality, or destination to quickly find unowned or business-critical flows. The owner / criticality / destination groupings roll up *across* worker groups, so "every critical path in the deployment" is one selection.
6. **See inside packs** — sources, destinations, and routes defined inside installed packs are surfaced too (badged with the pack name). When a pack hands events back to the worker group routing table, the full flow is stitched together: pack source → pack pipeline → routing table → group pipeline → destination.
7. **Light or dark** — the header toggle switches theme. It follows your OS setting until you pick one, then remembers your choice. (The app runs in an iframe, so it sees the OS preference rather than whatever theme the surrounding Cribl UI is set to — hence the manual override.)
8. **Export** — download the currently visible paths (respecting search and the Active/All filter) as **CSV**, **JSON**, or **Markdown** from the Export menu in the header.

### How discovery works

Data is loaded lazily per worker group to avoid the platform proxy's 30s request timeout — the app fetches sources, destinations, routes, and pipelines and stitches them into `DataPath`s in [src/dataPathBuilder.ts](src/dataPathBuilder.ts). Every path carries its worker group, so status, captures, grouping, and export all resolve against the group the path actually lives in (source and destination ids are only unique *within* a group). Fetches are bounded by [src/concurrency.ts](src/concurrency.ts) — a few groups at a time, a few packs within each — because a wider burst makes the Leader report that the config helper can't be booted under load. Field sampling uses Cribl's capture API at a selectable `level`; results are summarized by [src/fieldAnalysis.ts](src/fieldAnalysis.ts). Path metadata is stored in the `data-dictionary/metadata` KV collection ([src/metadata.ts](src/metadata.ts)), keyed by `group::source::route::destination` so annotations stay attached even as the UI regroups, and can't be confused between two groups that name their entities the same way. Annotations written under the older `source::route::destination` key are still read.

## Project structure

- [src/App.tsx](src/App.tsx) — top-level flow: select scope (one group or all) → view data paths → explore fields → annotate
- [src/api.ts](src/api.ts) — all Cribl API calls (groups, sources, destinations, routes, pipelines, status, event capture) with a 25s timeout guard
- [src/concurrency.ts](src/concurrency.ts) — bounded, settle-don't-reject fan-out used for the all-groups scope and the per-group pack loads
- [src/dataPathBuilder.ts](src/dataPathBuilder.ts) — resolves routes against source `__inputId` constraints and builds the group data dictionary (including QuickConnect paths, pack scopes, and pack → routing-table stitching)
- [src/export.ts](src/export.ts) — serializes the visible data paths to CSV / JSON / Markdown and triggers the browser download
- [src/fieldAnalysis.ts](src/fieldAnalysis.ts) — summarizes captured events into per-field type / fill-rate / sample stats
- [src/metadata.ts](src/metadata.ts) — path identity and load/save of path metadata in the Cribl KV store, keyed by `group::source::route::destination`
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

| Version | Changes |
| --- | --- |
| 1.2.0 | Added a **light/dark theme toggle** (follows the OS until you choose; every colour now resolves through a theme token in `src/App.css`). Added an **All worker groups** scope (groups load progressively, partial failures listed per group) with a Worker Group grouping mode and a Worker Group export column. Routes with no `__inputId` constraint are now labelled by their filter expression or route name instead of reading as "any source". Path metadata keys are group-scoped; older keys are still read. |
| 1.1.2 | Install via the Cribl Marketplace (replaces Import from Git); lowercased package name and repository URL. |
| 1.1.0 | Added pack support (sources/destinations/routes inside packs, including pack → worker group routing table stitching) and data dictionary export (CSV, JSON, Markdown). |

## License

Licensed under the [Apache License 2.0](LICENSE).
