import type { DataPath, GroupStatus, Health } from './types';
import type { MetadataStore, DataPathMetadata } from './metadata';
import { metaFor } from './metadata';

export type ExportFormat = 'csv' | 'json' | 'markdown';

// Status for every group in the export, keyed by group id. Source/destination ids
// are only unique within a group, so health must be resolved against the path's
// OWN group — one merged map would mis-attribute health across groups.
export type StatusByGroup = Record<string, GroupStatus>;

// One flattened data-path row: everything the UI shows for a path plus its
// user-authored metadata and resolved health. Shared by the CSV and Markdown
// renderers so their columns never drift apart.
interface ExportRow {
  workerGroup: string;
  dataSourceLabel: string;
  dataType: string;
  pack: string;
  connection: string; // 'route' | 'quickconnect'
  source: string;
  sourceId: string;
  sourceType: string;
  pipeline: string;
  via: string;
  groupRoute: string;
  destinationType: string;
  destinationId: string;
  routeName: string;
  routeFilter: string;
  disabled: string; // 'yes' | ''
  owner: string;
  criticality: string;
  notes: string;
  sourceHealth: string;
  destinationHealth: string;
}

function healthOf(id: string | undefined, map: Record<string, { health: Health }>): string {
  if (!id) return '';
  return map[id]?.health ?? '';
}

function toRow(path: DataPath, meta: DataPathMetadata, status?: GroupStatus): ExportRow {
  return {
    workerGroup: path.groupName,
    dataSourceLabel: meta.dataSourceLabel || path.dataType,
    dataType: path.dataType,
    pack: path.pack ?? '',
    connection: path.kind,
    source: path.sourceDisplay,
    sourceId: path.source?.id ?? '',
    sourceType: path.source?.type ?? '',
    pipeline: path.pipeline?.id ?? '',
    via: path.stitch ? path.stitch.viaLabel : '',
    groupRoute: path.stitch ? path.stitch.groupRoute.name : '',
    destinationType: path.destination.type,
    destinationId: path.destination.id,
    routeName: path.route?.name ?? '',
    routeFilter: path.route?.filter && path.route.filter !== 'true' ? path.route.filter : '',
    disabled: path.disabled ? 'yes' : '',
    owner: meta.owner ?? '',
    criticality: meta.criticality ?? '',
    notes: meta.notes ?? '',
    sourceHealth: healthOf(path.source?.id, status?.inputs ?? {}),
    destinationHealth: healthOf(path.destination.id, status?.outputs ?? {}),
  };
}

// Ordered [key -> header] so a single list drives column order + labels.
const COLUMNS: [keyof ExportRow, string][] = [
  ['workerGroup', 'Worker Group'],
  ['dataSourceLabel', 'Data Source Label'],
  ['dataType', 'Data Type'],
  ['pack', 'Pack'],
  ['connection', 'Connection'],
  ['source', 'Source'],
  ['sourceId', 'Source ID'],
  ['sourceType', 'Source Type'],
  ['pipeline', 'Pipeline'],
  ['via', 'Via'],
  ['groupRoute', 'Group Route'],
  ['destinationType', 'Destination Type'],
  ['destinationId', 'Destination ID'],
  ['routeName', 'Route Name'],
  ['routeFilter', 'Route Filter'],
  ['disabled', 'Disabled'],
  ['owner', 'Owner'],
  ['criticality', 'Criticality'],
  ['notes', 'Notes'],
  ['sourceHealth', 'Source Health'],
  ['destinationHealth', 'Destination Health'],
];

// RFC 4180: quote a field if it contains a comma, quote, or newline; escape
// embedded quotes by doubling them.
function csvCell(value: string): string {
  if (/[",\n\r]/.test(value)) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
}

function toCsv(rows: ExportRow[]): string {
  const header = COLUMNS.map(([, label]) => csvCell(label)).join(',');
  const lines = rows.map(row => COLUMNS.map(([key]) => csvCell(row[key])).join(','));
  return [header, ...lines].join('\r\n');
}

// Escape pipes and collapse newlines so a cell can't break the table layout.
function mdCell(value: string): string {
  return value.replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');
}

function toMarkdown(rows: ExportRow[], scopeName: string): string {
  const header = `| ${COLUMNS.map(([, label]) => label).join(' | ')} |`;
  const divider = `| ${COLUMNS.map(() => '---').join(' | ')} |`;
  const body = rows.map(
    row => `| ${COLUMNS.map(([key]) => mdCell(row[key])).join(' | ')} |`,
  );
  return [`# Data Dictionary — ${scopeName}`, '', header, divider, ...body, ''].join('\n');
}

// Full-fidelity structured export: keeps nested route/pipeline/metadata/health
// rather than flattening, so it round-trips for backup or re-import.
function toJson(paths: DataPath[], metadataStore: MetadataStore, statusByGroup: StatusByGroup, scopeName: string): string {
  const payload = {
    scope: scopeName,
    exportedPathCount: paths.length,
    paths: paths.map(path => ({
      workerGroup: path.groupName,
      workerGroupId: path.groupId,
      dataType: path.dataType,
      pack: path.pack ?? null,
      connection: path.kind,
      sourceDisplay: path.sourceDisplay,
      source: path.source ?? null,
      destination: path.destination,
      route: path.route ?? null,
      pipeline: path.pipeline ?? null,
      stitch: path.stitch
        ? { via: path.stitch.viaLabel, groupRoute: path.stitch.groupRoute, groupPipeline: path.stitch.groupPipeline ?? null }
        : null,
      disabled: path.disabled,
      metadata: metaFor(metadataStore, path),
      health: {
        source: healthOf(path.source?.id, statusByGroup[path.groupId]?.inputs ?? {}) || null,
        destination: healthOf(path.destination.id, statusByGroup[path.groupId]?.outputs ?? {}) || null,
      },
    })),
  };
  return JSON.stringify(payload, null, 2);
}

const FORMAT_META: Record<ExportFormat, { ext: string; mime: string }> = {
  csv: { ext: 'csv', mime: 'text/csv;charset=utf-8' },
  json: { ext: 'json', mime: 'application/json' },
  markdown: { ext: 'md', mime: 'text/markdown;charset=utf-8' },
};

export function buildExport(
  format: ExportFormat,
  paths: DataPath[],
  metadataStore: MetadataStore,
  statusByGroup: StatusByGroup,
  scopeName: string,
): string {
  if (format === 'json') return toJson(paths, metadataStore, statusByGroup, scopeName);
  const rows = paths.map(path =>
    toRow(path, metaFor(metadataStore, path), statusByGroup[path.groupId]),
  );
  return format === 'csv' ? toCsv(rows) : toMarkdown(rows, scopeName);
}

// Turn a scope name into a filesystem-friendly slug for the download filename.
function slug(name: string): string {
  return name.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'group';
}

// Trigger a browser download of the export. Kept out of buildExport so the
// serialization stays pure and unit-testable.
export function downloadExport(
  format: ExportFormat,
  paths: DataPath[],
  metadataStore: MetadataStore,
  statusByGroup: StatusByGroup,
  scopeName: string,
): void {
  const { ext, mime } = FORMAT_META[format];
  const content = buildExport(format, paths, metadataStore, statusByGroup, scopeName);
  const blob = new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `data-dictionary-${slug(scopeName)}.${ext}`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}
