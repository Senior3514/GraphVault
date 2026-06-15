#!/usr/bin/env node
/**
 * apps/extension/scripts/generate-icons.mjs
 *
 * Generates PNG icons for the GraphVault Web Clipper extension at the
 * standard browser-extension sizes: 16, 32, 48, 128.
 *
 * Firefox requires bitmap toolbar icons (SVG is not accepted in
 * action.default_icon).  Chrome and Edge accept both, but PNGs are
 * universally supported.
 *
 * Zero external dependencies — uses only Node.js built-ins: zlib, fs, path.
 *
 * Outputs to apps/extension/icons/:
 *   icon16.png   —  16 x  16  RGBA PNG  (toolbar)
 *   icon32.png   —  32 x  32  RGBA PNG  (toolbar @2x / Windows)
 *   icon48.png   —  48 x  48  RGBA PNG  (extension management page)
 *   icon128.png  — 128 x 128  RGBA PNG  (Chrome Web Store listing)
 *
 * Brand:
 *   Background  transparent (alpha=0) — floats on any browser chrome
 *   Nodes/edges #5b6aff (brand accent, matches popup.css --accent)
 */

import { deflateSync } from 'zlib';
import { writeFileSync, mkdirSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const EXTENSION_DIR = resolve(__dirname, '..');
const ICONS_DIR = resolve(EXTENSION_DIR, 'icons');

mkdirSync(ICONS_DIR, { recursive: true });

// ---------------------------------------------------------------------------
// CRC-32 (required by PNG chunk checksums)
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
// PNG encoder: RGBA, color type 6, 8 bits per channel
// ---------------------------------------------------------------------------

function encodePNG(width, height, pixels) {
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // colour type 6 = RGBA
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;

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
    const crcBuf = Buffer.alloc(4);
    crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
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
// Rasteriser
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
        const alpha = dist > r - 1 ? Math.round((r - dist) * (ca ?? 255)) : (ca ?? 255);
        const idx = (py * width + px) * 4;
        const srcA = alpha / 255;
        const bgA = pixels[idx + 3] / 255;
        const outA = srcA + bgA * (1 - srcA);
        if (outA > 0) {
          pixels[idx]     = Math.round((cr * srcA + pixels[idx]     * bgA * (1 - srcA)) / outA);
          pixels[idx + 1] = Math.round((cg * srcA + pixels[idx + 1] * bgA * (1 - srcA)) / outA);
          pixels[idx + 2] = Math.round((cb * srcA + pixels[idx + 2] * bgA * (1 - srcA)) / outA);
          pixels[idx + 3] = Math.round(outA * 255);
        }
      }
    }
  }
}

function drawLine(pixels, width, height, x0, y0, x1, y1, col, thickness) {
  const [cr, cg, cb, ca] = col;
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
          const srcA = (ca ?? 255) / 255;
          const bgA = pixels[idx + 3] / 255;
          const outA = srcA + bgA * (1 - srcA);
          if (outA > 0) {
            pixels[idx]     = Math.round((cr * srcA + pixels[idx]     * bgA * (1 - srcA)) / outA);
            pixels[idx + 1] = Math.round((cg * srcA + pixels[idx + 1] * bgA * (1 - srcA)) / outA);
            pixels[idx + 2] = Math.round((cb * srcA + pixels[idx + 2] * bgA * (1 - srcA)) / outA);
            pixels[idx + 3] = Math.round(outA * 255);
          }
        }
      }
    }
  }
}

/**
 * Render the GraphVault brand mark: three nodes in a triangle with three
 * connecting edges.  Background is fully transparent.
 */
