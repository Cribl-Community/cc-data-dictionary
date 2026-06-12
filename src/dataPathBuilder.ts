import type { Source, Destination, RouteEntry, Pipeline, DataPath, GroupDataDictionary, WorkerGroup } from './types';
import { fetchGroups, fetchSources, fetchDestinations, fetchRoutes, fetchPipelines } from './api';

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
  const clauses: string[] = [];

  // If the route scoped by the `input` field (not present in the filter text),
  // add an __inputId clause so the capture only sees that source's events.
  const route = path.route;
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
  pipelines: Pipeline[]
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
        sourceDisplay: contentRouteSourceDisplay(route),
        destination: dest,
        route,
        pipeline,
        dataType: deriveDataType(route, contentRouteSourceDisplay(route)),
        disabled: routeDisabled,
      });
    }
  }

  return paths;
}

export async function loadGroupDataDictionary(): Promise<GroupDataDictionary[]> {
  const groups = await fetchGroups();

  const results = await Promise.all(
    groups.map(async (group: WorkerGroup) => {
      const [sources, destinations, routesConfig, pipelines] = await Promise.all([
        fetchSources(group.id),
        fetchDestinations(group.id),
        fetchRoutes(group.id),
        fetchPipelines(group.id),
      ]);

      const dataPaths = buildDataPaths(sources, destinations, routesConfig.routes, pipelines);

      return {
        group,
        sources,
        destinations,
        routes: routesConfig.routes,
        pipelines,
        dataPaths,
      };
    })
  );

  return results;
}
