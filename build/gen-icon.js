// Generates build/icon.ico — pure black/white Local Chat mark, anti-aliased.
// Mark: rounded black tile, white speech bubble with a tail and three typing dots.
// No external assets, no dependencies.
const fs = require("fs");
const path = require("path");
const zlib = require("zlib");

function crc32(buf) {
  let table = crc32.t;
  if (!table) {
    table = crc32.t = new Int32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      table[n] = c;
    }
  }
  let crc = -1;
  for (let i = 0; i < buf.length; i++) crc = (crc >>> 8) ^ table[(crc ^ buf[i]) & 0xff];
  return (crc ^ -1) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}

function inRoundRect(px, py, x0, y0, x1, y1, r) {
  if (px < x0 || px > x1 || py < y0 || py > y1) return false;
  const dx = Math.max(x0 + r - px, 0, px - (x1 - r));
  const dy = Math.max(y0 + r - py, 0, py - (y1 - r));
  return dx * dx + dy * dy <= r * r;
}
function inRect(px, py, x0, y0, x1, y1) {
  return px >= x0 && px <= x1 && py >= y0 && py <= y1;
}
function inTriangle(px, py, ax, ay, bx, by, cx, cy) {
  const d1 = (px - bx) * (ay - by) - (ax - bx) * (py - by);
  const d2 = (px - cx) * (by - cy) - (bx - cx) * (py - cy);
  const d3 = (px - ax) * (cy - ay) - (cx - ax) * (py - ay);
  const hasNeg = d1 < 0 || d2 < 0 || d3 < 0;
  const hasPos = d1 > 0 || d2 > 0 || d3 > 0;
  return !(hasNeg && hasPos);
}
function inCircle(px, py, cx, cy, r) {
  const dx = px - cx, dy = py - cy;
  return dx * dx + dy * dy <= r * r;
}

// shapes are normalized 0..1
const tile = { x0: 0.02, y0: 0.02, x1: 0.98, y1: 0.98, r: 0.2 };
const bubble = { x0: 0.17, y0: 0.19, x1: 0.83, y1: 0.66, r: 0.14 };
// speech bubble tail (bottom-left)
const tail = [0.30, 0.58, 0.30, 0.83, 0.51, 0.58];
// typing dots (black cut-outs)
const dots = [
  { x: 0.355, y: 0.425, r: 0.05 },
  { x: 0.50, y: 0.425, r: 0.05 },
  { x: 0.645, y: 0.425, r: 0.05 }
];
function inWhite(u, v) {
  const inBubble = inRoundRect(u, v, bubble.x0, bubble.y0, bubble.x1, bubble.y1, bubble.r);
  const inTail = inTriangle(u, v, tail[0], tail[1], tail[2], tail[3], tail[4], tail[5]);
  if (!inBubble && !inTail) return false;
  for (const d of dots) if (inCircle(u, v, d.x, d.y, d.r)) return false;
  return true;
}

function png(size) {
  const S = 4; // supersample
  const px = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let tileCov = 0, whiteCov = 0;
      for (let sy = 0; sy < S; sy++) {
        for (let sx = 0; sx < S; sx++) {
          const u = (x + (sx + 0.5) / S) / size;
          const v = (y + (sy + 0.5) / S) / size;
          if (inRoundRect(u, v, tile.x0, tile.y0, tile.x1, tile.y1, tile.r)) {
            tileCov++;
            if (inWhite(u, v)) whiteCov++;
          }
        }
      }
      const total = S * S;
      const a = tileCov / total;
      const wc = whiteCov / total;
      const o = (y * size + x) * 4;
      const lum = Math.round(255 * (tileCov ? wc / a : 0));
      px[o] = px[o + 1] = px[o + 2] = lum;
      px[o + 3] = Math.round(255 * a);
    }
  }
  const raw = Buffer.alloc(size * (1 + size * 4));
  for (let y = 0; y < size; y++) {
    raw[y * (1 + size * 4)] = 0;
    px.copy(raw, y * (1 + size * 4) + 1, y * size * 4, (y + 1) * size * 4);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; ihdr[9] = 6;
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  return Buffer.concat([sig, chunk("IHDR", ihdr), chunk("IDAT", zlib.deflateSync(raw, { level: 9 })), chunk("IEND", Buffer.alloc(0))]);
}

const sizes = [16, 24, 32, 48, 64, 128, 256];
const imgs = sizes.map(png);
const header = Buffer.alloc(6);
header.writeUInt16LE(0, 0);
header.writeUInt16LE(1, 2);
header.writeUInt16LE(imgs.length, 4);
let offset = 6 + 16 * imgs.length;
const entries = imgs.map((img, i) => {
  const e = Buffer.alloc(16);
  const s = sizes[i] >= 256 ? 0 : sizes[i];
  e[0] = s; e[1] = s; e[2] = 0; e[3] = 0;
  e.writeUInt16LE(1, 4);
  e.writeUInt16LE(32, 6);
  e.writeUInt32LE(img.length, 8);
  e.writeUInt32LE(offset, 12);
  offset += img.length;
  return e;
});
const out = path.join(__dirname, "icon.ico");
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, Buffer.concat([header, ...entries, ...imgs]));
// also emit a 512 PNG for the website / store
fs.writeFileSync(path.join(__dirname, "icon.png"), png(512));
console.log("wrote " + out + " (" + fs.statSync(out).size + " bytes) + icon.png");
