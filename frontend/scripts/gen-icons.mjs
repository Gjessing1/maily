/**
 * Generate placeholder PWA icons (solid brand square with a simple envelope mark)
 * with no image dependencies — raw PNG via zlib. Replace with real artwork later.
 *
 *   node scripts/gen-icons.mjs
 */
import { deflateSync } from 'node:zlib';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const OUT = join(dirname(fileURLToPath(import.meta.url)), '..', 'public', 'icons');
mkdirSync(OUT, { recursive: true });

const BG = [0x0b, 0x0b, 0x0f]; // app background
const FG = [0x6d, 0x6b, 0xff]; // accent

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

/** Draw a centered envelope. Returns true if pixel (x,y) is foreground. */
function isEnvelope(x, y, size) {
  const m = size * 0.26; // margin
  const w = size - 2 * m;
  const h = w * 0.66;
  const top = (size - h) / 2;
  if (x < m || x > size - m || y < top || y > top + h) return false;
  const stroke = size * 0.045;
  // Border of the envelope.
  if (x < m + stroke || x > size - m - stroke || y < top + stroke || y > top + h - stroke)
    return true;
  // The flap: two diagonals meeting at the centre top.
  const cx = size / 2;
  const slope = h / w;
  const dist = Math.abs(y - top - slope * Math.abs(x - cx));
  return dist < stroke;
}

function makePng(size) {
  const raw = Buffer.alloc((size * 4 + 1) * size);
  let p = 0;
  for (let y = 0; y < size; y += 1) {
    raw[p++] = 0; // filter: none
    for (let x = 0; x < size; x += 1) {
      const c = isEnvelope(x, y, size) ? FG : BG;
      raw[p++] = c[0];
      raw[p++] = c[1];
      raw[p++] = c[2];
      raw[p++] = 0xff;
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
  ['icon-192.png', 192],
  ['icon-512.png', 512],
  ['icon-maskable-512.png', 512],
  ['badge-72.png', 72],
];

for (const [name, size] of icons) {
  writeFileSync(join(OUT, name), makePng(size));
  console.log(`wrote ${name} (${size}px)`);
}
