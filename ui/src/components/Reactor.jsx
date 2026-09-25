import { useMemo } from 'react';

// The Jarvis core. `kind` is the animation style from Settings; `state` reflects the voice:
// listening (calm), thinking (faster spin), speaking (pulsing + waveform).
const C = 300;
const polar = (r, deg) => {
  const a = ((deg - 90) * Math.PI) / 180;
  return [C + r * Math.cos(a), C + r * Math.sin(a)];
};

function Compass() {
  const ticks = [];
  for (let d = 0; d < 360; d += 5) {
    const long = d % 30 === 0;
    const [x1, y1] = polar(long ? 246 : 256, d);
    const [x2, y2] = polar(266, d);
    ticks.push(<line key={d} x1={x1} y1={y1} x2={x2} y2={y2} style={{ stroke: 'var(--p)', strokeWidth: long ? 2.5 : 1.2, opacity: long ? 1 : 0.5 }} />);
  }
  const labels = [];
  for (let d = 0; d < 360; d += 30) {
    const [x, y] = polar(230, d);
    labels.push(
      <text key={d} x={x} y={y} textAnchor="middle" dominantBaseline="middle" style={{ fill: 'var(--p)', fontFamily: 'var(--mono)', fontSize: 14, opacity: 0.85 }}>
        {d}
      </text>,
    );
  }
  return (
    <g>
      <circle cx={C} cy={C} r={268} fill="none" style={{ stroke: 'var(--line)' }} />
      {ticks}
      {labels}
      <circle cx={C} cy={C} r={205} fill="none" strokeDasharray="2 6" style={{ stroke: 'var(--line)' }} />
    </g>
  );
}

function ReactorCore({ speed }) {
  return (
    <g>
      <g style={{ transformOrigin: '300px 300px', animation: `spin ${24 / speed}s linear infinite` }}>
        <path d="M 300 95 A 205 205 0 0 1 505 300" fill="none" style={{ stroke: 'var(--p)', strokeWidth: 2 }} />
        <circle cx={505} cy={300} r={5} style={{ fill: 'var(--s)' }} />
      </g>
      <circle cx={C} cy={C} r={158} fill="none" style={{ stroke: 'var(--p)', strokeWidth: 7, filter: 'drop-shadow(0 0 10px var(--p))' }} />
      <g style={{ transformOrigin: '300px 300px', animation: `spinr ${14 / speed}s linear infinite` }}>
        <circle cx={C} cy={C} r={122} fill="none" strokeDasharray="58 22" style={{ stroke: 'var(--s)', strokeWidth: 12, filter: 'drop-shadow(0 0 8px var(--s))' }} />
      </g>
      <circle cx={C} cy={C} r={84} fill="none" style={{ stroke: 'var(--p)', strokeWidth: 12, filter: 'drop-shadow(0 0 12px var(--p))' }} />
      <circle cx={C} cy={C} r={62} fill="url(#jcore)" style={{ animation: `glow ${2.6 / speed}s ease-in-out infinite` }} />
    </g>
  );
}

function Radar({ speed, blips }) {
  return (
    <g>
      {[160, 110, 60].map((r) => (
        <circle key={r} cx={C} cy={C} r={r} fill="none" style={{ stroke: 'var(--p)', opacity: 0.4 }} />
      ))}
      <g style={{ transformOrigin: '300px 300px', animation: `spin ${3 / speed}s linear infinite` }}>
        <path d="M 300 300 L 300 100 A 200 200 0 0 1 441 159 Z" style={{ fill: 'var(--p)', opacity: 0.28 }} />
        <line x1={C} y1={C} x2={C} y2={100} style={{ stroke: 'var(--p)', strokeWidth: 2 }} />
      </g>
      {blips.map((b, i) => (
        <circle key={i} cx={b[0]} cy={b[1]} r={5} style={{ fill: i % 2 ? 'var(--s)' : 'var(--p)', animation: `blink ${1 + (i % 3) * 0.4}s ease-in-out infinite` }} />
      ))}
      <circle cx={C} cy={C} r={10} style={{ fill: 'var(--core)' }} />
    </g>
  );
}

