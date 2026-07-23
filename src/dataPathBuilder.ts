import type { Source, Destination, RouteEntry, Pipeline, DataPath, GroupDataDictionary, WorkerGroup, Coverage, GroupStatus } from './types';
import {
  fetchGroups, fetchSources, fetchDestinations, fetchRoutes, fetchPipelines, fetchGroupStatus,
  fetchPacks, fetchPackSources, fetchPackDestinations, fetchPackRoutes, fetchPackPipelines,
} from './api';

// How a route constrains the source __inputId. `eq` is exact match; the others
// mirror the JS string methods Cribl filters commonly use.
type InputOp = 'eq' | 'startsWith' | 'endsWith' | 'includes';
interface InputConstraint {
  op: InputOp;
  value: string;
}

function getRouteInputConstraint(route: RouteEntry): InputConstraint | null {
  // The `input` field is always an exact match.
  if (route.input) return { op: 'eq', value: route.input };

  if (!route.filter) return null;

  // Equality: __inputId == 'x' / === 'x'
  const eq = route.filter.match(/__inputId\s*={2,3}\s*['"]([^'"]+)['"]/);
  if (eq) return { op: 'eq', value: eq[1] };

  // Method predicates: __inputId.startsWith('x') / .endsWith('x') / .includes('x')
  const method = route.filter.match(/__inputId\s*\.\s*(startsWith|endsWith|includes)\s*\(\s*['"]([^'"]+)['"]\s*\)/);
  if (method) return { op: method[1] as InputOp, value: method[2] };

  return null;
}

function matchesInput(candidate: string, constraint: InputConstraint): boolean {
  switch (constraint.op) {
    case 'eq': return candidate === constraint.value;
    case 'startsWith': return candidate.startsWith(constraint.value);
    case 'endsWith': return candidate.endsWith(constraint.value);
    case 'includes': return candidate.includes(constraint.value);
  }
}

function sourceMatchesConstraint(source: Source, constraint: InputConstraint): boolean {
  // __inputId is the full `type:id`, but exact-match routes sometimes use just
  // the id, so test both forms.
  const fullId = `${source.type}:${source.id}`;
  return matchesInput(fullId, constraint) || matchesInput(source.id, constraint);
}

/**
 * Reconstruct a JS filter expression that scopes a live capture to the data
 * flowing through a single data path. Combines the route's own filter with an
 * __inputId clause when the route scopes by the `input` field rather than the
 * filter text. Returns 'true' (match everything on this route) when there is no
 * meaningful constraint to apply.
 */
export function buildCaptureFilter(path: DataPath): string {
  // QuickConnect paths don't go through a route; scope the capture to the
  // source's events by __inputId.
  if (path.kind === 'quickconnect') {
    return path.source ? `__inputId=='${path.source.type}:${path.source.id}'` : 'true';
  }

  const route = path.route;
  if (!route) return 'true';

  const clauses: string[] = [];

  // If the route scoped by the `input` field (not present in the filter text),
  // add an __inputId clause so the capture only sees that source's events.
  const filterHasInputId = route.filter ? /__inputId\s*={2,3}/.test(route.filter) : false;
  if (route.input && !filterHasInputId) {
    clauses.push(`__inputId=='${route.input}'`);
  }

  const trivial = !route.filter || ['true', '1', ''].includes(route.filter.trim());
  if (route.filter && !trivial) {
    clauses.push(`(${route.filter.trim()})`);
  }

  return clauses.length ? clauses.join(' && ') : 'true';
}

// Pull index / sourcetype qualifiers out of a route filter so we can describe
// which slice of a source's data flows through the route. Handles == and ===,
// single or double quotes, and multiple occurrences.
function extractFilterQualifiers(filter: string): string[] {
  const qualifiers: string[] = [];
  for (const field of ['index', 'sourcetype']) {
    const re = new RegExp(`\\b${field}\\s*={2,3}\\s*['"]([^'"]+)['"]`, 'g');
    let match: RegExpExecArray | null;
    while ((match = re.exec(filter)) !== null) {
      qualifiers.push(`${field}=${match[1]}`);
    }
  }
  return qualifiers;
}

