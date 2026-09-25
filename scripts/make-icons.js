// Generates the app and tray icons (arc-reactor rings) as PNGs without image libraries.
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

const out = path.resolve(import.meta.dirname, '..', 'app', 'icons');
fs.mkdirSync(out, { recursive: true });

const crcTable = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc32 = (buf) => {
  let c = 0xffffffff;
  for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};
const chunk = (type, data) => {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
};
const smooth = (a, b, x) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};
const band = (d, inner, outer, aa) => smooth(inner - aa, inner + aa, d) * (1 - smooth(outer - aa, outer + aa, d));

// RGBA with a transparent background so the tray icon sits cleanly on the taskbar.
function render(size) {
  const raw = Buffer.alloc(size * (size * 4 + 1));
  const aa = 1.2 / size;
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0;
    for (let x = 0; x < size; x++) {
      const d = Math.hypot(x + 0.5 - size / 2, y + 0.5 - size / 2) / size;
      const layers = [
        [[57, 229, 140], band(d, 0.4, 0.47, aa)],
        [[255, 197, 61], band(d, 0.27, 0.35, aa)],
        [[201, 255, 228], 1 - smooth(0.13 - aa, 0.15 + aa, d)],
      ];
      let r = 0, g = 0, b = 0, a = 0;
      for (const [c, v] of layers) {
        if (v <= 0) continue;
        r = r * (1 - v) + c[0] * v;
        g = g * (1 - v) + c[1] * v;
        b = b * (1 - v) + c[2] * v;
        a = Math.max(a, v);
      }
      const o = y * (size * 4 + 1) + 1 + x * 4;
      raw[o] = r;
      raw[o + 1] = g;
      raw[o + 2] = b;
      raw[o + 3] = Math.round(a * 255);
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;
  ihdr[9] = 6; // RGBA
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

for (const [name, size] of [['icon.png', 256], ['tray.png', 32]]) {
  fs.writeFileSync(path.join(out, name), render(size));
  console.log(`wrote app/icons/${name}`);
}
