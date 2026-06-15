#!/usr/bin/env node
/**
 * generate-desktop-icons.mjs
 *
 * Generates valid Tauri 2 desktop icon assets for GraphVault with ZERO external
 * dependencies — only Node.js built-ins (zlib, fs, path).
 *
 * Outputs to apps/desktop/src-tauri/icons/:
 *   32x32.png           — RGBA PNG (color type 6)
 *   128x128.png         — RGBA PNG (color type 6)
 *   128x128@2x.png      — RGBA PNG 256×256 (color type 6)
 *   icon.png            — RGBA PNG 512×512 (color type 6)
 *   icon.ico            — multi-size ICO (16/32/48/256, PNG-compressed entries)
 *   icon.icns           — Apple ICNS container with PNG payloads
 *
 * Brand:
 *   Background  #0a0a0a (brand dark)
 *   Hub nodes   #38bdf8 (sky-400)
 *   Satellite   #818cf8 (indigo-400)
 *   Edges       #1e3a5f (dark blue)
 */

import { deflateSync } from 'zlib';
import { writeFileSync, mkdirSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');
const ICONS_DIR = resolve(ROOT, 'apps/desktop/src-tauri/icons');

mkdirSync(ICONS_DIR, { recursive: true });

// ---------------------------------------------------------------------------
// CRC-32 (used by PNG)
// ---------------------------------------------------------------------------

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

// ---------------------------------------------------------------------------
// PNG encoder — RGBA (color type 6), 8 bits per channel
// ---------------------------------------------------------------------------

/**
 * @param {number} width
 * @param {number} height
 * @param {Buffer} pixels  — RGBA bytes, width*height*4 in length
 * @returns {Buffer}       — complete PNG file
 */
function encodePNG(width, height, pixels) {
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

  // IHDR
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // colour type 6 = RGBA  ← required by Tauri 2
  ihdr[10] = 0; // compression method
  ihdr[11] = 0; // filter method
  ihdr[12] = 0; // interlace method

  // Apply PNG filter type None (0x00) — prepend one byte per row
  const stride = width * 4;
  const filtered = Buffer.alloc(height * (1 + stride));
  for (let y = 0; y < height; y++) {
    filtered[y * (1 + stride)] = 0; // filter type None
    pixels.copy(filtered, y * (1 + stride) + 1, y * stride, (y + 1) * stride);
  }

  const compressed = deflateSync(filtered, { level: 6 });

  function chunk(type, data) {
    const typeBuf = Buffer.from(type, 'ascii');
    const lenBuf = Buffer.alloc(4);
    lenBuf.writeUInt32BE(data.length, 0);
    const crcData = Buffer.concat([typeBuf, data]);
    const crcBuf = Buffer.alloc(4);
    crcBuf.writeUInt32BE(crc32(crcData), 0);
    return Buffer.concat([lenBuf, typeBuf, data, crcBuf]);
  }

  return Buffer.concat([
    sig,
    chunk('IHDR', ihdr),
    chunk('IDAT', compressed),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// ---------------------------------------------------------------------------
// Rasteriser — draw the GraphVault mark onto an RGBA pixel buffer
// ---------------------------------------------------------------------------

function drawCircle(pixels, width, height, cx, cy, r, col) {
  const [cr, cg, cb, ca] = col;
  const x0 = Math.max(0, Math.floor(cx - r - 1));
  const x1 = Math.min(width - 1, Math.ceil(cx + r + 1));
  const y0 = Math.max(0, Math.floor(cy - r - 1));
  const y1 = Math.min(height - 1, Math.ceil(cy + r + 1));
  for (let py = y0; py <= y1; py++) {
    for (let px = x0; px <= x1; px++) {
      const dx = px - cx;
      const dy = py - cy;
      const dist = Math.sqrt(dx * dx + dy * dy);
      if (dist <= r) {
        // simple AA at edge: alpha ramp over the last pixel
        const alpha = dist > r - 1 ? Math.round((r - dist) * (ca ?? 255)) : (ca ?? 255);
        const idx = (py * width + px) * 4;
        // blend over existing (premultiplied-style simple over)
        const a = alpha / 255;
        pixels[idx] = Math.round(cr * a + pixels[idx] * (1 - a));
        pixels[idx + 1] = Math.round(cg * a + pixels[idx + 1] * (1 - a));
        pixels[idx + 2] = Math.round(cb * a + pixels[idx + 2] * (1 - a));
        pixels[idx + 3] = Math.min(255, pixels[idx + 3] + alpha);
      }
    }
  }
}

function drawLine(pixels, width, height, x0, y0, x1, y1, col, thickness) {
  const [cr, cg, cb] = col;
  const t = thickness / 2;
  const dx = x1 - x0;
  const dy = y1 - y0;
  const len = Math.sqrt(dx * dx + dy * dy);
  if (len === 0) return;
  const steps = Math.ceil(len * 2);
  for (let i = 0; i <= steps; i++) {
    const frac = i / steps;
    const px = x0 + dx * frac;
    const py = y0 + dy * frac;
    const qx0 = Math.max(0, Math.floor(px - t));
    const qx1 = Math.min(width - 1, Math.ceil(px + t));
    const qy0 = Math.max(0, Math.floor(py - t));
    const qy1 = Math.min(height - 1, Math.ceil(py + t));
    for (let qy = qy0; qy <= qy1; qy++) {
      for (let qx = qx0; qx <= qx1; qx++) {
        const ddx = qx - px;
        const ddy = qy - py;
        if (ddx * ddx + ddy * ddy <= t * t) {
          const idx = (qy * width + qx) * 4;
          pixels[idx] = cr;
          pixels[idx + 1] = cg;
          pixels[idx + 2] = cb;
          pixels[idx + 3] = 255;
        }
      }
    }
  }
}

/**
 * Render the GraphVault brand mark at the requested size.
 * Returns a Buffer of RGBA pixels (width * height * 4 bytes).
 */
function renderMark(size) {
  const pixels = Buffer.alloc(size * size * 4);

  // Background fill #0a0a0a, fully opaque
  for (let i = 0; i < size * size; i++) {
    pixels[i * 4] = 0x0a;
    pixels[i * 4 + 1] = 0x0a;
    pixels[i * 4 + 2] = 0x0a;
    pixels[i * 4 + 3] = 0xff;
  }

  const pad = size * 0.18;
  const inner = size - 2 * pad;

  // Node positions normalised from a 24×24 grid:
  //   A: (5/24, 6/24)   hub      sky-400  #38bdf8
  //   B: (19/24, 8/24)  hub      sky-400  #38bdf8
  //   C: (12/24, 18/24) satellite indigo-400 #818cf8
  const nodePos = [
    [5 / 24, 6 / 24],
    [19 / 24, 8 / 24],
    [12 / 24, 18 / 24],
  ];

  const pts = nodePos.map(([fx, fy]) => [pad + fx * inner, pad + fy * inner]);

  const edgeCol = [0x1e, 0x3a, 0x5f]; // #1e3a5f
  const skyCol = [0x38, 0xbd, 0xf8, 255]; // #38bdf8 sky-400
  const indigoCol = [0x81, 0x8c, 0xf8, 255]; // #818cf8 indigo-400

  const edgeW = Math.max(1.5, size * 0.022);
  const nodeR = size * 0.095;

  // Draw edges first (behind nodes)
  drawLine(pixels, size, size, pts[0][0], pts[0][1], pts[1][0], pts[1][1], edgeCol, edgeW);
  drawLine(pixels, size, size, pts[0][0], pts[0][1], pts[2][0], pts[2][1], edgeCol, edgeW);
  drawLine(pixels, size, size, pts[1][0], pts[1][1], pts[2][0], pts[2][1], edgeCol, edgeW);

  // Draw nodes
  drawCircle(pixels, size, size, pts[0][0], pts[0][1], nodeR, skyCol);
  drawCircle(pixels, size, size, pts[1][0], pts[1][1], nodeR, skyCol);
  drawCircle(pixels, size, size, pts[2][0], pts[2][1], nodeR * 0.85, indigoCol);

  return pixels;
}

// ---------------------------------------------------------------------------
// Scale down a large RGBA buffer to a smaller size (simple box filter)
// ---------------------------------------------------------------------------

function scaleDown(srcPixels, srcSize, dstSize) {
  if (srcSize === dstSize) return srcPixels;
  const dst = Buffer.alloc(dstSize * dstSize * 4);
  const scale = srcSize / dstSize;
  for (let dy = 0; dy < dstSize; dy++) {
    for (let dx = 0; dx < dstSize; dx++) {
      // Box filter: average srcSize/dstSize × srcSize/dstSize source pixels
      let r = 0,
        g = 0,
        b = 0,
        a = 0,
        count = 0;
      const sx0 = Math.floor(dx * scale);
      const sx1 = Math.ceil((dx + 1) * scale);
      const sy0 = Math.floor(dy * scale);
      const sy1 = Math.ceil((dy + 1) * scale);
      for (let sy = sy0; sy < sy1 && sy < srcSize; sy++) {
        for (let sx = sx0; sx < sx1 && sx < srcSize; sx++) {
          const i = (sy * srcSize + sx) * 4;
          r += srcPixels[i];
          g += srcPixels[i + 1];
          b += srcPixels[i + 2];
          a += srcPixels[i + 3];
          count++;
        }
      }
      const di = (dy * dstSize + dx) * 4;
      dst[di] = Math.round(r / count);
      dst[di + 1] = Math.round(g / count);
      dst[di + 2] = Math.round(b / count);
      dst[di + 3] = Math.round(a / count);
    }
  }
  return dst;
}

// ---------------------------------------------------------------------------
// Build PNG at any size (render at max(size,512) then scale down)
// ---------------------------------------------------------------------------

const MASTER_SIZE = 512;
let masterPixels = null;

function getMasterPixels() {
  if (!masterPixels) masterPixels = renderMark(MASTER_SIZE);
  return masterPixels;
}

function buildPNG(size) {
  const pixels =
    size >= MASTER_SIZE ? renderMark(size) : scaleDown(getMasterPixels(), MASTER_SIZE, size);
  return encodePNG(size, size, pixels);
}

// ---------------------------------------------------------------------------
// ICO builder — multi-size, PNG-compressed entries (valid for Windows Vista+)
// ---------------------------------------------------------------------------

/**
 * Build a valid .ico file containing PNG-compressed images at the given sizes.
 *
 * ICO format:
 *   ICONDIR   (6 bytes)
 *   ICONDIRENTRY × N  (16 bytes each)
 *   image data (PNG blobs concatenated)
 *
 * The width/height fields in ICONDIRENTRY are 1 byte each; the value 0 means 256.
 */
function buildICO(sizes) {
  const pngs = sizes.map((s) => buildPNG(s));

  const HEADER_SIZE = 6;
  const ENTRY_SIZE = 16;
  const dataOffset = HEADER_SIZE + ENTRY_SIZE * sizes.length;

  // Compute data offsets
  const offsets = [];
  let offset = dataOffset;
  for (const png of pngs) {
    offsets.push(offset);
    offset += png.length;
  }

  // ICONDIR header
  const header = Buffer.alloc(HEADER_SIZE);
  header.writeUInt16LE(0, 0); // reserved
  header.writeUInt16LE(1, 2); // type: 1 = ICO
  header.writeUInt16LE(sizes.length, 4); // count

  // Directory entries
  const entries = sizes.map((s, i) => {
    const entry = Buffer.alloc(ENTRY_SIZE);
    entry[0] = s === 256 ? 0 : s; // width  (0 = 256)
    entry[1] = s === 256 ? 0 : s; // height (0 = 256)
    entry[2] = 0; // color count (0 = no palette)
    entry[3] = 0; // reserved
    entry.writeUInt16LE(1, 4); // color planes
    entry.writeUInt16LE(32, 6); // bits per pixel
    entry.writeUInt32LE(pngs[i].length, 8); // size in bytes
    entry.writeUInt32LE(offsets[i], 12); // offset from file start
    return entry;
  });

  return Buffer.concat([header, ...entries, ...pngs]);
}

// ---------------------------------------------------------------------------
// ICNS builder — Apple icon container with PNG payloads
//
// ICNS format:
//   Magic:  'icns' (4 bytes)
//   Length: total file length including magic+length (4 bytes, big-endian)
//   [ OSType (4 bytes) + chunk length (4 bytes, includes 8-byte header) + data ]*
//
// PNG-in-ICNS OSTypes (used since OS X 10.7 Lion):
//   'ic07' = 128×128 (PNG)
//   'ic08' = 256×256 (PNG)
//   'ic09' = 512×512 (PNG)
//   'ic10' = 1024×1024 (PNG) — optional, we skip for size
//   'ic11' = 32×32 @2x (PNG)
//   'ic12' = 16×16 @2x (PNG)
//   'ic13' = 128×128 @2x (PNG)
//   'ic14' = 256×256 @2x (PNG)
// ---------------------------------------------------------------------------

function buildICNS(entries) {
  // entries: [{ osType: string, png: Buffer }, ...]
  const chunks = entries.map(({ osType, png }) => {
    const header = Buffer.alloc(8);
    Buffer.from(osType, 'ascii').copy(header, 0);
    header.writeUInt32BE(png.length + 8, 4); // chunk size includes 8-byte header
    return Buffer.concat([header, png]);
  });

  const body = Buffer.concat(chunks);
  const totalLength = 4 + 4 + body.length; // magic + length field + body

  const magic = Buffer.from('icns', 'ascii');
  const lengthBuf = Buffer.alloc(4);
  lengthBuf.writeUInt32BE(totalLength, 0);

  return Buffer.concat([magic, lengthBuf, body]);
}

// ---------------------------------------------------------------------------
// Validation — re-parse generated files to confirm correctness
// ---------------------------------------------------------------------------

function validatePNG(buf, expectedSize) {
  // Check PNG signature
  const sig = [137, 80, 78, 71, 13, 10, 26, 10];
  for (let i = 0; i < 8; i++) {
    if (buf[i] !== sig[i]) throw new Error(`PNG: bad signature at byte ${i}`);
  }
  // IHDR chunk: offset 8 (4-len) + 4 (type) = 8+4+4 = 16 starts data
  const width = buf.readUInt32BE(16);
  const height = buf.readUInt32BE(20);
  const bitDepth = buf[24];
  const colorType = buf[25];
  if (width !== expectedSize) throw new Error(`PNG: expected width ${expectedSize}, got ${width}`);
  if (height !== expectedSize)
    throw new Error(`PNG: expected height ${expectedSize}, got ${height}`);
  if (bitDepth !== 8) throw new Error(`PNG: expected bit depth 8, got ${bitDepth}`);
  if (colorType !== 6) throw new Error(`PNG: expected color type 6 (RGBA), got ${colorType}`);
  return { width, height, bitDepth, colorType };
}

function validateICO(buf, expectedSizes) {
  if (buf.readUInt16LE(0) !== 0) throw new Error('ICO: reserved field not 0');
  if (buf.readUInt16LE(2) !== 1) throw new Error('ICO: type field not 1');
  const count = buf.readUInt16LE(4);
  if (count !== expectedSizes.length)
    throw new Error(`ICO: expected ${expectedSizes.length} entries, got ${count}`);
  return { count };
}

function validateICNS(buf) {
  const magic = buf.slice(0, 4).toString('ascii');
  if (magic !== 'icns') throw new Error(`ICNS: bad magic "${magic}"`);
  const totalLen = buf.readUInt32BE(4);
  if (totalLen !== buf.length)
    throw new Error(`ICNS: declared length ${totalLen} != actual ${buf.length}`);
  if (totalLen < 16) throw new Error(`ICNS: suspiciously small (${totalLen} bytes)`);
  // Walk chunks
  const chunks = [];
  let pos = 8;
  while (pos < buf.length) {
    const osType = buf.slice(pos, pos + 4).toString('ascii');
    const chunkLen = buf.readUInt32BE(pos + 4);
    if (chunkLen < 8) throw new Error(`ICNS: chunk '${osType}' has invalid length ${chunkLen}`);
    chunks.push({ osType, chunkLen });
    pos += chunkLen;
  }
  return { totalLen, chunks };
}

// ---------------------------------------------------------------------------
// Main: generate all assets
// ---------------------------------------------------------------------------

console.log('Generating GraphVault desktop icons (RGBA PNG + ICO + ICNS)…');

// --- PNGs ---
const pngSpecs = [
  { file: '32x32.png', size: 32 },
  { file: '128x128.png', size: 128 },
  { file: '128x128@2x.png', size: 256 },
  { file: 'icon.png', size: 512 },
];

for (const { file, size } of pngSpecs) {
  const png = buildPNG(size);
  const info = validatePNG(png, size);
  const dest = resolve(ICONS_DIR, file);
  writeFileSync(dest, png);
  console.log(
    `  [PNG] ${file}  ${size}×${size}  color_type=${info.colorType} (RGBA)  ${png.length} bytes  OK`,
  );
}

// --- ICO ---
const icoSizes = [16, 32, 48, 256];
const ico = buildICO(icoSizes);
const icoInfo = validateICO(ico, icoSizes);
const icoPath = resolve(ICONS_DIR, 'icon.ico');
writeFileSync(icoPath, ico);
console.log(
  `  [ICO] icon.ico  sizes=${icoSizes.join('/')}  entries=${icoInfo.count}  ${ico.length} bytes  OK`,
);

// --- ICNS ---
// Build PNG payloads at each ICNS standard resolution
const icnsEntries = [
  { osType: 'ic07', size: 128 }, // 128×128
  { osType: 'ic08', size: 256 }, // 256×256
  { osType: 'ic09', size: 512 }, // 512×512
  { osType: 'ic11', size: 64 }, // 32×32 @2x
  { osType: 'ic12', size: 32 }, // 16×16 @2x
].map(({ osType, size }) => ({ osType, png: buildPNG(size) }));

const icns = buildICNS(icnsEntries);
const icnsInfo = validateICNS(icns);
const icnsPath = resolve(ICONS_DIR, 'icon.icns');
writeFileSync(icnsPath, icns);
console.log(
  `  [ICNS] icon.icns  chunks=${icnsInfo.chunks.map((c) => c.osType).join(',')}  total=${icnsInfo.totalLen} bytes  OK`,
);

console.log('\nAll desktop icons generated and validated successfully.');
console.log(
  'Tauri 2 bundle icon array entries:',
  [
    'icons/32x32.png',
    'icons/128x128.png',
    'icons/128x128@2x.png',
    'icons/icon.icns',
    'icons/icon.ico',
  ].join(', '),
);