// Build the data-type label from description + index/sourcetype qualifiers.
function deriveDataType(route: RouteEntry, fallback: string): string {
  const qualifiers = route.filter ? extractFilterQualifiers(route.filter) : [];

  // Description is the human-friendly base label when present.
  if (route.description) {
    return qualifiers.length ? `${route.description} (${qualifiers.join(', ')})` : route.description;
  }

  // No description: index/sourcetype qualifiers describe the data on their own.
  if (qualifiers.length) {
    return qualifiers.join(', ');
  }

  // Fall back to any remaining meaningful filter expression (minus __inputId).
  if (route.filter) {
    const stripped = route.filter
      .replace(/__inputId\s*={2,3}\s*['"][^'"]+['"]\s*&&\s*/, '')
      .replace(/\s*&&\s*__inputId\s*={2,3}\s*['"][^'"]+['"]/, '')
      .trim();

    if (stripped && stripped !== route.filter && stripped !== 'true' && stripped !== '1') {
      return stripped;
    }
  }

  return fallback;
}

// What to show in the source slot for a content/catch-all route (no __inputId).
function contentRouteSourceDisplay(route: RouteEntry): string {
  const qualifiers = route.filter ? extractFilterQualifiers(route.filter) : [];
  return qualifiers.length ? qualifiers.join(', ') : 'any source';
}

function buildDataPaths(
  sources: Source[],
  destinations: Destination[],
  routes: RouteEntry[],
  pipelines: Pipeline[],
  // When set, every emitted path is tagged as living inside this pack.
  packId?: string
): DataPath[] {
  const destMap = new Map(destinations.map(d => [d.id, d]));
  const pipelineMap = new Map(pipelines.map(p => [p.id, p]));
  const paths: DataPath[] = [];

  // Iterate routes (not sources). A route with an __inputId/input constraint is
  // source-specific and emits one entry per matching source. A route without one
  // is content-based (or catch-all) and emits a SINGLE entry, with the filter
  // qualifiers shown in the source slot — no cloning across every source.
  for (const route of routes) {
    const dest = destMap.get(route.output);
    if (!dest) continue;

    const routeDisabled = !!route.disabled;

    const pipeline = route.pipeline ? pipelineMap.get(route.pipeline) : undefined;
    const inputConstraint = getRouteInputConstraint(route);

    if (inputConstraint) {
      // Source-specific: emit per matching source.
      const matched = sources.filter(s => sourceMatchesConstraint(s, inputConstraint));
      if (matched.length > 0) {
        for (const source of matched) {
          paths.push({
            kind: 'route',
            pack: packId,
            source,
            sourceDisplay: `${source.type}:${source.id}`,
            destination: dest,
            route,
            pipeline,
            dataType: deriveDataType(route, `${source.type}:${source.id}`),
            disabled: routeDisabled || !!source.disabled,
          });
        }
      } else {
        // The route names a source (e.g. __inputId.startsWith('datagen:Zscaler'))
        // but no current source matches. Rather than "any source", label it with
        // the constraint value so it still reads as that input family.
        const label = inputConstraint.value;
        paths.push({
          kind: 'route',
          pack: packId,
          sourceDisplay: label,
          destination: dest,
          route,
          pipeline,
          dataType: deriveDataType(route, label),
          disabled: routeDisabled,
        });
      }
    } else {
      // Content / catch-all: a single entry not tied to any one source.
      paths.push({
        kind: 'route',
        pack: packId,
        sourceDisplay: contentRouteSourceDisplay(route),
        destination: dest,
        route,
        pipeline,
        dataType: deriveDataType(route, contentRouteSourceDisplay(route)),
        disabled: routeDisabled,
      });
    }
  }

  // QuickConnect: sources with sendToRoutes === false bypass the Routes table
  // and connect directly to destinations via their `connections` array.
  for (const source of sources) {
    if (source.sendToRoutes !== false || !source.connections?.length) continue;

    for (const conn of source.connections) {
      const dest = destMap.get(conn.output);
      if (!dest) continue;

      const pipeline = conn.pipeline ? pipelineMap.get(conn.pipeline) : undefined;
      paths.push({
        kind: 'quickconnect',
        pack: packId,
        source,
        sourceDisplay: `${source.type}:${source.id}`,
        destination: dest,
        pipeline,
        dataType: `${source.type}:${source.id}`,
        disabled: !!source.disabled,
      });
    }
  }

  return paths;
}

