import { useEffect, useState } from 'react';
import { useData, useLive } from '../api.js';
import { go } from '../App.jsx';

// The flow view: how a department (or the whole organisation) is wired, drawn like a workflow.
// Columns: inputs → brain → teams → process → outputs → connectors. Edges light up while data moves.
const COL_W = 214;
const NODE_W = 186;
const NODE_H = 58;
const GAP = 22;
const TOP = 62;
const LEFT = 24;
const TYPE_COL = { input: 0, brain: 1, team: 2, process: 3, output: 4, connector: 5 };
const SECTION = { receives: 'Receives', thinks: 'How it thinks', does: 'What it does', team: 'Team', kpis: 'KPIs', current: 'Right now' };

const cut = (s, n) => (String(s ?? '').length > n ? `${String(s).slice(0, n - 1)}…` : String(s ?? ''));

export default function Flow({ ctx, deptId = null }) {
  const url = deptId ? `/api/flow?dept=${deptId}` : ctx.orgId ? `/api/flow?org=${ctx.orgId}` : null;
  const flow = useData(url, [url]);
  const [selected, setSelected] = useState(null);
  useLive((ev) => ['activity', 'tasks', 'approvals', 'operator', 'company', 'status'].includes(ev.type) && flow.reload());
  useEffect(() => {
    const t = setInterval(() => flow.reload(), 8000);
    return () => clearInterval(t);
  }, [url]);
  useEffect(() => setSelected(null), [url]);
  const f = flow.data;
  if (!f) return null;

  // Layout: one column per node type, each column centred vertically.
  const cols = {};
  for (const n of f.nodes) (cols[TYPE_COL[n.type] ?? 3] ??= []).push(n);
  const maxRows = Math.max(...Object.values(cols).map((l) => l.length), 1);
  const height = TOP + maxRows * (NODE_H + GAP) + 40;
  const width = LEFT * 2 + 6 * COL_W - (COL_W - NODE_W);
  const pos = {};
  for (const [c, list] of Object.entries(cols)) {
    const offset = ((maxRows - list.length) * (NODE_H + GAP)) / 2;
    list.forEach((n, i) => (pos[n.id] = { x: LEFT + Number(c) * COL_W, y: TOP + offset + i * (NODE_H + GAP) }));
  }
  const path = (e) => {
    const a = pos[e.from];
    const b = pos[e.to];
    if (!a || !b) return null;
    if (e.back) {
      const yb = height - 16;
      return `M ${a.x + NODE_W / 2} ${a.y + NODE_H} C ${a.x + NODE_W / 2} ${yb}, ${b.x + NODE_W / 2} ${yb}, ${b.x + NODE_W / 2} ${b.y + NODE_H}`;
    }
    const x1 = a.x + NODE_W;
    const y1 = a.y + NODE_H / 2;
    const x2 = b.x;
    const y2 = b.y + NODE_H / 2;
    const dx = Math.max(36, (x2 - x1) / 2);
    return `M ${x1} ${y1} C ${x1 + dx} ${y1}, ${x2 - dx} ${y2}, ${x2} ${y2}`;
  };
  const sel = f.nodes.find((n) => n.id === selected) ?? f.nodes.find((n) => n.type === 'brain');
  const liveEdges = f.edges.filter((e) => e.live).length;

  return (
    <div className="page-pad col" style={{ gap: 12 }}>
      <div className="row between">
        <nav className="crumbs" aria-label="Breadcrumb">
          <a href="#/">HOME</a> › <a href="#/map">{(ctx.orgs.find((o) => o.id === ctx.orgId)?.name ?? 'ORGANISATION').toUpperCase()}</a> › {f.departmentId ? <a href="#/flow">FLOW</a> : <span className="here">FLOW</span>}
          {f.departmentId ? (
            <>
              {' '}
              › <span className="here">{f.title.toUpperCase()}</span>
            </>
          ) : null}
        </nav>
        <div className="row small mono muted">
          <span>
            <span className="dot working" /> LIVE = data moving now
          </span>
          <span style={{ color: 'var(--warn)' }}>◌ MISSING</span>
          <span>{liveEdges} live link{liveEdges === 1 ? '' : 's'}</span>
        </div>
      </div>
      <div style={{ display: 'flex', gap: 16, alignItems: 'flex-start' }}>
        <div className="panel" style={{ flex: 1, overflow: 'auto', padding: 0, minHeight: 320 }}>
          <svg viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="xMinYMin meet" style={{ display: 'block', width: '100%', height: 'auto' }} role="img" aria-label={`Flow of ${f.title}`}>
            <defs>
              <marker id="arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
                <path d="M0 0L10 5L0 10z" fill="var(--line)" />
              </marker>
              <marker id="arrow-live" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
                <path d="M0 0L10 5L0 10z" fill="var(--p)" />
              </marker>
            </defs>
            {f.columns.map((c, i) => (
              <text key={c} x={LEFT + i * COL_W + NODE_W / 2} y={TOP - 30} textAnchor="middle" className="flow-col">
                {c.toUpperCase()}
              </text>
            ))}
            {f.edges.map((e, i) => {
              const d = path(e);
              return d ? <path key={i} d={d} className={`flow-edge ${e.live ? 'live' : ''} ${e.back ? 'back' : ''}`} markerEnd={`url(#${e.live ? 'arrow-live' : 'arrow'})`} /> : null;
            })}
            {f.nodes.map((n) => {
              const p = pos[n.id];
              const on = sel?.id === n.id;
              return (
                <g key={n.id} className={`flow-node ${n.status} ${on ? 'selected' : ''}`} transform={`translate(${p.x} ${p.y})`} onClick={() => setSelected(n.id)} onDoubleClick={() => n.link && go(n.link)} style={n.color ? { '--node': n.color } : undefined}>
                  <rect width={NODE_W} height={NODE_H} rx="4" />
                  <circle cx="14" cy="16" r="4" className="flow-dot" />
                  <text x="26" y="20" className="flow-title">
                    {cut(n.label, 22)}
                  </text>
                  <text x="14" y="42" className="flow-sub">
                    {cut(n.sub, 30)}
                  </text>
                </g>
              );
            })}
          </svg>
        </div>
        <aside className="panel col" style={{ width: 340, flexShrink: 0, gap: 10, maxHeight: 'calc(100vh - 140px)', overflow: 'auto' }}>
          {sel ? (
            <>
              <div>
                <span className="label dim">{sel.type === 'brain' ? 'Brain' : sel.type === 'team' ? (f.departmentId ? 'Team' : 'Department') : sel.type}</span>
                <div style={{ fontFamily: 'var(--display)', fontWeight: 700, fontSize: 20, letterSpacing: '0.06em' }}>{sel.label}</div>
                <div className="small mono" style={{ color: sel.status === 'live' ? 'var(--p)' : sel.status === 'missing' ? 'var(--warn)' : 'var(--muted)' }}>
                  {sel.status === 'live' ? '● LIVE' : sel.status === 'missing' ? '◌ MISSING' : '○ IDLE'} · {sel.sub}
                </div>
              </div>
              {Object.entries(SECTION).map(([key, title]) => {
                const rows = sel.detail?.[key];
                const list = Array.isArray(rows) ? rows : rows ? [rows] : [];
                if (!list.length) return null;
                return (
                  <div key={key} className="col" style={{ gap: 4 }}>
                    <span className="label">▶ {title}</span>
                    {list.map((r, i) => (
                      <div key={i} className="small" style={{ lineHeight: 1.5, color: key === 'current' ? 'var(--text)' : 'var(--muted)', whiteSpace: 'pre-wrap' }}>
                        {r}
                      </div>
                    ))}
                  </div>
                );
              })}
              {sel.link && (
                <button type="button" className="btn small" style={{ alignSelf: 'flex-start' }} onClick={() => go(sel.link)}>
                  Open ›
                </button>
              )}
            </>
          ) : (
            <div className="faint small">Click a node to see what it receives, how it thinks and what it does.</div>
          )}
        </aside>
      </div>
      <div className="small faint">Double-click a department or team to open it. The graph refreshes by itself as agents work.</div>
    </div>
  );
}
