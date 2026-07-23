import { useEffect, useState, useCallback, useRef } from 'react';
import { loadGroups, loadGroupDataDictionary, buildCaptureFilter } from './dataPathBuilder';
import { loadMetadata, saveMetadata, getPathKey } from './metadata';
import { captureEvents } from './api';
import { analyzeFields } from './fieldAnalysis';
import { downloadExport } from './export';
import type { ExportFormat } from './export';
import type { FieldStat } from './fieldAnalysis';
import type { GroupDataDictionary, DataPath, WorkerGroup, Health, GroupStatus } from './types';
import type { MetadataStore, DataPathMetadata } from './metadata';

// Capture stages exposed by the Field Explorer (Cribl capture `level`).
const CAPTURE_LEVELS: { value: number; label: string }[] = [
  { value: 1, label: 'Before Routes' },
  { value: 2, label: 'Before Post-Processing Pipeline' },
  { value: 3, label: 'Before Destination' },
];

// Stable key for a data path. Source-specific routes key on the source id;
// content/catch-all routes have no source, so key on the displayed source slot.
function pathKeyOf(path: DataPath): string {
  // QuickConnect paths have no route; key them on a stable "qc" marker.
  const routeId = path.route?.id ?? `qc:${path.kind}`;
  return getPathKey(path.source?.id ?? path.sourceDisplay, routeId, path.destination.id);
}

type Criticality = 'low' | 'medium' | 'high' | 'critical';
type GroupBy = 'none' | 'owner' | 'criticality' | 'destination';

const CRITICALITY_COLORS: Record<Criticality, string> = {
  low: '#52c41a',
  medium: '#faad14',
  high: '#fa541c',
  critical: '#cf1322',
};

const CRITICALITY_ORDER: Record<string, number> = {
  critical: 0,
  high: 1,
  medium: 2,
  low: 3,
  '': 4,
};

function CriticalityBadge({ level }: { level?: Criticality }) {
  if (!level) return null;
  return (
    <span className="criticality-badge" style={{ backgroundColor: CRITICALITY_COLORS[level] }}>
      {level}
    </span>
  );
}

function MetadataEditor({
  pathKey,
  metadata,
  onSave,
}: {
  pathKey: string;
  metadata: DataPathMetadata;
  onSave: (key: string, meta: DataPathMetadata) => void;
}) {
  const [owner, setOwner] = useState(metadata.owner || '');
  const [criticality, setCriticality] = useState<Criticality | ''>(metadata.criticality || '');
  const [notes, setNotes] = useState(metadata.notes || '');
  const [dataSourceLabel, setDataSourceLabel] = useState(metadata.dataSourceLabel || '');
  const [dirty, setDirty] = useState(false);

  function handleSave() {
    onSave(pathKey, {
      owner: owner || undefined,
      criticality: (criticality as Criticality) || undefined,
      notes: notes || undefined,
      dataSourceLabel: dataSourceLabel || undefined,
    });
    setDirty(false);
  }

  return (
    <div className="metadata-editor">
      <div className="meta-field">
        <label>Data Source Label</label>
        <input
          type="text"
          placeholder="e.g. Firewall Logs, DNS Queries..."
          value={dataSourceLabel}
          onChange={e => { setDataSourceLabel(e.target.value); setDirty(true); }}
        />
        <span className="meta-hint">Label the specific data flowing through this path</span>
      </div>
      <div className="meta-field">
        <label>Owner</label>
        <input
          type="text"
          placeholder="Team or person responsible"
          value={owner}
          onChange={e => { setOwner(e.target.value); setDirty(true); }}
        />
      </div>
      <div className="meta-field">
        <label>Criticality</label>
        <select
          value={criticality}
          onChange={e => { setCriticality(e.target.value as Criticality | ''); setDirty(true); }}
        >
          <option value="">Not set</option>
          <option value="low">Low</option>
          <option value="medium">Medium</option>
          <option value="high">High</option>
          <option value="critical">Critical</option>
        </select>
      </div>
      <div className="meta-field">
        <label>Notes</label>
        <textarea
          placeholder="Additional context about this data..."
          value={notes}
          onChange={e => { setNotes(e.target.value); setDirty(true); }}
          rows={2}
        />
      </div>
      {dirty && (
        <button className="save-meta-btn" onClick={handleSave}>Save</button>
      )}
    </div>
  );
}