// Identify configuration gaps: sources with no outgoing path, and destinations
// nothing routes to. Computed from the structural data paths we already built.
function computeCoverage(sources: Source[], destinations: Destination[], dataPaths: DataPath[]): Coverage {
  const sourcesWithPath = new Set<string>();
  const destsUsed = new Set<string>();
  // Content/catch-all routes (kind 'route', no attributed source) can match any
  // source by filter — we can't statically prove a given source ISN'T caught by
  // one. If any exist, we can't confidently call any source orphaned, so we only
  // flag orphans when there are none.
  let hasContentRoute = false;
  for (const p of dataPaths) {
    if (p.source) sourcesWithPath.add(p.source.id);
    else if (p.kind === 'route') hasContentRoute = true;
    destsUsed.add(p.destination.id);
  }
  return {
    // A source is orphaned only if nothing references it AND no content route
    // could plausibly catch it. Avoids false positives from filter-only routes.
    orphanedSources: hasContentRoute ? [] : sources.filter(s => !sourcesWithPath.has(s.id)),
    unusedDestinations: destinations.filter(d => !destsUsed.has(d.id)),
  };
}

// List the worker groups only. Cheap, and lets the UI render the group
// picker immediately without fetching every group's full config up front.
export async function loadGroups(): Promise<WorkerGroup[]> {
  return fetchGroups();
}

// One scope's worth of config (a group or a pack within it): its own inputs,
// outputs, routes, pipelines, plus the data paths and status built from them.
interface Scope {
  packId: string;
  sources: Source[];
  destinations: Destination[];
  routes: RouteEntry[];
  pipelines: Pipeline[];
  dataPaths: DataPath[];
  status: GroupStatus;
}

// A pack route hands events back to the worker group routing table when its
// "Destination" is set to "Send to Worker Group Routes", which serializes as
// `targetContext: 'group'`. Those routes are stitched to their real group
// destination separately (see buildStitchedPaths), so the raw hand-off row is
// suppressed to avoid a meaningless endpoint.
function isHandoffRoute(route: RouteEntry): boolean {
  return route.targetContext === 'group';
}

// `devnull` (events discarded) and `default` (the placeholder Default output,
// used when a route isn't wired to a real destination) are both non-flowing
// endpoints. Note: `default` here is a genuine dead-end — a route that hands off
// to the routing table is identified by targetContext, NOT by pointing at the
// default output.
const NONFLOWING_DEST_IDS = new Set(['devnull', 'default']);

function isNonflowingDestination(dest: Destination): boolean {
  return NONFLOWING_DEST_IDS.has(dest.id) || NONFLOWING_DEST_IDS.has(dest.type);
}

// Decide whether a raw pack route path is "in use" and worth showing on its own.
// Hand-off routes (targetContext 'group') are dropped here — they reappear as
// stitched paths. Non-flowing destinations (devnull/default placeholder) are
// dropped. A real destination must also report active health (Unknown = no
// worker processing it, nothing flowing); Green/Yellow/Red all count as live.
// QuickConnect paths aren't routes, so they're always kept.
function packPathInUse(path: DataPath, status: GroupStatus): boolean {
  if (path.kind !== 'route') return true;
  if (path.route && isHandoffRoute(path.route)) return false;
  if (isNonflowingDestination(path.destination)) return false;
  const health = status.outputs[path.destination.id]?.health;
  return health !== undefined && health !== 'Unknown';
}

// Match a group route that re-admits a specific pack's events. Packs hand off to
// the routing table via targetContext 'group'; the group route catches them with
// a filter clause on `__packId` (e.g. __packId=='myPack', ===, or
// .startsWith/.includes/.endsWith('myPack')).
function groupRouteMatchesPack(route: RouteEntry, packId: string): boolean {
  const filter = route.filter;
  if (!filter) return false;

  const eq = filter.match(/__packId\s*={2,3}\s*['"]([^'"]+)['"]/);
  if (eq) return eq[1] === packId;

  const method = filter.match(/__packId\s*\.\s*(startsWith|endsWith|includes)\s*\(\s*['"]([^'"]+)['"]\s*\)/);
  if (method) return matchesInput(packId, { op: method[1] as InputOp, value: method[2] });

  return false;
}

