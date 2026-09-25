// Colour themes (like the reference video) plus per-department retinting.
export const THEMES = {
  green: { name: 'Arc Green', note: 'Default', p: '#39e58c', s: '#ffc53d' },
  cyan: { name: 'Stark Cyan', note: 'Classic Jarvis', p: '#29d3f5', s: '#ffc53d' },
  red: { name: 'Mark Red', note: 'Iron Man suit', p: '#ff4b4b', s: '#ffb13d' },
  purple: { name: 'Vibranium', note: 'Purple + orange', p: '#b36bff', s: '#ff8a3d' },
  silver: { name: 'Silver', note: 'Clean and bright', p: '#c9d6dc', s: '#ffc53d' },
};

export const CORES = {
  reactor: { name: 'Arc Reactor', note: 'Rings spin while agents work' },
  radar: { name: 'Radar Sweep', note: 'Blips are live agents' },
  sphere: { name: 'Particle Sphere', note: 'Pulses with the voice' },
  pulse: { name: 'Pulse Core', note: 'Minimal and calm' },
};

const hex = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
const toHex = (rgb) => `#${rgb.map((v) => Math.round(v).toString(16).padStart(2, '0')).join('')}`;
const mix = (a, b, t) => toHex(hex(a).map((v, i) => v + (hex(b)[i] - v) * t));

// Derives a full palette from one primary colour, so any department colour becomes a complete HUD.
export function applyPalette(primary, secondary = '#ffc53d') {
  const r = document.documentElement.style;
  const [pr, pg, pb] = hex(primary);
  r.setProperty('--p', primary);
  r.setProperty('--p-rgb', `${pr}, ${pg}, ${pb}`);
  r.setProperty('--s', secondary);
  r.setProperty('--bg', mix('#000000', primary, 0.025));
  r.setProperty('--bg-glow', mix('#000000', primary, 0.14));
  r.setProperty('--panel', mix('#000000', primary, 0.05));
  r.setProperty('--line', mix('#000000', primary, 0.24));
  r.setProperty('--line-soft', mix('#000000', primary, 0.13));
  r.setProperty('--text', mix('#ffffff', primary, 0.1));
  r.setProperty('--muted', mix('#9aa8ae', primary, 0.35));
  r.setProperty('--faint', mix('#56646b', primary, 0.3));
  r.setProperty('--core', mix('#ffffff', primary, 0.22));
}
