import type { DataPath, GroupStatus, Health } from './types';
import type { MetadataStore, DataPathMetadata } from './metadata';
import { getPathKey } from './metadata';

export type ExportFormat = 'csv' | 'json' | 'markdown';

// One flattened data-path row: everything the UI shows for a path plus its
// user-authored metadata and resolved health. Shared by the CSV and Markdown
// renderers so their columns never drift apart.
interface ExportRow {
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

// Mirrors App.tsx's pathKeyOf so exported metadata matches what the UI edits.
function pathKeyOf(path: DataPath): string {
  const routeId = path.route?.id ?? `qc:${path.kind}`;
  return getPathKey(path.source?.id ?? path.sourceDisplay, routeId, path.destination.id);
}

function healthOf(id: string | undefined, map: Record<string, { health: Health }>): string {
  if (!id) return '';
  return map[id]?.health ?? '';
}

function toRow(path: DataPath, meta: DataPathMetadata, status?: GroupStatus): ExportRow {
  return {
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

function toMarkdown(rows: ExportRow[], groupName: string): string {
  const header = `| ${COLUMNS.map(([, label]) => label).join(' | ')} |`;
  const divider = `| ${COLUMNS.map(() => '---').join(' | ')} |`;
  const body = rows.map(
    row => `| ${COLUMNS.map(([key]) => mdCell(row[key])).join(' | ')} |`,
  );
  return [`# Data Dictionary — ${groupName}`, '', header, divider, ...body, ''].join('\n');
}

// Full-fidelity structured export: keeps nested route/pipeline/metadata/health
// rather than flattening, so it round-trips for backup or re-import.
function toJson(paths: DataPath[], metadataStore: MetadataStore, status: GroupStatus | undefined, groupName: string): string {
  const payload = {
    group: groupName,
    exportedPathCount: paths.length,
    paths: paths.map(path => ({
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
      metadata: metadataStore[pathKeyOf(path)] ?? {},
      health: {
        source: healthOf(path.source?.id, status?.inputs ?? {}) || null,
        destination: healthOf(path.destination.id, status?.outputs ?? {}) || null,
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
  status: GroupStatus | undefined,
  groupName: string,
): string {
  if (format === 'json') return toJson(paths, metadataStore, status, groupName);
  const rows = paths.map(path => toRow(path, metadataStore[pathKeyOf(path)] ?? {}, status));
  return format === 'csv' ? toCsv(rows) : toMarkdown(rows, groupName);
}

// Turn a group name into a filesystem-friendly slug for the download filename.
function slug(name: string): string {
  return name.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'group';
}

// Trigger a browser download of the export. Kept out of buildExport so the
// serialization stays pure and unit-testable.
export function downloadExport(
  format: ExportFormat,
  paths: DataPath[],
  metadataStore: MetadataStore,
  status: GroupStatus | undefined,
  groupName: string,
): void {
  const { ext, mime } = FORMAT_META[format];
  const content = buildExport(format, paths, metadataStore, status, groupName);
  const blob = new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `data-dictionary-${slug(groupName)}.${ext}`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}
