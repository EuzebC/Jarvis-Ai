import { useEffect, useRef } from 'react';
import { live } from '../live.js';
import { voice } from '../voice.js';

// A holographic head drawn from formulas: no mesh, no assets. Lines and glow in the theme colour, eyes that
// blink and look around, brows that ride the sentence, and a mouth driven by the live audio level and the
// words being spoken (closed on m/b/p, spread on i/e, rounded on o/u). The face is also a status indicator:
// it looks at you while listening, away while thinking, and its lids fall when Jarvis is idle.

const VOWEL = { a: { open: 0.9, width: 0.2 }, e: { open: 0.55, width: 0.7 }, i: { open: 0.35, width: 1 }, o: { open: 0.8, width: -0.7 }, u: { open: 0.45, width: -1 }, y: { open: 0.35, width: 0.8 } };
const CLOSED = /[mbp]/;
const strip = (s) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

function viseme(text) {
  const t = strip(text).replace(/[^a-z]/g, '');
  if (!t) return null;
  const last = t.slice(-3);
  if (CLOSED.test(last.slice(-1))) return { open: 0.05, width: 0.1 };
  for (let i = last.length - 1; i >= 0; i--) if (VOWEL[last[i]]) return VOWEL[last[i]];
  return { open: 0.3, width: 0.3 };
}

const cssColor = (el) => getComputedStyle(el).getPropertyValue('--p').trim() || '#39e58c';
const hexToRgb = (h) => {
  const m = h.match(/^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})/i);
  return m ? [parseInt(m[1], 16), parseInt(m[2], 16), parseInt(m[3], 16)] : [57, 229, 140];
};

