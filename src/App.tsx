import { useEffect, useState, useCallback, useRef } from 'react';
import { loadGroupDataDictionary, buildCaptureFilter } from './dataPathBuilder';
import { loadMetadata, saveMetadata, getPathKey } from './metadata';
import { captureEvents } from './api';
import { analyzeFields } from './fieldAnalysis';
import type { FieldStat } from './fieldAnalysis';
import type { GroupDataDictionary, DataPath } from './types';
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

function DataPathCard({
  path,
  expanded,
  onToggle,
  metadata,
  pathKey,
  groupId,
  onSaveMetadata,
}: {
  path: DataPath;
  expanded: boolean;
  onToggle: () => void;
  metadata: DataPathMetadata;
  pathKey: string;
  groupId: string;
  onSaveMetadata: (key: string, meta: DataPathMetadata) => void;
}) {
  const displayName = metadata.dataSourceLabel || path.dataType;
  const [showExplorer, setShowExplorer] = useState(false);

  return (
    <div className={`data-path-card ${path.disabled ? 'disabled-source' : ''}`}>
      <div className="data-path-header" onClick={onToggle}>
        <div className="data-path-flow">
          <span className="data-type-label">{displayName}</span>
          <span className="flow-detail">
            {path.sourceDisplay}
            <span className="flow-arrow">→</span>
            {path.pipeline && <>{path.pipeline.id}<span className="flow-arrow">→</span></>}
            {path.destination.type}:{path.destination.id}
          </span>
        </div>
        <div className="data-path-meta">
          {metadata.owner && (
            <span className="owner-label">{metadata.owner}</span>
          )}
          <CriticalityBadge level={metadata.criticality} />
          {path.kind === 'quickconnect' && <span className="quickconnect-badge">QuickConnect</span>}
          {path.disabled && <span className="disabled-badge">Disabled</span>}
          <span className={`chevron ${expanded ? 'expanded' : ''}`}>&#9654;</span>
        </div>
      </div>
      {expanded && (
        <div className="data-path-detail">
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
              <span className="detail-label">Route Filter:</span>
              <code>{path.route.filter}</code>
            </div>
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

function App() {
  const [data, setData] = useState<GroupDataDictionary[]>([]);
  const [metadataStore, setMetadataStore] = useState<MetadataStore>({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selectedGroupId, setSelectedGroupId] = useState<string | null>(null);
  const [expandedPaths, setExpandedPaths] = useState<Set<string>>(new Set());
  const [searchTerm, setSearchTerm] = useState('');
  const [showDisabled, setShowDisabled] = useState(false);
  const [groupByMode, setGroupByMode] = useState<GroupBy>('none');
  const [saveStatus, setSaveStatus] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle');

  useEffect(() => {
    loadData();
  }, []);

  async function loadData() {
    try {
      setLoading(true);
      setError(null);
      const [results, meta] = await Promise.all([
        loadGroupDataDictionary(),
        loadMetadata(),
      ]);
      setData(results);
      setMetadataStore(meta);
      if (results.length > 0 && !selectedGroupId) {
        setSelectedGroupId(results[0].group.id);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load data');
    } finally {
      setLoading(false);
    }
  }

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

  const selectedGroup = data.find(g => g.group.id === selectedGroupId);

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
      path.route?.name?.toLowerCase().includes(term) ||
      path.route?.description?.toLowerCase().includes(term) ||
      path.pipeline?.id.toLowerCase().includes(term) ||
      meta?.owner?.toLowerCase().includes(term) ||
      meta?.dataSourceLabel?.toLowerCase().includes(term) ||
      meta?.criticality?.toLowerCase().includes(term)
    );
  }) ?? [];

  const grouped = groupPaths(filteredPaths, groupByMode, metadataStore);

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

  if (error) {
    return (
      <div className="page">
        <div className="error-box">
          <p>{error}</p>
          <button onClick={loadData}>Retry</button>
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
            onChange={e => setSelectedGroupId(e.target.value)}
          >
            {data.map(({ group }) => (
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
          <button className="refresh-btn" onClick={loadData}>Refresh</button>
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
                    groupId={selectedGroup!.group.id}
                    onSaveMetadata={handleSaveMetadata}
                  />
                );
              })}
            </div>
          ))
        )}
      </section>

      {data.length === 0 && (
        <div className="empty">No worker groups found.</div>
      )}
    </div>
  );
}

export default App;
