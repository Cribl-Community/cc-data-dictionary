# Data Dictionary

A Cribl app for **mapping and documenting the data flowing through your deployment** — every source → route → destination path in a Stream worker group or Edge fleet, enriched with the fields each path carries and human-authored metadata (owner, criticality, notes). Point it at one group, or at every group and fleet at once. It runs as an app inside Cribl and talks to the Cribl API to discover data paths and sample live events.

## Installation

Install directly from the Cribl Marketplace (Organization administrators only):

1. Log in to Cribl and click **Apps** in the top navigation.
2. Open the **Cribl Marketplace** catalog and find **Data Dictionary**.
3. Review the app's **Overview**, **Permissions**, and **External API Access**, then click **Install**.
4. Complete any pre-install checks Cribl prompts you with.

## What it does

Understanding what data moves through a Cribl deployment usually means clicking through Routes, Sources, Destinations, and QuickConnect one screen at a time and holding the whole picture in your head. Data Dictionary assembles that picture for you:

1. **Pick a worker group or Edge fleet — or all of them** — choose one and the app builds its full data dictionary: every path from a source, through the Routes table (or QuickConnect), to a destination. Choose **All worker groups & fleets** and it does the same for the whole deployment, grouping results by group so you can audit it in one pass. Groups load a few at a time and appear as they arrive; one that can't be read is listed on its own rather than blocking the rest.

   Stream worker groups and Edge fleets both use the same source → route → destination model, so both are discovered the same way; fleets are labelled **Edge** in the selector, the section headers, and the export. Search, Lake and Outpost groups are filtered out — they have no Routes table to walk. (Edge fleet inheritance needs no special handling: a parent fleet's config is propagated into its subfleets at commit time, so reading a subfleet already returns what it inherited.)
2. **Follow the paths** — routes are resolved against source `__inputId` constraints (exact match plus `startsWith` / `endsWith` / `includes` filter predicates) so each destination is tied to the sources that actually reach it. QuickConnect links that bypass the Routes table are surfaced too. A route with no `__inputId` constraint isn't tied to one source, so it's labelled by whatever identifies the data it carries — its description, its `index`/`sourcetype` qualifiers, its filter expression, or failing those its route name.
3. **Explore the fields** — for any path, the **Field Explorer** captures live events at a chosen stage (Before Routes, Before Post-Processing Pipeline, or Before Destination) and analyzes them: field names, observed types, fill rate, and a representative sample value. Cribl-internal `__*` fields are flagged.
4. **Annotate each path** — attach an **owner**, **criticality** (low / medium / high / critical), a data-source label, and free-form notes. Metadata persists in the Cribl KV store, so it's shared across everyone using the app.
5. **Group and scan** — view paths grouped by worker group / fleet, owner, criticality, or destination to quickly find unowned or business-critical flows. The owner / criticality / destination groupings roll up *across* groups, so "every critical path in the deployment" is one selection.
6. **See inside packs** — sources, destinations, and routes defined inside installed packs are surfaced too (badged with the pack name). When a pack hands events back to the worker group routing table, the full flow is stitched together: pack source → pack pipeline → routing table → group pipeline → destination.
7. **Light or dark** — dark by default; the header toggle switches and remembers your choice. (The OS preference is deliberately ignored: the app runs in an iframe, so it sees your OS setting rather than the theme of the surrounding Cribl UI.)
8. **Export** — download the currently visible paths (respecting search and the Active/All filter) as **CSV**, **JSON**, or **Markdown** from the Export menu in the header.

### How discovery works

Data is loaded lazily per group to avoid the platform proxy's 30s request timeout — the app fetches sources, destinations, routes, and pipelines and stitches them into `DataPath`s in [src/dataPathBuilder.ts](src/dataPathBuilder.ts). Every path carries its group (and whether that group is Stream or Edge), so status, captures, grouping, and export all resolve against the group the path actually lives in — source and destination ids are only unique *within* a group, so a shared map would mis-attribute them. Fetches are bounded by [src/concurrency.ts](src/concurrency.ts) — a few groups at a time, a few packs within each — because a wider burst makes the Leader report that the config helper can't be booted under load. Field sampling uses Cribl's capture API at a selectable `level`; results are summarized by [src/fieldAnalysis.ts](src/fieldAnalysis.ts). Path metadata is stored in the `data-dictionary/metadata` KV collection ([src/metadata.ts](src/metadata.ts)), keyed by `group::source::route::destination` so annotations stay attached even as the UI regroups, and can't be confused between two groups that name their entities the same way. Annotations written under the older `source::route::destination` key are still read. The KV store holds each value as an opaque string, so the store is written as `text/plain` and parsed back by hand — sending it as `application/json` lets the server coerce the body to `"[object Object]"`, which reads back as unparseable.

## Project structure

- [src/App.tsx](src/App.tsx) — top-level flow: select scope (one group or all) → view data paths → explore fields → annotate; also the theme state and the intro panel
- [src/App.css](src/App.css) — all styling, built on the light/dark theme tokens declared at the top of the file (`:root` and `[data-theme='dark']`); no colour is hardcoded below them
- [src/api.ts](src/api.ts) — all Cribl API calls (groups, sources, destinations, routes, pipelines, status, event capture) with a 25s timeout guard; also classifies `/master/groups` into Stream groups and Edge fleets and drops the group types with no Routes table
- [src/concurrency.ts](src/concurrency.ts) — bounded, settle-don't-reject fan-out used for the all-groups scope and the per-group pack loads
- [src/dataPathBuilder.ts](src/dataPathBuilder.ts) — resolves routes against source `__inputId` constraints and builds the group data dictionary (including QuickConnect paths, pack scopes, and pack → routing-table stitching)
- [src/export.ts](src/export.ts) — serializes the visible data paths to CSV / JSON / Markdown and triggers the browser download
- [src/fieldAnalysis.ts](src/fieldAnalysis.ts) — summarizes captured events into per-field type / fill-rate / sample stats
- [src/metadata.ts](src/metadata.ts) — path identity and load/save of path metadata in the Cribl KV store, keyed by `group::source::route::destination`
- [src/types.ts](src/types.ts) — WorkerGroup / GroupType / Source / Destination / Route / Pipeline / DataPath type definitions

## Development

Clone this repo, install dependencies, and start the dev server:

```bash
npm install
npm run dev
```

Then log in to Cribl Cloud and go to **App Platform → Development → Live Preview**, which loads the running dev server into the Cribl UI. The app needs that parent frame: `CRIBL_API_URL` and request auth are injected by the platform, so opening the dev server URL directly won't reach the Cribl API.

Before committing, check both:

```bash
npm run lint && npm run build
```

To cut a release archive (this bumps the version in `package.json` — see [AGENTS.md](AGENTS.md) for the flags):

```bash
npm run package -- --minor
```

## Release Versions

| Version | Changes |
| --- | --- |
| 1.2.1 | Fixed path metadata (owner, criticality, data-source label, notes) not surviving an app reload — annotations were saved to the KV store as a coerced `"[object Object]"` string and silently read back as an empty store. Values are now written as `text/plain` and parsed on load (double-encoded values are tolerated), and load failures are logged instead of swallowed. |
| 1.2.0 | **Edge fleets** are now identified as such in the selector, section headers, path badges, and a new `Group Type` export column; Search / Lake / Outpost groups are filtered out of the selector. Added a **light/dark theme toggle**, dark by default (every colour now resolves through a theme token in `src/App.css`). Added an **All worker groups & fleets** scope (groups load progressively, partial failures listed per group) with a Worker Group grouping mode and a Worker Group export column. Routes with no `__inputId` constraint are now labelled by their filter expression or route name instead of reading as "any source". Path metadata keys are group-scoped; older keys are still read. |
| 1.1.2 | Install via the Cribl Marketplace (replaces Import from Git); lowercased package name and repository URL. |
| 1.1.0 | Added pack support (sources/destinations/routes inside packs, including pack → worker group routing table stitching) and data dictionary export (CSV, JSON, Markdown). |

## License

Licensed under the [Apache License 2.0](LICENSE).