export default function Face({ size = 600, state = 'listening', talk = null, agents = 0 }) {
  const ref = useRef(null);
  const anim = useRef({ blink: 0, nextBlink: 2, gaze: [0, 0], gazeTarget: [0, 0], nextSaccade: 1, open: 0, width: 0.2, brow: 0, level: 0, last: performance.now() / 1000, sway: 0 });

  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return undefined;
    const ctx = canvas.getContext('2d');
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = size * dpr;
    canvas.height = size * dpr;
    let raf = 0;
    let running = true;
    const a = anim.current;

    const frame = () => {
      if (!running) return;
      const now = performance.now() / 1000;
      const dt = Math.min(0.05, now - a.last);
      a.last = now;
      const [r, g, b] = hexToRgb(cssColor(canvas));
      const col = (alpha) => `rgba(${r},${g},${b},${alpha})`;

      // ----- what is happening -----
      const liveOn = live.active;
      const mode = liveOn ? live.state : voice.state === 'speaking' ? 'speaking' : state;
      const speaking = mode === 'speaking';
      let level = 0;
      let shape = null;
      if (liveOn) {
        level = live.level();
        shape = speaking ? viseme(live.recentSpeech()) : null;
      } else if (speaking) {
        // Windows voices give no audio signal: an even rhythm of syllables keeps the mouth alive.
        level = 0.35 + 0.35 * Math.abs(Math.sin(now * 9)) * (0.6 + 0.4 * Math.sin(now * 2.3));
        shape = VOWEL['aeiou'[Math.floor(now * 4) % 5]];
      }
      if (typeof talk === 'function') {
        const t = talk();
        if (t) {
          level = t.level ?? level;
          shape = t.shape ?? shape;
        }
      }
      a.level += (level - a.level) * Math.min(1, dt * 30);
      const targetOpen = speaking ? Math.min(1, a.level * 1.3) * (shape ? shape.open : 0.7) : 0;
      const targetWidth = speaking && shape ? shape.width : 0.15;
      a.open += (targetOpen - a.open) * Math.min(1, dt * 28);
      a.width += (targetWidth - a.width) * Math.min(1, dt * 14);
      const targetBrow = speaking ? Math.min(1, a.level * 0.9) : mode === 'thinking' ? 0.45 : 0.1;
      a.brow += (targetBrow - a.brow) * Math.min(1, dt * 8);

      // ----- eyes: blinks and saccades -----
      a.nextBlink -= dt;
      if (a.nextBlink <= 0) {
        a.blink = 1;
        a.nextBlink = 2.5 + Math.random() * 3.5;
      }
      a.blink = Math.max(0, a.blink - dt * 7);
      a.nextSaccade -= dt;
      if (a.nextSaccade <= 0) {
        a.nextSaccade = (speaking ? 0.6 : 1.4) + Math.random() * 1.6;
        if (mode === 'thinking') a.gazeTarget = [(Math.random() > 0.5 ? 1 : -1) * (0.5 + Math.random() * 0.4), -0.6 - Math.random() * 0.3];
        else if (mode === 'listening' || mode === 'connecting') a.gazeTarget = [(Math.random() - 0.5) * 0.15, (Math.random() - 0.5) * 0.1];
        else a.gazeTarget = [(Math.random() - 0.5) * 0.7, (Math.random() - 0.5) * 0.5];
      }
      a.gaze[0] += (a.gazeTarget[0] - a.gaze[0]) * Math.min(1, dt * 12);
      a.gaze[1] += (a.gazeTarget[1] - a.gaze[1]) * Math.min(1, dt * 12);
      const lids = mode === 'off' || mode === 'idle' ? 0.55 : a.blink > 0.5 ? 1 : a.blink * 2;
      a.sway = Math.sin(now * 0.7) * 0.012 + (speaking ? Math.sin(now * 5.1) * 0.006 * a.level : 0);

      // ----- draw -----
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, size, size);
      const s = size / 600;
      ctx.translate(size / 2, size / 2);
      ctx.scale(s, s);
      ctx.rotate(a.sway);
      const breathe = 1 + Math.sin(now * 1.1) * 0.006;
      ctx.scale(breathe, breathe);
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';

      // hologram scanlines
      ctx.save();
      ctx.beginPath();
      ctx.ellipse(0, 0, 175, 235, 0, 0, Math.PI * 2);
      ctx.clip();
      ctx.strokeStyle = col(0.06);
      ctx.lineWidth = 1;
      const scroll = (now * 40) % 6;
      for (let y = -240 + scroll; y < 240; y += 6) {
        ctx.beginPath();
        ctx.moveTo(-200, y);
        ctx.lineTo(200, y);
        ctx.stroke();
      }
      // wireframe contours
      ctx.strokeStyle = col(0.13);
      for (let i = -3; i <= 3; i++) {
        ctx.beginPath();
        ctx.ellipse(0, 10, 165 - Math.abs(i) * 18, 225 - Math.abs(i) * 8, 0, 0, Math.PI * 2);
        ctx.stroke();
      }
      ctx.restore();

      // head outline with glow
      const head = () => {
        ctx.beginPath();
        ctx.moveTo(0, -238);
        ctx.bezierCurveTo(120, -238, 178, -150, 175, -40);
        ctx.bezierCurveTo(173, 60, 150, 140, 90, 205);
        ctx.bezierCurveTo(55, 240, -55, 240, -90, 205);
        ctx.bezierCurveTo(-150, 140, -173, 60, -175, -40);
        ctx.bezierCurveTo(-178, -150, -120, -238, 0, -238);
        ctx.closePath();
      };
      ctx.shadowColor = col(0.9);
      ctx.shadowBlur = 24;
      ctx.strokeStyle = col(0.9);
      ctx.lineWidth = 2.5;
      head();
      ctx.stroke();
      ctx.shadowBlur = 0;
      ctx.fillStyle = col(0.05);
      head();
      ctx.fill();

      // neck hint
      ctx.strokeStyle = col(0.35);
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(-48, 232);
      ctx.lineTo(-58, 290);
      ctx.moveTo(48, 232);
      ctx.lineTo(58, 290);
      ctx.stroke();

      // brows
      const browY = -78 - a.brow * 14;
      ctx.strokeStyle = col(0.85);
      ctx.lineWidth = 4;
      for (const side of [-1, 1]) {
        const lift = side === -1 ? a.brow * 4 : 0; // a touch of asymmetry
        ctx.beginPath();
        ctx.moveTo(side * 30, browY + 6 - lift);
        ctx.quadraticCurveTo(side * 66, browY - 12 - lift, side * 104, browY + 2 - lift);
        ctx.stroke();
      }

      // eyes
      for (const side of [-1, 1]) {
        const cx = side * 66;
        const cy = -40;
        const openness = 1 - lids;
        ctx.save();
        ctx.beginPath();
        ctx.moveTo(cx - 34, cy);
        ctx.quadraticCurveTo(cx, cy - 26 * openness - 1, cx + 34, cy);
        ctx.quadraticCurveTo(cx, cy + 22 * openness + 1, cx - 34, cy);
        ctx.closePath();
        ctx.strokeStyle = col(0.9);
        ctx.lineWidth = 2.5;
        ctx.stroke();
        ctx.clip();
        const ix = cx + a.gaze[0] * 14;
        const iy = cy + a.gaze[1] * 9;
        ctx.fillStyle = col(0.25);
        ctx.beginPath();
        ctx.arc(ix, iy, 13, 0, Math.PI * 2);
        ctx.fill();
        ctx.strokeStyle = col(0.95);
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.arc(ix, iy, 13, 0, Math.PI * 2);
        ctx.stroke();
        ctx.fillStyle = col(1);
        ctx.beginPath();
        ctx.arc(ix, iy, 5.5, 0, Math.PI * 2);
        ctx.fill();
        ctx.fillStyle = 'rgba(255,255,255,0.9)';
        ctx.beginPath();
        ctx.arc(ix + 4, iy - 4, 2, 0, Math.PI * 2);
        ctx.fill();
        ctx.restore();
      }

      // nose
      ctx.strokeStyle = col(0.45);
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(-6, -20);
      ctx.lineTo(-16, 48);
      ctx.quadraticCurveTo(0, 62, 18, 48);
      ctx.stroke();

      // mouth
      const my = 118;
      const halfW = 52 + a.width * 16;
      const openPx = a.open * 34;
      ctx.strokeStyle = col(0.95);
      ctx.lineWidth = 3;
      ctx.shadowColor = col(0.6);
      ctx.shadowBlur = speaking ? 10 : 0;
      ctx.beginPath();
      ctx.moveTo(-halfW, my);
      ctx.quadraticCurveTo(0, my - 6 - a.width * 2, halfW, my);
      ctx.quadraticCurveTo(0, my + 8 + openPx, -halfW, my);
      ctx.closePath();
      ctx.stroke();
      ctx.shadowBlur = 0;
      if (openPx > 3) {
        ctx.fillStyle = `rgba(0,0,0,${0.35 + a.open * 0.3})`;
        ctx.fill();
        ctx.strokeStyle = col(0.35);
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.moveTo(-halfW * 0.7, my + 1);
        ctx.lineTo(halfW * 0.7, my + 1);
        ctx.stroke();
      }

      // status ring
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.translate(size / 2, size / 2);
      ctx.scale(s, s);
      ctx.strokeStyle = col(mode === 'thinking' ? 0.55 : 0.22);
      ctx.lineWidth = 2;
      ctx.setLineDash(mode === 'thinking' ? [14, 10] : mode === 'speaking' ? [4, 6] : []);
      ctx.lineDashOffset = -now * (mode === 'thinking' ? 60 : 25);
      ctx.beginPath();
      ctx.arc(0, 0, 285, 0, Math.PI * 2);
      ctx.stroke();
      ctx.setLineDash([]);
      if (agents > 0) {
        ctx.fillStyle = col(0.8);
        for (let i = 0; i < Math.min(agents, 24); i++) {
          const ang = (i / Math.min(agents, 24)) * Math.PI * 2 + now * 0.2;
          ctx.beginPath();
          ctx.arc(Math.cos(ang) * 285, Math.sin(ang) * 285, 3, 0, Math.PI * 2);
          ctx.fill();
        }
      }
      raf = requestAnimationFrame(frame);
    };
    raf = requestAnimationFrame(frame);
    return () => {
      running = false;
      cancelAnimationFrame(raf);
    };
  }, [size, state, talk, agents]);

  return <canvas ref={ref} style={{ width: size, height: size, display: 'block' }} role="img" aria-label={`Jarvis, ${state}`} />;
}
