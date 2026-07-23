declare global {
  interface Window {
    CRIBL_API_URL: string;
    CRIBL_BASE_PATH: string;
  }
}

export interface WorkerGroup {
  id: string;
  name?: string;
  description?: string;
}

// A QuickConnect link: a source wired directly to a destination (and optionally
// through a pipeline/pack), bypassing the Routes table.
export interface SourceConnection {
  output: string;
  pipeline?: string;
}

export interface Source {
  id: string;
  type: string;
  conf?: Record<string, unknown>;
  pack?: string;
  disabled?: boolean;
  // QuickConnect: when sendToRoutes is false, the source uses these direct
  // connections instead of the Routes table.
  sendToRoutes?: boolean;
  connections?: SourceConnection[];
}

export interface Destination {
  id: string;
  type: string;
  conf?: Record<string, unknown>;
  pack?: string;
  disabled?: boolean;
}

export interface RouteEntry {
  id: string;
  name: string;
  filter?: string;
  pipeline?: string;
  output: string;
  input?: string;
  final?: boolean;
  disabled?: boolean;
  description?: string;
  // 'group' = "Send to Worker Group Routes" (a pack route handing events back to
  // the worker group routing table); 'pack' = stay within the pack. Absent on
  // ordinary routes that send to a named output.
  targetContext?: 'group' | 'pack';
}

export interface RoutesConfig {
  id?: string;
  routes: RouteEntry[];
}

export interface Pipeline {
  id: string;
  conf: {
    description?: string;
    output?: string;
    functions?: Record<string, unknown>[];
  };
}

// A Cribl pack: a self-contained bundle with its own inputs, outputs, routes,
// and pipelines, installed into a worker group.
export interface Pack {
  id: string;
  name?: string;
  description?: string;
  version?: string;
  disabled?: boolean;
}

export interface DataPath {
  // How the data reaches the destination: through the Routes table, or via a
  // direct QuickConnect link on the source.
  kind: 'route' | 'quickconnect';
  // Id of the pack this path lives inside, or undefined for group-level paths.
  // Pack paths are built from the pack's own self-contained config.
  pack?: string;
  // Present only for source-specific routes (those with an __inputId/input
  // constraint) and for all QuickConnect paths. Content/catch-all routes are
  // not tied to one source.
  source?: Source;
  // What to render in the "source" slot of the flow. For source-specific routes
  // this is `type:id`; for content routes it's the filter qualifiers (or "any source").
  sourceDisplay: string;
  destination: Destination;
  // Absent for QuickConnect paths, which don't go through the Routes table.
  route?: RouteEntry;
  pipeline?: Pipeline;
  dataType: string;
  // True when this path is inactive — the route is disabled or its source is disabled.
  disabled: boolean;
  // Set when a pack route hands its events back to the worker group routing table
  // (via the pack's built-in Default output) and a group route re-admits them
  // (matched by a __packId filter) to a real group destination. `route`/`pipeline`
  // describe the pack side; `stitch` describes the group-side second hop, and
  // `destination` is the final group destination.
  stitch?: {
    viaLabel: string;
    groupRoute: RouteEntry;
    groupPipeline?: Pipeline;
  };
}

// Health of a source or destination, from /system/status/*.
export type Health = 'Green' | 'Yellow' | 'Red' | 'Unknown';

// Normalized health for one source or destination. (Cribl's status endpoint
// reports health only; throughput lives in the separate metrics store and is
// not surfaced here.)
export interface NodeStatus {
  id: string;
  type?: string;
  health: Health;
  errorMessage?: string;
}

// Status maps keyed by source/destination id for a group.
export interface GroupStatus {
  inputs: Record<string, NodeStatus>;
  outputs: Record<string, NodeStatus>;
}

// Configuration gaps surfaced by coverage analysis.
export interface Coverage {
  // Sources with no data path leaving them (no route/QuickConnect matches).
  orphanedSources: Source[];
  // Destinations that nothing routes to.
  unusedDestinations: Destination[];
}

export interface GroupDataDictionary {
  group: WorkerGroup;
  sources: Source[];
  destinations: Destination[];
  routes: RouteEntry[];
  pipelines: Pipeline[];
  dataPaths: DataPath[];
  status: GroupStatus;
  coverage: Coverage;
}