function renderMark(size) {
  const pixels = Buffer.alloc(size * size * 4, 0); // transparent

  // Brand accent #5b6aff
  const nodeCol = [0x5b, 0x6a, 0xff, 255];
  // Edges at 70% opacity so nodes stand out on top
  const edgeCol = [0x5b, 0x6a, 0xff, 178];

  // Node positions as fractions of the inner drawing area.
  // Matches the SVG icon geometry: top, bottom-left, bottom-right.
  const pad = size * 0.10;
  const inner = size - 2 * pad;

  const nodePos = [
    [0.50, 0.18], // top
    [0.18, 0.82], // bottom-left
    [0.82, 0.82], // bottom-right
  ];

  const pts = nodePos.map(([fx, fy]) => [pad + fx * inner, pad + fy * inner]);

  const nodeR = Math.max(1.5, size * 0.10);
  const edgeW = Math.max(1.0, size * 0.055);

  // Edges first (behind nodes)
  drawLine(pixels, size, size, pts[0][0], pts[0][1], pts[1][0], pts[1][1], edgeCol, edgeW);
  drawLine(pixels, size, size, pts[0][0], pts[0][1], pts[2][0], pts[2][1], edgeCol, edgeW);
  drawLine(pixels, size, size, pts[1][0], pts[1][1], pts[2][0], pts[2][1], edgeCol, edgeW);

  // Nodes on top
  drawCircle(pixels, size, size, pts[0][0], pts[0][1], nodeR, nodeCol);
  drawCircle(pixels, size, size, pts[1][0], pts[1][1], nodeR, nodeCol);
  drawCircle(pixels, size, size, pts[2][0], pts[2][1], nodeR, nodeCol);

  return pixels;
}

// ---------------------------------------------------------------------------
// Box-filter scale-down for better quality at small sizes
// ---------------------------------------------------------------------------

function scaleDown(srcPixels, srcSize, dstSize) {
  if (srcSize === dstSize) return srcPixels;
  const dst = Buffer.alloc(dstSize * dstSize * 4);
  const scale = srcSize / dstSize;
  for (let dy = 0; dy < dstSize; dy++) {
    for (let dx = 0; dx < dstSize; dx++) {
      let r = 0, g = 0, b = 0, a = 0, count = 0;
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
      dst[di]     = Math.round(r / count);
      dst[di + 1] = Math.round(g / count);
      dst[di + 2] = Math.round(b / count);
      dst[di + 3] = Math.round(a / count);
    }
  }
  return dst;
}

// Render at master size (128), then scale down for smaller targets.
const MASTER_SIZE = 128;
let _masterPixels = null;

function getMasterPixels() {
  if (!_masterPixels) _masterPixels = renderMark(MASTER_SIZE);
  return _masterPixels;
}

function buildPNG(size) {
  const pixels =
    size >= MASTER_SIZE
      ? renderMark(size)
      : scaleDown(getMasterPixels(), MASTER_SIZE, size);
  return encodePNG(size, size, pixels);
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

function validatePNG(buf, expectedSize) {
  const sig = [137, 80, 78, 71, 13, 10, 26, 10];
  for (let i = 0; i < 8; i++) {
    if (buf[i] !== sig[i]) throw new Error(`PNG: bad signature at byte ${i}`);
  }
  const width     = buf.readUInt32BE(16);
  const height    = buf.readUInt32BE(20);
  const bitDepth  = buf[24];
  const colorType = buf[25];
  if (width  !== expectedSize) throw new Error(`PNG: expected width ${expectedSize}, got ${width}`);
  if (height !== expectedSize) throw new Error(`PNG: expected height ${expectedSize}, got ${height}`);
  if (bitDepth  !== 8) throw new Error(`PNG: expected bit depth 8, got ${bitDepth}`);
  if (colorType !== 6) throw new Error(`PNG: expected color type 6 (RGBA), got ${colorType}`);
  return { width, height, bitDepth, colorType };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

const SIZES = [16, 32, 48, 128];

console.log('Generating GraphVault extension icons (RGBA PNG)...');
console.log('Output: ' + ICONS_DIR);

for (const size of SIZES) {
  const png  = buildPNG(size);
  const info = validatePNG(png, size);
  const filename = 'icon' + size + '.png';
  const dest = resolve(ICONS_DIR, filename);
  writeFileSync(dest, png);
  console.log(
    '  [PNG] ' + filename + '  ' + size + 'x' + size +
    '  color_type=' + info.colorType + ' (RGBA)  ' + png.length + ' bytes  OK',
  );
}

console.log('\nAll extension icons generated and validated.');