function FieldExplorer({ groupId, path }: { groupId: string; path: DataPath }) {
  const [level, setLevel] = useState(3);
  const [duration, setDuration] = useState(10);
  const [maxEvents, setMaxEvents] = useState(100);
  const [running, setRunning] = useState(false);
  const [progress, setProgress] = useState(0);
  const [fields, setFields] = useState<FieldStat[] | null>(null);
  const [sampleSize, setSampleSize] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [showInternal, setShowInternal] = useState(false);
  const abortRef = useRef<AbortController | null>(null);

  async function runCapture() {
    setRunning(true);
    setError(null);
    setProgress(0);
    setFields(null);
    const controller = new AbortController();
    abortRef.current = controller;
    try {
      const events = await captureEvents(
        groupId,
        { level, filter: buildCaptureFilter(path), duration, maxEvents },
        count => setProgress(count),
        controller.signal
      );
      setSampleSize(events.length);
      setFields(analyzeFields(events));
    } catch (e) {
      if (!controller.signal.aborted) {
        setError(e instanceof Error ? e.message : 'Capture failed');
      }
    } finally {
      setRunning(false);
      abortRef.current = null;
    }
  }

  function stopCapture() {
    abortRef.current?.abort();
    setRunning(false);
  }

  const visibleFields = fields?.filter(f => showInternal || !f.internal) ?? [];
  const internalCount = fields?.filter(f => f.internal).length ?? 0;

  return (
    <div className="field-explorer">
      <div className="field-explorer-controls">
        <label>
          Capture at
          <select value={level} onChange={e => setLevel(Number(e.target.value))} disabled={running}>
            {CAPTURE_LEVELS.map(l => (
              <option key={l.value} value={l.value}>{l.label}</option>
            ))}
          </select>
        </label>
        <label>
          Duration (s)
          <input
            type="number" min={1} max={60} value={duration}
            onChange={e => setDuration(Number(e.target.value))} disabled={running}
          />
        </label>
        <label>
          Max events
          <input
            type="number" min={1} max={1000} value={maxEvents}
            onChange={e => setMaxEvents(Number(e.target.value))} disabled={running}
          />
        </label>
        {running ? (
          <button className="capture-btn stop" onClick={stopCapture}>Stop ({progress})</button>
        ) : (
          <button className="capture-btn" onClick={runCapture}>Run Capture</button>
        )}
      </div>

      {running && <div className="capture-status">Capturing… {progress} events</div>}
      {error && <div className="capture-error">{error}</div>}

      {fields && !running && (
        <div className="field-results">
          <div className="field-results-header">
            <span>{visibleFields.length} fields from {sampleSize} events</span>
            {internalCount > 0 && (
              <label className="internal-toggle">
                <input type="checkbox" checked={showInternal} onChange={e => setShowInternal(e.target.checked)} />
                Show {internalCount} internal (__) fields
              </label>
            )}
          </div>
          {sampleSize === 0 ? (
            <div className="field-empty">No events captured. Try a longer duration or an earlier stage.</div>
          ) : (
            <table className="field-table">
              <thead>
                <tr><th>Field</th><th>Type</th><th>Fill</th><th>Sample</th></tr>
              </thead>
              <tbody>
                {visibleFields.map(f => (
                  <tr key={f.name} className={f.internal ? 'internal-field' : ''}>
                    <td className="field-name">{f.name}</td>
                    <td className="field-type">{f.types.join(' | ')}</td>
                    <td className="field-fill">
                      <div className="fill-track">
                        <span className="fill-bar" style={{ width: `${Math.round(f.fillRate * 100)}%` }} />
                      </div>
                      <span className="fill-pct">{Math.round(f.fillRate * 100)}%</span>
                    </td>
                    <td className="field-sample"><code>{f.sample ?? ''}</code></td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      )}
    </div>
  );
}

const HEALTH_COLORS: Record<Health, string> = {
  Green: '#52c41a',
  Yellow: '#faad14',
  Red: '#cf1322',
  Unknown: '#bfbfbf',
};

function HealthDot({ health, title }: { health: Health; title?: string }) {
  return (
    <span
      className="health-dot"
      style={{ backgroundColor: HEALTH_COLORS[health] }}
      title={title || `Health: ${health}`}
    />
  );
}

// Combine source + destination health into the worse of the two (Red > Yellow >
// Green > Unknown), so the path dot reflects the weakest link.
function worstHealth(a?: Health, b?: Health): Health {
  const rank: Record<Health, number> = { Red: 3, Yellow: 2, Green: 1, Unknown: 0 };
  const candidates = [a, b].filter(Boolean) as Health[];
  if (candidates.length === 0) return 'Unknown';
  return candidates.reduce((w, h) => (rank[h] > rank[w] ? h : w));
}

function CoverageBanner({ dict }: { dict: GroupDataDictionary }) {
  const [open, setOpen] = useState(false);
  const { orphanedSources, unusedDestinations } = dict.coverage;
  const total = orphanedSources.length + unusedDestinations.length;
  if (total === 0) return null;

  return (
    <div className="coverage-banner">
      <div className="coverage-summary" onClick={() => setOpen(o => !o)}>
        <span className="coverage-icon">⚠️</span>
        <span className="coverage-text">
          {orphanedSources.length > 0 && `${orphanedSources.length} orphaned source${orphanedSources.length > 1 ? 's' : ''}`}
          {orphanedSources.length > 0 && unusedDestinations.length > 0 && ' · '}
          {unusedDestinations.length > 0 && `${unusedDestinations.length} unused destination${unusedDestinations.length > 1 ? 's' : ''}`}
        </span>
        <span className={`chevron ${open ? 'expanded' : ''}`}>&#9654;</span>
      </div>
      {open && (
        <div className="coverage-detail">
          {orphanedSources.length > 0 && (
            <div className="coverage-group">
              <span className="detail-label">Sources with no outgoing path:</span>
              <div className="coverage-chips">
                {orphanedSources.map(s => <span key={s.id} className="coverage-chip">{s.type}:{s.id}</span>)}
              </div>
            </div>
          )}
          {unusedDestinations.length > 0 && (
            <div className="coverage-group">
              <span className="detail-label">Destinations nothing routes to:</span>
              <div className="coverage-chips">
                {unusedDestinations.map(d => <span key={d.id} className="coverage-chip">{d.type}:{d.id}</span>)}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function DataPathCard({
  path,
  expanded,
  onToggle,
  metadata,
  pathKey,
  groupId,
  status,
  onSaveMetadata,
}: {
  path: DataPath;
  expanded: boolean;
  onToggle: () => void;
  metadata: DataPathMetadata;
  pathKey: string;
  groupId: string;
  status?: GroupStatus;
  onSaveMetadata: (key: string, meta: DataPathMetadata) => void;
}) {
  const displayName = metadata.dataSourceLabel || path.dataType;
  const [showExplorer, setShowExplorer] = useState(false);

  const srcStatus = path.source ? status?.inputs[path.source.id] : undefined;
  const destStatus = status?.outputs[path.destination.id];
  const pathHealth = worstHealth(srcStatus?.health, destStatus?.health);
  const hasStatus = !!srcStatus || !!destStatus;

  return (
    <div className={`data-path-card ${path.disabled ? 'disabled-source' : ''}`}>
      <div className="data-path-header" onClick={onToggle}>
        <div className="data-path-flow">
          <span className="data-type-label">{displayName}</span>
          <span className="flow-detail">
            {path.sourceDisplay}
            <span className="flow-arrow">→</span>
            {path.pipeline && <>{path.pipeline.id}<span className="flow-arrow">→</span></>}
            {path.stitch && (
              <>
                <span className="routing-hop" title="Handed back to the worker group routing table">{path.stitch.viaLabel}</span>
                <span className="flow-arrow">→</span>
                {path.stitch.groupPipeline && <>{path.stitch.groupPipeline.id}<span className="flow-arrow">→</span></>}
              </>
            )}
            {path.destination.type}:{path.destination.id}
          </span>
        </div>
        <div className="data-path-meta">
          {metadata.owner && (
            <span className="owner-label">{metadata.owner}</span>
          )}
          <CriticalityBadge level={metadata.criticality} />
          {path.pack && <span className="pack-badge" title={`Defined in pack: ${path.pack}`}>📦 {path.pack}</span>}
          {path.stitch && <span className="stitch-badge" title="Pack routes back through the worker group routing table">↩ via routing table</span>}
          {path.kind === 'quickconnect' && <span className="quickconnect-badge">QuickConnect</span>}
          {path.disabled && <span className="disabled-badge">Disabled</span>}
          {hasStatus && <HealthDot health={pathHealth} title={`Source: ${srcStatus?.health ?? 'n/a'} · Destination: ${destStatus?.health ?? 'n/a'}`} />}
          <span className={`chevron ${expanded ? 'expanded' : ''}`}>&#9654;</span>
        </div>
      </div>
      {expanded && (
        <div className="data-path-detail">
          {hasStatus && (
            <div className="status-detail">
              <div className="status-row">
                <span className="detail-label">Source:</span>
                {srcStatus ? (
                  <span><HealthDot health={srcStatus.health} /> {srcStatus.health}</span>
                ) : <span className="status-na">no status</span>}
              </div>
              <div className="status-row">
                <span className="detail-label">Destination:</span>
                {destStatus ? (
                  <span><HealthDot health={destStatus.health} /> {destStatus.health}</span>
                ) : <span className="status-na">no status</span>}
              </div>
              {(srcStatus?.errorMessage || destStatus?.errorMessage) && (
                <div className="status-row status-error-row">
                  <span className="detail-label">Error:</span>
                  <span>{srcStatus?.errorMessage || destStatus?.errorMessage}</span>
                </div>
              )}
            </div>
          )}

          <MetadataEditor pathKey={pathKey} metadata={metadata} onSave={onSaveMetadata} />

          {path.route?.description && (
            <div className="route-description">
              <span className="detail-label">Route Description:</span>
              <span>{path.route.description}</span>
            </div>
          )}

          {path.pipeline?.conf?.description && (
            <div className="route-description">
              <span className="detail-label">Pipeline Description:</span>
              <span>{path.pipeline.conf.description}</span>
            </div>
          )}

          {path.route?.filter && path.route.filter !== 'true' && (
            <div className="route-filter-detail">
              <span className="detail-label">{path.stitch ? 'Pack Route Filter:' : 'Route Filter:'}</span>
              <code>{path.route.filter}</code>
            </div>
          )}

          {path.stitch && (
            <>
              <div className="route-description">
                <span className="detail-label">Group Route:</span>
                <span>{path.stitch.groupRoute.name} (re-admits pack via routing table)</span>
              </div>
              {path.stitch.groupRoute.filter && path.stitch.groupRoute.filter !== 'true' && (
                <div className="route-filter-detail">
                  <span className="detail-label">Group Route Filter:</span>
                  <code>{path.stitch.groupRoute.filter}</code>
                </div>
              )}
            </>
          )}

          <div className="field-explorer-section">
            {!showExplorer ? (
              <button className="field-explorer-btn" onClick={() => setShowExplorer(true)}>
                🔍 Field Explorer
              </button>
            ) : (
              <FieldExplorer groupId={groupId} path={path} />
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function groupPaths(
  paths: DataPath[],
  groupBy: GroupBy,
  metadataStore: MetadataStore
): { label: string; paths: DataPath[] }[] {
  if (groupBy === 'none') {
    return [{ label: '', paths }];
  }

  const groups = new Map<string, DataPath[]>();

  for (const path of paths) {
    const key = pathKeyOf(path);
    const meta = metadataStore[key];
    let groupKey: string;

    if (groupBy === 'owner') {
      groupKey = meta?.owner || 'Unassigned';
    } else if (groupBy === 'destination') {
      groupKey = `${path.destination.type}:${path.destination.id}`;
    } else {
      groupKey = meta?.criticality || '';
    }

    if (!groups.has(groupKey)) groups.set(groupKey, []);
    groups.get(groupKey)!.push(path);
  }

  const entries = Array.from(groups.entries()).map(([label, paths]) => ({
    label: label || 'Not set',
    paths,
  }));

  if (groupBy === 'criticality') {
    entries.sort((a, b) => {
      const aKey = a.label === 'Not set' ? '' : a.label;
      const bKey = b.label === 'Not set' ? '' : b.label;
      return (CRITICALITY_ORDER[aKey] ?? 99) - (CRITICALITY_ORDER[bKey] ?? 99);
    });
  } else {
    entries.sort((a, b) => {
      if (a.label === 'Unassigned') return 1;
      if (b.label === 'Unassigned') return -1;
      return a.label.localeCompare(b.label);
    });
  }

  return entries;
}

const EXPORT_FORMATS: { value: ExportFormat; label: string }[] = [
  { value: 'csv', label: 'CSV' },
  { value: 'json', label: 'JSON' },
  { value: 'markdown', label: 'Markdown' },
];

// Dropdown that exports the currently visible data paths. Disabled when there's
// nothing to export. Closes on outside click or Escape.
function ExportMenu({
  disabled,
  onExport,
}: {
  disabled: boolean;
  onExport: (format: ExportFormat) => void;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    function onDown(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') setOpen(false);
    }
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  return (
    <div className="export-menu" ref={ref}>
      <button
        className="export-btn"
        onClick={() => setOpen(o => !o)}
        disabled={disabled}
        title={disabled ? 'No data paths to export' : 'Export the visible data paths'}
      >
        Export ▾
      </button>
      {open && (
        <div className="export-dropdown">
          {EXPORT_FORMATS.map(f => (
            <button
              key={f.value}
              className="export-option"
              onClick={() => { onExport(f.value); setOpen(false); }}
            >
              {f.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function App() {
  const [groups, setGroups] = useState<WorkerGroup[]>([]);
  // Per-group dictionaries, loaded lazily on selection and cached.
  const [dictCache, setDictCache] = useState<Record<string, GroupDataDictionary>>({});
  const [metadataStore, setMetadataStore] = useState<MetadataStore>({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selectedGroupId, setSelectedGroupId] = useState<string | null>(null);
  const [expandedPaths, setExpandedPaths] = useState<Set<string>>(new Set());
  const [searchTerm, setSearchTerm] = useState('');
  const [showDisabled, setShowDisabled] = useState(false);
  const [groupByMode, setGroupByMode] = useState<GroupBy>('none');
  const [saveStatus, setSaveStatus] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle');

  // Load the lightweight group list + metadata, then auto-select the first group.
  // Runs once on mount; `loading` already starts true, so no synchronous
  // setState is needed before the first await.
  async function loadGroupList() {
    try {
      const [groupList, meta] = await Promise.all([loadGroups(), loadMetadata()]);
      setGroups(groupList);
      setMetadataStore(meta);
      if (groupList.length > 0) {
        selectGroup(groupList[0]);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load groups');
    } finally {
      setLoading(false);
    }
  }

  // Tracks groups already loaded so we dedupe fetches across re-selections.
  const loadedRef = useRef<Set<string>>(new Set());

  // Fetch a single group's dictionary on demand. Takes the group object
  // directly (no stale-closure over `groups`). `force` bypasses the cache.
  const loadGroupData = useCallback(async (group: WorkerGroup, force = false) => {
    if (!force && loadedRef.current.has(group.id)) return;
    loadedRef.current.add(group.id);
    try {
      const dict = await loadGroupDataDictionary(group);
      setDictCache(prev => ({ ...prev, [group.id]: dict }));
      setError(null);
    } catch (e) {
      loadedRef.current.delete(group.id); // allow retry
      setError(e instanceof Error ? e.message : `Failed to load group ${group.id}`);
    }
  }, []);

  // Select a group and kick off its (lazy, cached) data load.
  function selectGroup(group: WorkerGroup) {
    setSelectedGroupId(group.id);
    void loadGroupData(group);
  }

  function refresh() {
    const group = groups.find(g => g.id === selectedGroupId);
    if (group) void loadGroupData(group, true);
  }

  // Load the group list once on mount. loadGroupList's setState calls all run
  // after an await (not synchronously), so the cascade rule is a false positive.
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void loadGroupList();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleSaveMetadata = useCallback(async (key: string, meta: DataPathMetadata) => {
    const updated = { ...metadataStore, [key]: meta };
    if (!meta.owner && !meta.criticality && !meta.notes && !meta.dataSourceLabel) {
      delete updated[key];
    }
    setMetadataStore(updated);
    setSaveStatus('saving');
    try {
      await saveMetadata(updated);
      setSaveStatus('saved');
      setTimeout(() => setSaveStatus('idle'), 2000);
    } catch {
      setSaveStatus('error');
    }
  }, [metadataStore]);

  function togglePath(key: string) {
    setExpandedPaths(prev => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }

  const selectedGroup = selectedGroupId ? dictCache[selectedGroupId] : undefined;
  const groupLoading = !!selectedGroupId && !selectedGroup && !error;

  const filteredPaths = selectedGroup?.dataPaths.filter(path => {
    if (!showDisabled && path.disabled) return false;

    if (!searchTerm) return true;
    const term = searchTerm.toLowerCase();
    const key = pathKeyOf(path);
    const meta = metadataStore[key];
    return (
      path.dataType.toLowerCase().includes(term) ||
      path.sourceDisplay.toLowerCase().includes(term) ||
      path.source?.id.toLowerCase().includes(term) ||
      path.source?.type.toLowerCase().includes(term) ||
      path.destination.id.toLowerCase().includes(term) ||
      path.destination.type.toLowerCase().includes(term) ||
      path.pack?.toLowerCase().includes(term) ||
      path.stitch?.groupRoute.name?.toLowerCase().includes(term) ||
      path.route?.name?.toLowerCase().includes(term) ||
      path.route?.description?.toLowerCase().includes(term) ||
      path.pipeline?.id.toLowerCase().includes(term) ||
      meta?.owner?.toLowerCase().includes(term) ||
      meta?.dataSourceLabel?.toLowerCase().includes(term) ||
      meta?.criticality?.toLowerCase().includes(term)
    );
  }) ?? [];

  const grouped = groupPaths(filteredPaths, groupByMode, metadataStore);

  // Export the currently visible paths. Defined here (not memoized) so it closes
  // over the freshly computed `filteredPaths` each render.
  function handleExport(format: ExportFormat) {
    if (!selectedGroup) return;
    const groupName = selectedGroup.group.name || selectedGroup.group.id;
    downloadExport(format, filteredPaths, metadataStore, selectedGroup.status, groupName);
  }

  if (loading) {
    return (
      <div className="page">
        <div className="loading">
          <div className="spinner" />
          <p>Loading data dictionary...</p>
        </div>
      </div>
    );
  }

  if (error && groups.length === 0) {
    return (
      <div className="page">
        <div className="error-box">
          <p>{error}</p>
          <button onClick={loadGroupList}>Retry</button>
        </div>
      </div>
    );
  }

  const activeSourceCount = selectedGroup?.sources.filter(s => !s.disabled).length ?? 0;
  const totalSourceCount = selectedGroup?.sources.length ?? 0;

  return (
    <div className="page">
      <header className="header">
        <h1>Data Dictionary</h1>
        <div className="header-controls">
          <select
            className="group-select"
            value={selectedGroupId || ''}
            onChange={e => {
              const group = groups.find(g => g.id === e.target.value);
              if (group) selectGroup(group);
            }}
          >
            {groups.map(group => (
              <option key={group.id} value={group.id}>
                {group.name || group.id}
              </option>
            ))}
          </select>
          <div className="view-toggle">
            <button
              className={`toggle-btn ${!showDisabled ? 'active' : ''}`}
              onClick={() => setShowDisabled(false)}
            >
              Active
            </button>
            <button
              className={`toggle-btn ${showDisabled ? 'active' : ''}`}
              onClick={() => setShowDisabled(true)}
            >
              All
            </button>
          </div>
          <div className="group-by-control">
            <span className="group-by-label">Group by:</span>
            <div className="view-toggle">
              <button
                className={`toggle-btn ${groupByMode === 'none' ? 'active' : ''}`}
                onClick={() => setGroupByMode('none')}
              >
                None
              </button>
              <button
                className={`toggle-btn ${groupByMode === 'owner' ? 'active' : ''}`}
                onClick={() => setGroupByMode('owner')}
              >
                Owner
              </button>
              <button
                className={`toggle-btn ${groupByMode === 'criticality' ? 'active' : ''}`}
                onClick={() => setGroupByMode('criticality')}
              >
                Criticality
              </button>
              <button
                className={`toggle-btn ${groupByMode === 'destination' ? 'active' : ''}`}
                onClick={() => setGroupByMode('destination')}
              >
                Destination
              </button>
            </div>
          </div>
          <button className="refresh-btn" onClick={refresh}>Refresh</button>
          <ExportMenu disabled={filteredPaths.length === 0} onExport={handleExport} />
          {saveStatus === 'saving' && <span className="save-indicator saving">Saving...</span>}
          {saveStatus === 'saved' && <span className="save-indicator saved">Saved</span>}
          {saveStatus === 'error' && <span className="save-indicator error">Save failed</span>}
        </div>
      </header>

      <div className="search-bar">
        <input
          type="text"
          placeholder="Search sources, destinations, pipelines, owners..."
          value={searchTerm}
          onChange={e => setSearchTerm(e.target.value)}
        />
        {searchTerm && (
          <button className="clear-btn" onClick={() => setSearchTerm('')}>&#10005;</button>
        )}
      </div>

      {selectedGroup && (
        <div className="stats-bar">
          <span className="stat">{activeSourceCount} active sources{showDisabled ? ` (${totalSourceCount} total)` : ''}</span>
          <span className="stat">{selectedGroup.destinations.length} destinations</span>
          <span className="stat">{filteredPaths.length} data paths</span>
        </div>
      )}

      {selectedGroup && <CoverageBanner dict={selectedGroup} />}

      {error && groups.length > 0 && (
        <div className="error-box inline">
          <p>{error}</p>
          <button onClick={refresh}>Retry</button>
        </div>
      )}

      {groupLoading ? (
        <div className="loading">
          <div className="spinner" />
          <p>Loading {groups.find(g => g.id === selectedGroupId)?.name || 'group'}…</p>
        </div>
      ) : selectedGroup ? (
        <section className="paths-section">
          {filteredPaths.length === 0 ? (
            <div className="empty">No matching data paths found.</div>
          ) : (
            grouped.map(group => (
              <div key={group.label} className="path-group">
                {groupByMode !== 'none' && (
                  <div className="path-group-header">
                    <span className="path-group-title">{group.label}</span>
                    <span className="path-group-count">{group.paths.length}</span>
                  </div>
                )}
                {group.paths.map((path, i) => {
                  const key = pathKeyOf(path);
                  return (
                    <DataPathCard
                      key={key + i}
                      path={path}
                      expanded={expandedPaths.has(key)}
                      onToggle={() => togglePath(key)}
                      metadata={metadataStore[key] || {}}
                      pathKey={key}
                      groupId={selectedGroup.group.id}
                      status={selectedGroup.status}
                      onSaveMetadata={handleSaveMetadata}
                    />
                  );
                })}
              </div>
            ))
          )}
        </section>
      ) : null}

      {groups.length === 0 && (
        <div className="empty">No worker groups found.</div>
      )}
    </div>
  );
}

export default App;
