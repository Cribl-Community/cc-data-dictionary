import { useEffect, useState, useCallback, useRef } from 'react';
import { loadGroups, loadGroupDataDictionary, buildCaptureFilter } from './dataPathBuilder';
import { loadMetadata, saveMetadata, applyMetadataEdit, pathKeyOf, metaFor } from './metadata';
import { mapWithConcurrency } from './concurrency';
import { captureEvents } from './api';
import { analyzeFields } from './fieldAnalysis';
import { downloadExport } from './export';
import type { ExportFormat, StatusByGroup } from './export';
import type { FieldStat } from './fieldAnalysis';
import type { GroupDataDictionary, DataPath, WorkerGroup, Health, GroupStatus } from './types';
import type { MetadataStore, DataPathMetadata } from './metadata';

// Capture stages exposed by the Field Explorer (Cribl capture `level`).
const CAPTURE_LEVELS: { value: number; label: string }[] = [
  { value: 1, label: 'Before Routes' },
  { value: 2, label: 'Before Post-Processing Pipeline' },
  { value: 3, label: 'Before Destination' },
];

// Sentinel for the worker-group selector's "All worker groups" option. Never sent
// to the API — the loader expands it to the real group ids.
const ALL_GROUPS = '__all__';

// How many worker groups to load at once. Each group costs six API calls plus
// five per installed pack; a wider burst makes the Leader report that the config
// helper cannot be booted because it is under load.
const GROUP_FETCH_CONCURRENCY = 3;

type Criticality = 'low' | 'medium' | 'high' | 'critical';
type GroupBy = 'none' | 'workerGroup' | 'owner' | 'criticality' | 'destination';

const CRITICALITY_ORDER: Record<string, number> = {
  critical: 0,
  high: 1,
  medium: 2,
  low: 3,
  '': 4,
};

// Colour comes from a CSS class, not an inline style: an inline background is
// unreachable by the theme, so a dark-mode palette can't touch it.
function CriticalityBadge({ level }: { level?: Criticality }) {
  if (!level) return null;
  return <span className={`criticality-badge criticality-${level}`}>{level}</span>;
}

