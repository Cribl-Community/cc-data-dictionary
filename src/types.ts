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

export interface Source {
  id: string;
  type: string;
  conf?: Record<string, unknown>;
  pack?: string;
  disabled?: boolean;
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
  // Present only for source-specific routes (those with an __inputId/input
  // constraint). Content/catch-all routes are not tied to one source.
  source?: Source;
  // What to render in the "source" slot of the flow. For source-specific routes
  // this is `type:id`; for content routes it's the filter qualifiers (or "any source").
  sourceDisplay: string;
  destination: Destination;
  route: RouteEntry;
  pipeline?: Pipeline;
  dataType: string;
  // True when this path is inactive — either the route is disabled or its
  // matched source is disabled.
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
