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

export interface DataPath {
  // How the data reaches the destination: through the Routes table, or via a
  // direct QuickConnect link on the source.
  kind: 'route' | 'quickconnect';
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
}

export interface GroupDataDictionary {
  group: WorkerGroup;
  sources: Source[];
  destinations: Destination[];
  routes: RouteEntry[];
  pipelines: Pipeline[];
  dataPaths: DataPath[];
}