// Stitch pack routes that hand off to the group routing table onto the group
// routes that re-admit them, completing the flow to a real group destination:
//
//   pack source → [pack pipeline] → (pack route) ⇢ WG routing table
//                → [group pipeline] → group destination
//
// Emits one path per (matching pack source × hand-off pack route × matching
// group route × resolved group destination). Returns [] when no group route
// re-admits this pack, so nothing is invented.
function buildStitchedPaths(
  packId: string,
  packSources: Source[],
  packRoutes: RouteEntry[],
  packPipelines: Pipeline[],
  groupRoutes: RouteEntry[],
  groupDestinations: Destination[],
  groupPipelines: Pipeline[],
): DataPath[] {
  const groupMatches = groupRoutes.filter(r => groupRouteMatchesPack(r, packId));
  if (groupMatches.length === 0) return [];

  const packPipelineMap = new Map(packPipelines.map(p => [p.id, p]));
  const groupDestMap = new Map(groupDestinations.map(d => [d.id, d]));
  const groupPipelineMap = new Map(groupPipelines.map(p => [p.id, p]));

  // Track each path's specificity so we can drop the pack's catch-all passthrough
  // when a source-specific route already reaches the same destination.
  const built: { path: DataPath; catchAll: boolean }[] = [];

  for (const packRoute of packRoutes) {
    if (!isHandoffRoute(packRoute)) continue;
    const packPipeline = packRoute.pipeline ? packPipelineMap.get(packRoute.pipeline) : undefined;
    const packRouteDisabled = !!packRoute.disabled;

    // Resolve the pack-side origin(s): source-specific routes emit per matching
    // pack source; content/catch-all routes emit one entry describing the slice.
    const constraint = getRouteInputConstraint(packRoute);
    const catchAll = !constraint;
    const origins: { source?: Source; sourceDisplay: string }[] = [];
    if (constraint) {
      const matched = packSources.filter(s => sourceMatchesConstraint(s, constraint));
      if (matched.length > 0) {
        for (const source of matched) origins.push({ source, sourceDisplay: `${source.type}:${source.id}` });
      } else {
        origins.push({ sourceDisplay: constraint.value });
      }
    } else {
      origins.push({ sourceDisplay: contentRouteSourceDisplay(packRoute) });
    }

    for (const groupRoute of groupMatches) {
      const dest = groupDestMap.get(groupRoute.output);
      if (!dest) continue;
      const groupPipeline = groupRoute.pipeline ? groupPipelineMap.get(groupRoute.pipeline) : undefined;

      for (const origin of origins) {
        built.push({
          catchAll,
          path: {
            kind: 'route',
            pack: packId,
            source: origin.source,
            sourceDisplay: origin.sourceDisplay,
            destination: dest,
            route: packRoute,
            pipeline: packPipeline,
            dataType: deriveDataType(packRoute, origin.sourceDisplay),
            disabled: packRouteDisabled || !!groupRoute.disabled || !!origin.source?.disabled,
            stitch: {
              viaLabel: 'Worker Group Routing Table',
              groupRoute,
              groupPipeline,
            },
          },
        });
      }
    }
  }

  // Per destination, if any source-specific stitched path reaches it, hide the
  // pack's catch-all ("any source") path to that same destination — it's the
  // pack's default passthrough duplicating a flow we already show specifically.
  // A catch-all survives only when it's the sole path to its destination, so no
  // real flow is ever fully hidden.
  const destsWithSpecific = new Set(
    built.filter(b => !b.catchAll).map(b => b.path.destination.id),
  );
  return built
    .filter(b => !(b.catchAll && destsWithSpecific.has(b.path.destination.id)))
    .map(b => b.path);
}