function MetadataEditor({
  metadata,
  onSave,
}: {
  metadata: DataPathMetadata;
  onSave: (meta: DataPathMetadata) => void;
}) {
  const [owner, setOwner] = useState(metadata.owner || '');
  const [criticality, setCriticality] = useState<Criticality | ''>(metadata.criticality || '');
  const [notes, setNotes] = useState(metadata.notes || '');
  const [dataSourceLabel, setDataSourceLabel] = useState(metadata.dataSourceLabel || '');
  const [dirty, setDirty] = useState(false);

  function handleSave() {
    onSave({
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

function HealthDot({ health, title }: { health: Health; title?: string }) {
  return (
    <span
      className={`health-dot health-${health.toLowerCase()}`}
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

// One coverage gap, carrying the group it was found in so the banner can
// aggregate across every visible group without losing attribution.
interface CoverageChip {
  key: string;
  label: string;
  groupName: string;
}

// Flatten each visible group's coverage into labelled chips. Coverage is computed
// per group (a source is only orphaned relative to its own group's routes), so
// the aggregate is a concatenation, not a recomputation.
function collectCoverage(dicts: GroupDataDictionary[]): { orphans: CoverageChip[]; unused: CoverageChip[] } {
  const orphans: CoverageChip[] = [];
  const unused: CoverageChip[] = [];
  for (const dict of dicts) {
    const groupName = dict.group.name || dict.group.id;
    for (const s of dict.coverage.orphanedSources) {
      orphans.push({ key: `${dict.group.id}::${s.id}`, label: `${s.type}:${s.id}`, groupName });
    }
    for (const d of dict.coverage.unusedDestinations) {
      unused.push({ key: `${dict.group.id}::${d.id}`, label: `${d.type}:${d.id}`, groupName });
    }
  }
  return { orphans, unused };
}

function CoverageBanner({ dicts }: { dicts: GroupDataDictionary[] }) {
  const [open, setOpen] = useState(false);
  const { orphans, unused } = collectCoverage(dicts);
  const total = orphans.length + unused.length;
  if (total === 0) return null;

  // With one group on screen the group name is redundant; across groups it's the
  // only way to know where to go fix the gap.
  const showGroup = dicts.length > 1;
  const chip = (c: CoverageChip) => (
    <span key={c.key} className="coverage-chip">
      {showGroup && <span className="coverage-chip-group">{c.groupName}</span>}
      {c.label}
    </span>
  );

  return (
    <div className="coverage-banner">
      <div className="coverage-summary" onClick={() => setOpen(o => !o)}>
        <span className="coverage-icon">⚠️</span>
        <span className="coverage-text">
          {orphans.length > 0 && `${orphans.length} orphaned source${orphans.length > 1 ? 's' : ''}`}
          {orphans.length > 0 && unused.length > 0 && ' · '}
          {unused.length > 0 && `${unused.length} unused destination${unused.length > 1 ? 's' : ''}`}
        </span>
        <span className={`chevron ${open ? 'expanded' : ''}`}>&#9654;</span>
      </div>
      {open && (
        <div className="coverage-detail">
          {orphans.length > 0 && (
            <div className="coverage-group">
              <span className="detail-label">Sources with no outgoing path:</span>
              <div className="coverage-chips">{orphans.map(chip)}</div>
            </div>
          )}
          {unused.length > 0 && (
            <div className="coverage-group">
              <span className="detail-label">Destinations nothing routes to:</span>
              <div className="coverage-chips">{unused.map(chip)}</div>
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
  showGroup,
  status,
  onSaveMetadata,
}: {
  path: DataPath;
  expanded: boolean;
  onToggle: () => void;
  metadata: DataPathMetadata;
  // Badge the card with its worker group — on when the list mixes groups and
  // isn't already sectioned by them.
  showGroup: boolean;
  // Status for this path's OWN group. Entity ids are only unique within a group,
  // so a merged map would mis-attribute health across groups.
  status?: GroupStatus;
  onSaveMetadata: (path: DataPath, meta: DataPathMetadata) => void;
}) {
  const displayName = metadata.dataSourceLabel || path.dataType;
  const [showExplorer, setShowExplorer] = useState(false);

  const srcStatus = path.source ? status?.inputs[path.source.id] : undefined;
  const destStatus = status?.outputs[path.destination.id];
  const pathHealth = worstHealth(srcStatus?.health, destStatus?.health);
  const hasStatus = !!srcStatus || !!destStatus;

  return (
    <div className={`data-path-card ${path.disabled ? 'disabled-source' : ''}`}>
      <div className={`data-path-header ${expanded ? 'expanded' : ''}`} onClick={onToggle}>
        <div className="data-path-flow">
          {/* Truncated to one line when collapsed, so the tooltip is the way to
              read a long label (a route filter) without expanding the card. */}
          <span className="data-type-label" title={expanded ? undefined : displayName}>
            {displayName}
          </span>
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
          {showGroup && <span className="group-badge" title={`Worker group: ${path.groupName}`}>{path.groupName}</span>}
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

          <MetadataEditor metadata={metadata} onSave={meta => onSaveMetadata(path, meta)} />

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
              /* Captures must hit the path's own worker group, not whichever one
                 happens to be first in an all-groups list. */
              <FieldExplorer groupId={path.groupId} path={path} />
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
    const meta = metaFor(metadataStore, path);
    let groupKey: string;

    if (groupBy === 'workerGroup') {
      groupKey = path.groupName;
    } else if (groupBy === 'owner') {
      groupKey = meta.owner || 'Unassigned';
    } else if (groupBy === 'destination') {
      groupKey = `${path.destination.type}:${path.destination.id}`;
    } else {
      groupKey = meta.criticality || '';
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

type Theme = 'light' | 'dark';

const THEME_KEY = 'data-dictionary:theme';
const DARK_QUERY = '(prefers-color-scheme: dark)';

// Only 'light'/'dark' count; anything else means the user hasn't chosen and we
// should follow the OS. Reads can throw in a sandboxed iframe, so guard them.
function readStoredTheme(): Theme | null {
  try {
    const stored = window.localStorage.getItem(THEME_KEY);
    return stored === 'light' || stored === 'dark' ? stored : null;
  } catch {
    return null;
  }
}

function systemTheme(): Theme {
  return window.matchMedia?.(DARK_QUERY).matches ? 'dark' : 'light';
}

/**
 * Current theme, applied to <html data-theme> so the CSS token blocks can pick
 * it up. Follows the OS until the user picks one, then remembers the choice.
 *
 * Note the app is in an iframe, so `prefers-color-scheme` reflects the OS/browser
 * setting, NOT whatever theme the surrounding Cribl UI is set to — the platform
 * exposes no theme signal. Hence the manual toggle: following the system alone
 * would strand anyone running Cribl dark on a light OS, or the reverse.
 */
function useTheme(): [Theme, () => void] {
  const [theme, setTheme] = useState<Theme>(() => readStoredTheme() ?? systemTheme());
  // Whether we're still tracking the OS. A stored choice outranks it.
  const [followSystem, setFollowSystem] = useState(() => readStoredTheme() === null);

  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme);
  }, [theme]);

  useEffect(() => {
    if (!followSystem || !window.matchMedia) return;
    const mq = window.matchMedia(DARK_QUERY);
    const onChange = (e: MediaQueryListEvent) => setTheme(e.matches ? 'dark' : 'light');
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, [followSystem]);

  const toggle = useCallback(() => {
    setTheme(prev => {
      const next: Theme = prev === 'dark' ? 'light' : 'dark';
      try {
        window.localStorage.setItem(THEME_KEY, next);
      } catch {
        // The theme still applies for this session; it just won't be remembered.
      }
      return next;
    });
    setFollowSystem(false);
  }, []);

  return [theme, toggle];
}

// Inline SVG rather than ☀/🌙: those render as full-colour emoji on some
// platforms and as a bare glyph on others. `currentColor` also means the icon
// picks up the button's hover colour for free.
function SunIcon() {
  return (
    <svg viewBox="0 0 16 16" width="15" height="15" aria-hidden="true" focusable="false">
      <circle cx="8" cy="8" r="3.1" fill="currentColor" />
      <g stroke="currentColor" strokeWidth="1.4" strokeLinecap="round">
        <line x1="8" y1="0.9" x2="8" y2="2.5" />
        <line x1="8" y1="13.5" x2="8" y2="15.1" />
        <line x1="0.9" y1="8" x2="2.5" y2="8" />
        <line x1="13.5" y1="8" x2="15.1" y2="8" />
        <line x1="3.1" y1="3.1" x2="4.3" y2="4.3" />
        <line x1="11.7" y1="11.7" x2="12.9" y2="12.9" />
        <line x1="3.1" y1="12.9" x2="4.3" y2="11.7" />
        <line x1="11.7" y1="4.3" x2="12.9" y2="3.1" />
      </g>
    </svg>
  );
}

function MoonIcon() {
  return (
    <svg viewBox="0 0 16 16" width="15" height="15" aria-hidden="true" focusable="false">
      <path d="M13.8 10.6A6.2 6.2 0 0 1 5.4 2.2a6.2 6.2 0 1 0 8.4 8.4z" fill="currentColor" />
    </svg>
  );
}

// Shows the theme you'd switch TO, which is what the click does.
function ThemeToggle({ theme, onToggle }: { theme: Theme; onToggle: () => void }) {
  const label = theme === 'dark' ? 'Switch to light theme' : 'Switch to dark theme';
  return (
    <button className="theme-btn" onClick={onToggle} title={label} aria-label={label}>
      {theme === 'dark' ? <SunIcon /> : <MoonIcon />}
    </button>
  );
}

const INTRO_COLLAPSED_KEY = 'data-dictionary:intro-collapsed';

// The app runs in a sandboxed iframe, where touching localStorage can throw
// outright rather than just return null, depending on the embedder's storage
// policy. A remembered panel state is a nicety, so failure means "expanded".
function readIntroCollapsed(): boolean {
  try {
    return window.localStorage.getItem(INTRO_COLLAPSED_KEY) === '1';
  } catch {
    return false;
  }
}

function writeIntroCollapsed(collapsed: boolean): void {
  try {
    window.localStorage.setItem(INTRO_COLLAPSED_KEY, collapsed ? '1' : '0');
  } catch {
    // Nothing to do — the panel just reopens next time.
  }
}

/**
 * What this page is and how to read it. Expanded by default, because the naming
 * precedence isn't guessable from looking at the rows — but collapsible, and the
 * choice is remembered, so it doesn't nag people who already know.
 */
function IntroPanel() {
  const [collapsed, setCollapsed] = useState(readIntroCollapsed);

  function toggle() {
    const next = !collapsed;
    setCollapsed(next);
    writeIntroCollapsed(next);
  }

  return (
    <section className="intro-panel">
      <button className="intro-toggle" onClick={toggle} aria-expanded={!collapsed}>
        <span className={`chevron ${collapsed ? '' : 'expanded'}`}>&#9654;</span>
        <span className="intro-title">How the data dictionary works</span>
        <span className="intro-hint">{collapsed ? 'Show' : 'Hide'}</span>
      </button>

      {!collapsed && (
        <div className="intro-body">
          <p className="intro-lede">
            Each row is one <strong>data path</strong> — a single journey your events take
            through this deployment, from a source, through the Routes table (or a
            QuickConnect link), optionally via a pipeline, to a destination. One source
            usually appears in several paths, because different slices of its data are
            routed to different places.
          </p>

          <div className="intro-columns">
            <div className="intro-column">
              <h3>How each path gets its name</h3>
              <p className="intro-note">
                The bold title is the best available description of the data on that path.
                The first of these that exists wins:
              </p>
              <ol className="intro-list">
                <li>
                  <strong>Your Data Source Label</strong> — anything you type in the card
                  below always wins.
                </li>
                <li>
                  The <strong>route's description</strong>, as written in Cribl.
                </li>
                <li>
                  Any <strong><code>index</code> / <code>sourcetype</code></strong> values
                  found in the route filter.
                </li>
                <li>
                  The <strong>route filter</strong> itself, with the{' '}
                  <code>__inputId</code> part removed — that names the source, which the
                  grey line already shows.
                </li>
                <li>
                  The <strong>route name</strong>, for routes that aren't tied to one
                  source.
                </li>
                <li>
                  The <strong>source</strong> (<code>type:id</code>), or{' '}
                  <code>any source</code> for a filter-only route that any source's events
                  can match.
                </li>
              </ol>
              <p className="intro-note">
                So a title that reads as a raw filter expression means the route has no
                description in Cribl. Either add one there, or give the path a Data Source
                Label here.
              </p>
            </div>

            <div className="intro-column">
              <h3>Working with it</h3>
              <ul className="intro-list">
                <li>
                  <strong>Pick a worker group</strong>, or <strong>All worker groups</strong>{' '}
                  to audit the whole deployment at once. Groups appear as they load.
                </li>
                <li>
                  <strong>Click any path</strong> to annotate it with an owner, criticality,
                  and notes. These are saved centrally, so your whole team sees them.
                </li>
                <li>
                  <strong>Field Explorer</strong> (inside an expanded path) samples live
                  events at the stage you choose and reports the fields actually present,
                  with fill rates — the fastest way to answer "what's really in this feed?"
                </li>
                <li>
                  <strong>Group by Owner or Criticality</strong> to find unowned or
                  business-critical flows. In the all-groups scope these roll up across
                  worker groups.
                </li>
                <li>
                  A <strong>warning banner</strong> flags sources nothing routes out of and
                  destinations nothing routes to.
                </li>
                <li>
                  <strong>Export</strong> hands you whatever is currently on screen —
                  search and the Active/All filter included — as CSV, JSON, or Markdown.
                </li>
              </ul>
            </div>
          </div>
        </div>
      )}
    </section>
  );
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

// A worker group whose dictionary failed to load. Tracked per group so one
// unreadable fleet doesn't blank out the groups that loaded fine.
interface GroupFailure {
  id: string;
  name: string;
  message: string;
}

function App() {
  const [groups, setGroups] = useState<WorkerGroup[]>([]);
  // Per-group dictionaries, loaded lazily on selection and cached. The
  // all-worker-groups scope reads straight out of this same cache, so each group
  // is still fetched once and renders as soon as it lands.
  const [dictCache, setDictCache] = useState<Record<string, GroupDataDictionary>>({});
  const [metadataStore, setMetadataStore] = useState<MetadataStore>({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  // Either a worker group id or the ALL_GROUPS sentinel.
  const [scope, setScope] = useState<string | null>(null);
  const [loadingGroupIds, setLoadingGroupIds] = useState<Set<string>>(new Set());
  const [failedGroups, setFailedGroups] = useState<GroupFailure[]>([]);
  const [expandedPaths, setExpandedPaths] = useState<Set<string>>(new Set());
  const [searchTerm, setSearchTerm] = useState('');
  const [showDisabled, setShowDisabled] = useState(false);
  const [groupByMode, setGroupByMode] = useState<GroupBy>('none');
  const [saveStatus, setSaveStatus] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle');
  const [theme, toggleTheme] = useTheme();

  // Tracks groups already loaded so we dedupe fetches across re-selections.
  const loadedRef = useRef<Set<string>>(new Set());

  /**
   * Fetch the given groups' dictionaries, at most GROUP_FETCH_CONCURRENCY at a
   * time, writing each into the cache as it arrives so the list fills in
   * progressively rather than waiting on the slowest group. Takes the group
   * objects directly, so there's no stale closure over `groups`.
   *
   * Failures are per group: a group that errors lands in `failedGroups` and is
   * dropped from loadedRef so it can be retried, while the rest still render.
   */
  const loadGroupsData = useCallback(async (requested: WorkerGroup[], force = false) => {
    const targets = force ? requested : requested.filter(g => !loadedRef.current.has(g.id));
    if (targets.length === 0) return;

    for (const group of targets) loadedRef.current.add(group.id);
    setLoadingGroupIds(prev => {
      const next = new Set(prev);
      for (const group of targets) next.add(group.id);
      return next;
    });
    setFailedGroups(prev => prev.filter(f => !targets.some(t => t.id === f.id)));

    await mapWithConcurrency(targets, GROUP_FETCH_CONCURRENCY, async group => {
      try {
        const dict = await loadGroupDataDictionary(group);
        setDictCache(prev => ({ ...prev, [group.id]: dict }));
      } catch (e) {
        loadedRef.current.delete(group.id); // allow retry
        setFailedGroups(prev => [
          ...prev.filter(f => f.id !== group.id),
          {
            id: group.id,
            name: group.name || group.id,
            message: e instanceof Error ? e.message : 'Failed to load',
          },
        ]);
      } finally {
        setLoadingGroupIds(prev => {
          const next = new Set(prev);
          next.delete(group.id);
          return next;
        });
      }
    });
  }, []);

  // The groups a scope covers: every group for ALL_GROUPS, otherwise just the one.
  const groupsInScope = useCallback(
    (which: string, all: WorkerGroup[]) =>
      which === ALL_GROUPS ? all : all.filter(g => g.id === which),
    [],
  );

  // Load the lightweight group list + metadata, then auto-select the first group.
  // Runs once on mount; `loading` already starts true, so no synchronous
  // setState is needed before the first await.
  async function loadGroupList() {
    try {
      const [groupList, meta] = await Promise.all([loadGroups(), loadMetadata()]);
      setGroups(groupList);
      setMetadataStore(meta);
      if (groupList.length > 0) {
        setScope(groupList[0].id);
        void loadGroupsData([groupList[0]]);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load groups');
    } finally {
      setLoading(false);
    }
  }

  // Switch scope and kick off whatever it needs that isn't cached yet.
  function selectScope(next: string) {
    setScope(next);
    // Grouping by worker group is the point of the all-groups scope, so default
    // to it — but never override a grouping the user deliberately picked.
    setGroupByMode(mode => {
      if (next === ALL_GROUPS) return mode === 'none' ? 'workerGroup' : mode;
      return mode === 'workerGroup' ? 'none' : mode;
    });
    void loadGroupsData(groupsInScope(next, groups));
  }

  function refresh() {
    if (!scope) return;
    void loadGroupsData(groupsInScope(scope, groups), true);
  }

  function retryFailed() {
    const retryable = failedGroups
      .map(f => groups.find(g => g.id === f.id))
      .filter((g): g is WorkerGroup => !!g);
    void loadGroupsData(retryable, true);
  }

  // Load the group list once on mount.
  useEffect(() => {
    void loadGroupList();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleSaveMetadata = useCallback(async (path: DataPath, meta: DataPathMetadata) => {
    const updated = applyMetadataEdit(metadataStore, path, meta);
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

  const showingAll = scope === ALL_GROUPS;
  // Dictionaries currently on screen, in group-list order. An all-groups scope
  // shows whatever has loaded so far; the rest stream in.
  const visibleDicts = scope
    ? groupsInScope(scope, groups)
        .map(g => dictCache[g.id])
        .filter((d): d is GroupDataDictionary => !!d)
    : [];
  const scopeGroupCount = scope ? groupsInScope(scope, groups).length : 0;
  const anyLoading = loadingGroupIds.size > 0;
  // Nothing to show yet and still fetching — distinct from "loaded and empty".
  const scopeLoading = visibleDicts.length === 0 && anyLoading;

  // Status per group: ids are only unique within a group, so health must be
  // resolved against the path's own group rather than one merged map.
  const statusByGroup: StatusByGroup = {};
  for (const dict of visibleDicts) statusByGroup[dict.group.id] = dict.status;

  const allPaths = visibleDicts.flatMap(d => d.dataPaths);

  const filteredPaths = allPaths.filter(path => {
    if (!showDisabled && path.disabled) return false;

    if (!searchTerm) return true;
    const term = searchTerm.toLowerCase();
    const meta = metaFor(metadataStore, path);
    return (
      path.groupName.toLowerCase().includes(term) ||
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
      meta.owner?.toLowerCase().includes(term) ||
      meta.dataSourceLabel?.toLowerCase().includes(term) ||
      meta.criticality?.toLowerCase().includes(term)
    );
  });

  const grouped = groupPaths(filteredPaths, groupByMode, metadataStore);

  // What the export is titled and named after: the one group, or the whole scope.
  const scopeName = showingAll
    ? 'All worker groups'
    : visibleDicts[0]
      ? visibleDicts[0].group.name || visibleDicts[0].group.id
      : (scope ?? 'group');

  // Export the currently visible paths. Defined here (not memoized) so it closes
  // over the freshly computed `filteredPaths` each render.
  function handleExport(format: ExportFormat) {
    if (filteredPaths.length === 0) return;
    downloadExport(format, filteredPaths, metadataStore, statusByGroup, scopeName);
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

  // Counts across every group on screen.
  const activeSourceCount = visibleDicts.reduce(
    (n, d) => n + d.sources.filter(s => !s.disabled).length, 0,
  );
  const totalSourceCount = visibleDicts.reduce((n, d) => n + d.sources.length, 0);
  const destinationCount = visibleDicts.reduce((n, d) => n + d.destinations.length, 0);

  return (
    <div className="page">
      <header className="header">
        <h1>Data Dictionary</h1>
        <div className="header-controls">
          <select
            className="group-select"
            value={scope || ''}
            onChange={e => selectScope(e.target.value)}
          >
            <option value={ALL_GROUPS}>All worker groups</option>
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
              {/* Only meaningful across groups — in a single-group scope it would
                  put every path under one header. */}
              {showingAll && (
                <button
                  className={`toggle-btn ${groupByMode === 'workerGroup' ? 'active' : ''}`}
                  onClick={() => setGroupByMode('workerGroup')}
                >
                  Worker Group
                </button>
              )}
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
          {/* Disabled mid-load: Refresh forces past the cache, so a second click
              would stack a duplicate fetch of every group in scope. */}
          <button className="refresh-btn" onClick={refresh} disabled={anyLoading}>
            {anyLoading ? 'Loading…' : 'Refresh'}
          </button>
          <ExportMenu disabled={filteredPaths.length === 0} onExport={handleExport} />
          <ThemeToggle theme={theme} onToggle={toggleTheme} />
          {saveStatus === 'saving' && <span className="save-indicator saving">Saving...</span>}
          {saveStatus === 'saved' && <span className="save-indicator saved">Saved</span>}
          {saveStatus === 'error' && <span className="save-indicator error">Save failed</span>}
        </div>
      </header>

      <IntroPanel />

      <div className="search-bar">
        <input
          type="text"
          placeholder="Search worker groups, sources, destinations, pipelines, owners..."
          value={searchTerm}
          onChange={e => setSearchTerm(e.target.value)}
        />
        {searchTerm && (
          <button className="clear-btn" onClick={() => setSearchTerm('')}>&#10005;</button>
        )}
      </div>

      {visibleDicts.length > 0 && (
        <div className="stats-bar">
          {showingAll && (
            <span className="stat">
              {visibleDicts.length} worker group{visibleDicts.length === 1 ? '' : 's'}
              {visibleDicts.length < scopeGroupCount ? ` of ${scopeGroupCount}` : ''}
            </span>
          )}
          <span className="stat">{activeSourceCount} active sources{showDisabled ? ` (${totalSourceCount} total)` : ''}</span>
          <span className="stat">{destinationCount} destinations</span>
          <span className="stat">{filteredPaths.length} data paths</span>
        </div>
      )}

      {visibleDicts.length > 0 && <CoverageBanner dicts={visibleDicts} />}

      {error && groups.length > 0 && (
        <div className="error-box inline">
          <p>{error}</p>
          <button onClick={refresh}>Retry</button>
        </div>
      )}

      {/* Per-group failures: the groups that did load stay on screen. */}
      {failedGroups.length > 0 && (
        <div className="load-failures">
          <div className="load-failures-text">
            <strong>
              {failedGroups.length} worker group{failedGroups.length === 1 ? '' : 's'} failed to load
            </strong>
            <ul>
              {failedGroups.map(f => (
                <li key={f.id}><span className="load-failure-group">{f.name}</span> — {f.message}</li>
              ))}
            </ul>
          </div>
          <button onClick={retryFailed} disabled={anyLoading}>Retry</button>
        </div>
      )}

      {/* Still fetching, but some groups have already rendered — keep them on
          screen and show progress rather than replacing everything with a spinner. */}
      {anyLoading && visibleDicts.length > 0 && (
        <div className="load-progress">
          <div className="spinner small" />
          <span>
            Loaded {visibleDicts.length} of {scopeGroupCount} worker
            group{scopeGroupCount === 1 ? '' : 's'}…
          </span>
        </div>
      )}

      {scopeLoading ? (
        <div className="loading">
          <div className="spinner" />
          <p>
            {showingAll
              ? `Loading ${scopeGroupCount} worker group${scopeGroupCount === 1 ? '' : 's'}…`
              : `Loading ${groups.find(g => g.id === scope)?.name || 'group'}…`}
          </p>
        </div>
      ) : visibleDicts.length > 0 ? (
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
                      metadata={metaFor(metadataStore, path)}
                      // Redundant once the list is already sectioned by group.
                      showGroup={showingAll && groupByMode !== 'workerGroup'}
                      status={statusByGroup[path.groupId]}
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
