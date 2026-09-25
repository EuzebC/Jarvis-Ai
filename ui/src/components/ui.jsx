import { useEffect, useState } from 'react';

// ---------- icons (inline stroke SVG) ----------
const PATHS = {
  home: 'M3 11l9-7 9 7v9a1 1 0 0 1-1 1h-5v-6H9v6H4a1 1 0 0 1-1-1z',
  map: 'M3 6l6-3 6 3 6-3v15l-6 3-6-3-6 3zM9 3v15M15 6v15',
  approvals: 'M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6zM8.5 12l2.5 2.5 4.5-5',
  mind: 'M12 4a4 4 0 0 0-4 4 4 4 0 0 0-3 6 4 4 0 0 0 4 5h6a4 4 0 0 0 4-5 4 4 0 0 0-3-6 4 4 0 0 0-4-4zM12 8v11',
  settings: 'M4 7h10M18 7h2M4 17h4M12 17h8M16 5v4M10 15v4',
  mic: 'M9 3h6v11H9zM5 11a7 7 0 0 0 14 0M12 18v3',
  plus: 'M12 5v14M5 12h14',
  close: 'M6 6l12 12M18 6L6 18',
  download: 'M12 4v11M7 10l5 5 5-5M5 20h14',
  chevron: 'M6 9l6 6 6-6',
  stop: 'M6 6h12v12H6z',
  play: 'M7 5l12 7-12 7z',
  tasks: 'M9 6h11M9 12h11M9 18h11M4 6l1 1 2-2M4 12l1 1 2-2M4 18l1 1 2-2',
};
export function Icon({ name, size = 18 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d={PATHS[name]} />
    </svg>
  );
}

export const Pill = ({ status, children }) => <span className={`pill ${status}`}>{children ?? status}</span>;

export function Bar({ pct, color }) {
  return (
    <div className="bar">
      <i style={{ width: `${Math.max(0, Math.min(100, pct))}%`, ...(color ? { background: color } : {}) }} />
    </div>
  );
}

export function Switch({ checked, onChange, label }) {
  return (
    <span className="switch">
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} aria-label={label} />
      <i />
    </span>
  );
}

// Circular HUD gauge for a goal.
export function Gauge({ pct, size = 140, label }) {
  const r = 58;
  const c = 2 * Math.PI * r;
  return (
    <svg width={size} height={size} viewBox="0 0 140 140" role="img" aria-label={`${label ?? 'Progress'} ${pct}%`}>
      <circle cx="70" cy="70" r={r} fill="none" strokeWidth="9" style={{ stroke: 'rgba(255,255,255,0.07)' }} />
      <circle cx="70" cy="70" r={r} fill="none" strokeWidth="9" strokeDasharray={`${(c * pct) / 100} ${c}`} transform="rotate(-90 70 70)" style={{ stroke: 'var(--p)', filter: 'drop-shadow(0 0 6px var(--p))', transition: 'stroke-dasharray 0.6s' }} />
      <circle cx="70" cy="70" r="45" fill="none" strokeDasharray="3 5" style={{ stroke: 'var(--line)' }} />
      <text x="70" y="78" textAnchor="middle" style={{ fill: 'var(--text)', fontFamily: 'var(--mono)', fontSize: 24 }}>
        {pct}%
      </text>
    </svg>
  );
}

export function Spark({ history, width = 120, height = 24, color = 'var(--p)' }) {
  const values = (history ?? []).map((h) => (Array.isArray(h) ? h[1] : h)).filter(Number.isFinite);
  if (values.length < 2) return <svg width={width} height={height} aria-hidden="true" />;
  const min = Math.min(...values);
  const max = Math.max(...values);
  const pts = values.map((v, i) => `${(i / (values.length - 1)) * width},${height - 2 - ((v - min) / (max - min || 1)) * (height - 4)}`).join(' ');
  return (
    <svg width={width} height={height} aria-hidden="true">
      <polyline points={pts} fill="none" strokeWidth="2" style={{ stroke: color }} />
    </svg>
  );
}

export function Modal({ title, onClose, children }) {
  useEffect(() => {
    const onKey = (e) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  return (
    <div className="overlay" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal" role="dialog" aria-modal="true" aria-label={title}>
        <div className="row between">
          <h2 style={{ fontSize: 20 }}>{title}</h2>
          <button type="button" className="iconbtn" onClick={onClose} aria-label="Close">
            <Icon name="close" />
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}

// Tiny global toast.
let pushToast = () => {};
export const toast = (msg, bad = false) => pushToast({ msg, bad, at: Date.now() });
export function Toasts() {
  const [t, setT] = useState(null);
  useEffect(() => {
    pushToast = setT;
  }, []);
  useEffect(() => {
    if (!t) return;
    const h = setTimeout(() => setT(null), 3500);
    return () => clearTimeout(h);
  }, [t]);
  return t ? (
    <div className={`toast ${t.bad ? 'bad' : ''}`} role="status">
      {t.msg}
    </div>
  ) : null;
}

// ---------- safe Markdown (agent output is untrusted: escape first, then format) ----------
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const inline = (s) =>
  esc(s)
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>');
export function mdToHtml(src) {
  const lines = String(src ?? '').replace(/\r/g, '').split('\n');
  const out = [];
  let i = 0;
  while (i < lines.length) {
    const l = lines[i];
    if (l.startsWith('```')) {
      const buf = [];
      i++;
      while (i < lines.length && !lines[i].startsWith('```')) buf.push(lines[i++]);
      i++;
      out.push(`<pre><code>${esc(buf.join('\n'))}</code></pre>`);
    } else if (/^\s*\|/.test(l)) {
      const rows = [];
      while (i < lines.length && /^\s*\|/.test(lines[i])) rows.push(lines[i++]);
      const cells = (r) => r.trim().replace(/^\||\|$/g, '').split('|').map((c) => c.trim());
      const [head, ...rest] = rows.filter((r) => !/^\s*\|?\s*:?-{2,}/.test(r));
      out.push(`<table><thead><tr>${cells(head).map((c) => `<th>${inline(c)}</th>`).join('')}</tr></thead><tbody>${rest.map((r) => `<tr>${cells(r).map((c) => `<td>${inline(c)}</td>`).join('')}</tr>`).join('')}</tbody></table>`);
    } else if (/^\s*[-*]\s+/.test(l)) {
      const items = [];
      while (i < lines.length && /^\s*[-*]\s+/.test(lines[i])) items.push(lines[i++].replace(/^\s*[-*]\s+/, ''));
      out.push(`<ul>${items.map((x) => `<li>${inline(x)}</li>`).join('')}</ul>`);
    } else if (/^#{1,4}\s/.test(l)) {
      out.push(`<h3>${inline(l.replace(/^#+\s/, ''))}</h3>`);
      i++;
    } else {
      if (l.trim()) out.push(`<p>${inline(l)}</p>`);
      i++;
    }
  }
  return out.join('');
}
// eslint-disable-next-line react/no-danger
export const Md = ({ text }) => <div className="report" dangerouslySetInnerHTML={{ __html: mdToHtml(text) }} />;

// "6" + "projects" -> "6 projects"; "35" + "%" -> "35%".
export const withUnit = (v, unit) => (v === null || v === undefined || v === '' ? '—' : `${v}${unit && /^[a-z]/i.test(unit) ? ` ${unit}` : unit ?? ''}`);

export function ago(ts) {
  if (!ts) return '';
  const s = Math.round((Date.now() - ts) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}