// Load one pack's self-contained config and build its data paths. Best-effort:
// a pack that fails to load yields an empty scope rather than breaking the
// whole group. Pack config ids are namespaced (`pack:id`) so they don't collide
// with group-level entities when merged. Pack routes that aren't in use (default
// destination or no active health) are filtered out.
async function loadPackScope(groupId: string, packId: string): Promise<Scope> {
  try {
    const [sources, destinations, routesConfig, pipelines, status] = await Promise.all([
      fetchPackSources(groupId, packId).catch(() => [] as Source[]),
      fetchPackDestinations(groupId, packId).catch(() => [] as Destination[]),
      fetchPackRoutes(groupId, packId).catch(() => ({ routes: [] as RouteEntry[] })),
      fetchPackPipelines(groupId, packId).catch(() => [] as Pipeline[]),
      fetchGroupStatus(groupId, packId),
    ]);
    const dataPaths = buildDataPaths(sources, destinations, routesConfig.routes, pipelines, packId)
      .filter(path => packPathInUse(path, status));
    // Raw (untagged) config is kept in the scope so the group-level loader can
    // stitch pack→routing-table→destination flows across the boundary.
    return { packId, sources, destinations, routes: routesConfig.routes, pipelines, dataPaths, status };
  } catch {
    return { packId, sources: [], destinations: [], routes: [], pipelines: [], dataPaths: [], status: { inputs: {}, outputs: {} } };
  }
}

// Load the full data dictionary for a SINGLE group, including every pack
// installed in it. Group config + live status are fetched in parallel, then
// each pack is loaded (best-effort) and its self-contained data paths merged in.
// Loading one group at a time (on selection) keeps the request fan-out small and
// avoids timeouts on instances with many groups.
//
// Scope note: paths are built WITHIN each scope — a pack's routes match the
// pack's own sources/destinations. Cross-boundary flows where a pack hands events
// back to the worker group routing table (via its Default output) and a group
// route re-admits them (matched by __packId) ARE reconstructed, via
// buildStitchedPaths. The reverse (a group route feeding into a pack) is not.
export async function loadGroupDataDictionary(group: WorkerGroup): Promise<GroupDataDictionary> {
  const [sources, destinations, routesConfig, pipelines, status, packs] = await Promise.all([
    fetchSources(group.id),
    fetchDestinations(group.id),
    fetchRoutes(group.id),
    fetchPipelines(group.id),
    fetchGroupStatus(group.id),
    fetchPacks(group.id).catch(() => []),
  ]);

  const packScopes = await Promise.all(packs.map(pack => loadPackScope(group.id, pack.id)));

  // Merge group scope with every pack scope. Status maps combine into one keyed
  // set (pack entity ids are distinct from group ids in practice). Pack sources/
  // destinations are tagged with their pack id here (scopes hold raw config so
  // they can be reused for cross-boundary stitching first).
  const allSources = [
    ...sources,
    ...packScopes.flatMap(s => s.sources.map(src => ({ ...src, pack: s.packId }))),
  ];
  const allDestinations = [
    ...destinations,
    ...packScopes.flatMap(s => s.destinations.map(d => ({ ...d, pack: s.packId }))),
  ];
  const allPipelines = [...pipelines, ...packScopes.flatMap(s => s.pipelines)];
  const groupPaths = buildDataPaths(sources, destinations, routesConfig.routes, pipelines);

  // Stitch each pack's hand-off routes onto the group routes that re-admit them
  // (matched by __packId), completing pack → routing-table → destination flows.
  const stitchedPaths = packScopes.flatMap(s =>
    buildStitchedPaths(
      s.packId, s.sources, s.routes, s.pipelines,
      routesConfig.routes, destinations, pipelines,
    ),
  );

  const dataPaths = [...groupPaths, ...packScopes.flatMap(s => s.dataPaths), ...stitchedPaths];

  const mergedStatus: GroupStatus = {
    inputs: { ...status.inputs, ...Object.assign({}, ...packScopes.map(s => s.status.inputs)) },
    outputs: { ...status.outputs, ...Object.assign({}, ...packScopes.map(s => s.status.outputs)) },
  };

  // Coverage is computed on group-level entities only — packs are self-contained,
  // so a pack source with no pack route is expected, not an orphan to flag.
  const coverage = computeCoverage(sources, destinations, groupPaths);

  return {
    group,
    sources: allSources,
    destinations: allDestinations,
    routes: routesConfig.routes,
    pipelines: allPipelines,
    dataPaths,
    status: mergedStatus,
    coverage,
  };
}
