/**
 * Generate the PWA / favicon set with no image dependencies — raw PNG via zlib.
 *
 * Style mirrors the sibling nodecal app (flat shapes, rounded square, blue
 * palette) but in a mailbox idiom: a white envelope with a darker-blue flap on
 * the brand-blue rounded square. Edges are anti-aliased by 4×4 supersampling.
 * The canonical artwork also lives as `public/icons/icon.svg` (used as the
 * crisp SVG favicon); keep the two in sync if you tweak the proportions.
 *
 *   node scripts/gen-icons.mjs
 */
import { deflateSync } from 'node:zlib';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const OUT = join(dirname(fileURLToPath(import.meta.url)), '..', 'public', 'icons');
mkdirSync(OUT, { recursive: true });

// nodecal-style blue palette.
const BLUE = [0x25, 0x63, 0xeb]; // #2563eb brand / background
const DARK = [0x1e, 0x40, 0xaf]; // #1e40af envelope flap
const WHITE = [0xff, 0xff, 0xff]; // envelope body
const CLEAR = [0, 0, 0, 0]; // transparent

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, 'ascii');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([len, typeBuf, data, crc]);
}

/** Signed distance to a rounded box centred at (cx,cy); < 0 is inside. */
function sdRoundBox(px, py, cx, cy, halfW, halfH, r) {
  const qx = Math.abs(px - cx) - halfW + r;
  const qy = Math.abs(py - cy) - halfH + r;
  return Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - r;
}

function edgeSign(px, py, ax, ay, bx, by) {
  return (px - bx) * (ay - by) - (ax - bx) * (py - by);
}

/** Point-in-triangle via consistent edge signs. */
function inTriangle(px, py, ax, ay, bx, by, cx, cy) {
  const d1 = edgeSign(px, py, ax, ay, bx, by);
  const d2 = edgeSign(px, py, bx, by, cx, cy);
  const d3 = edgeSign(px, py, cx, cy, ax, ay);
  const hasNeg = d1 < 0 || d2 < 0 || d3 < 0;
  const hasPos = d1 > 0 || d2 > 0 || d3 > 0;
  return !(hasNeg && hasPos);
}

/**
 * Resolve the colour of a single (sub)sample.
 *  - `maskable`: fill the whole square (the platform applies its own mask).
 *  - `badge`: white envelope silhouette on transparent (Android tints it).
 */
function sampleColor(x, y, size, { maskable, badge }) {
  const s = size;
  // Envelope body geometry (shared by the SVG source — keep in sync).
  const bx0 = s * 0.17;
  const bx1 = s * 0.83;
  const by0 = s * 0.27;
  const by1 = s * 0.73;
  const bodyCx = (bx0 + bx1) / 2;
  const bodyCy = (by0 + by1) / 2;
  const bodyHalfW = (bx1 - bx0) / 2;
  const bodyHalfH = (by1 - by0) / 2;
  const bodyR = s * 0.05;
  const inBody = sdRoundBox(x, y, bodyCx, bodyCy, bodyHalfW, bodyHalfH, bodyR) <= 0;
  // Flap triangle: top corners down to a centred apex just past the midline.
  const apexY = by0 + (by1 - by0) * 0.54;
  const inFlap = inTriangle(x, y, bx0, by0, bx1, by0, s / 2, apexY);

  if (badge) return inBody && !inFlap ? [...WHITE, 0xff] : CLEAR;

  // Background: full-bleed for maskable, rounded square otherwise.
  let col;
  if (maskable) {
    col = [...BLUE, 0xff];
  } else {
    const inBg = sdRoundBox(x, y, s / 2, s / 2, s / 2, s / 2, s * 0.22) <= 0;
    col = inBg ? [...BLUE, 0xff] : CLEAR;
  }
  if (inBody) col = [...WHITE, 0xff];
  if (inBody && inFlap) col = [...DARK, 0xff];
  return col;
}

function makePng(size, opts) {
  const SS = 4; // supersampling factor per axis
  const raw = Buffer.alloc((size * 4 + 1) * size);
  let p = 0;
  for (let y = 0; y < size; y += 1) {
    raw[p++] = 0; // filter: none
    for (let x = 0; x < size; x += 1) {
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      for (let sy = 0; sy < SS; sy += 1) {
        for (let sx = 0; sx < SS; sx += 1) {
          const c = sampleColor(x + (sx + 0.5) / SS, y + (sy + 0.5) / SS, size, opts);
          const ca = c[3] ?? 0xff;
          // Premultiply so transparent samples don't darken the edges.
          r += c[0] * ca;
          g += c[1] * ca;
          b += c[2] * ca;
          a += ca;
        }
      }
      const n = SS * SS;
      raw[p++] = a ? Math.round(r / a) : 0;
      raw[p++] = a ? Math.round(g / a) : 0;
      raw[p++] = a ? Math.round(b / a) : 0;
      raw[p++] = Math.round(a / n);
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // colour type RGBA
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  return Buffer.concat([
    sig,
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

const icons = [
  ['icon-192.png', 192, {}],
  ['icon-512.png', 512, {}],
  ['icon-maskable-512.png', 512, { maskable: true }],
  ['badge-72.png', 72, { badge: true }],
];

for (const [name, size, opts] of icons) {
  writeFileSync(join(OUT, name), makePng(size, opts));
  console.log(`wrote ${name} (${size}px)`);
}