function Sphere({ speed, dots }) {
  return (
    <g style={{ transformOrigin: '300px 300px', animation: `spin ${30 / speed}s linear infinite` }}>
      {dots.map((d, i) => (
        <circle key={i} cx={d.x} cy={d.y} r={d.r} style={{ fill: 'var(--p)', opacity: d.o }} />
      ))}
    </g>
  );
}

function Pulse({ speed }) {
  return (
    <g>
      <circle cx={C} cy={C} r={150} fill="none" style={{ stroke: 'var(--p)', opacity: 0.3 }} />
      <circle cx={C} cy={C} r={100} fill="none" style={{ stroke: 'var(--p)', opacity: 0.5 }} />
      <circle cx={C} cy={C} r={44} style={{ fill: 'var(--core)', filter: 'drop-shadow(0 0 24px var(--p))', animation: `glow ${1.8 / speed}s ease-in-out infinite` }} />
    </g>
  );
}

export default function Reactor({ size = 600, kind = 'reactor', state = 'listening', compass = true, agents = 0 }) {
  const speed = state === 'speaking' ? 2.4 : state === 'thinking' ? 1.8 : 1;
  const dots = useMemo(() => {
    const out = [];
    for (let i = 0; i < 160; i++) {
      const phi = Math.acos(1 - (2 * (i + 0.5)) / 160);
      const th = Math.PI * (1 + Math.sqrt(5)) * i;
      const z = Math.sin(th) * Math.sin(phi);
      out.push({ x: C + Math.cos(th) * Math.sin(phi) * 150, y: C + Math.cos(phi) * 150, r: 2 + (z + 1) * 1.6, o: 0.3 + (z + 1) * 0.33 });
    }
    return out;
  }, []);
  const blips = useMemo(() => Array.from({ length: Math.min(agents, 12) }, (_, i) => polar(60 + ((i * 37) % 110), (i * 83) % 360)), [agents]);

  return (
    <svg width={size} height={size} viewBox="0 0 600 600" role="img" aria-label={`Jarvis core, ${state}`}>
      <defs>
        <radialGradient id="jcore" cx="50%" cy="45%" r="55%">
          <stop offset="0%" stopColor="#ffffff" />
          <stop offset="35%" style={{ stopColor: 'var(--core)' }} />
          <stop offset="100%" style={{ stopColor: 'var(--p)', stopOpacity: 0.4 }} />
        </radialGradient>
      </defs>
      {compass && <Compass />}
      {kind === 'radar' ? <Radar speed={speed} blips={blips} /> : kind === 'sphere' ? <Sphere speed={speed} dots={dots} /> : kind === 'pulse' ? <Pulse speed={speed} /> : <ReactorCore speed={speed} />}
    </svg>
  );
}

// Small spinning core used in the top bar and as a "home" button.
export function MiniCore({ size = 40 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 48 48" aria-hidden="true">
      <circle cx="24" cy="24" r="22" fill="none" style={{ stroke: 'var(--line)' }} />
      <g style={{ transformOrigin: '24px 24px', animation: 'spin 10s linear infinite' }}>
        <circle cx="24" cy="24" r="17" fill="none" strokeDasharray="8 4" style={{ stroke: 'var(--s)', strokeWidth: 3 }} />
      </g>
      <circle cx="24" cy="24" r="11" fill="none" style={{ stroke: 'var(--p)', strokeWidth: 3 }} />
      <circle cx="24" cy="24" r="6" style={{ fill: 'var(--core)' }} />
    </svg>
  );
}

export function Wave({ active, bars = 24, height = 28 }) {
  return (
    <svg width={bars * 8} height={height} aria-hidden="true">
      {Array.from({ length: bars }, (_, i) => {
        const h = active ? 6 + ((i * 7) % 5) * 5 : 3;
        return (
          <rect
            key={i}
            x={i * 8}
            y={(height - h) / 2}
            width={4}
            height={h}
            style={{ fill: 'var(--p)', transformBox: 'fill-box', transformOrigin: 'center', animation: active ? `wave ${0.5 + (i % 5) * 0.13}s ease-in-out infinite` : 'none' }}
          />
        );
      })}
    </svg>
  );
}
