#!/usr/bin/env node
/**
 * generate-pwa-icons.mjs
 *
 * Generates valid PNG files for the GraphVault PWA manifest without any
 * external dependencies - only Node.js built-ins (zlib, fs, path).
 *
 * Outputs:
 *   apps/web/public/icons/icon-192.png      - standard 192 × 192
 *   apps/web/public/icons/icon-512.png      - standard 512 × 512
 *   apps/web/public/icons/icon-512-maskable.png - same art, 512 × 512,
 *       safe zone inset so the mark fits inside the maskable icon circle.
 *
 * Brand:
 *   Background  #0a0a0a (brand dark)
 *   Nodes       #38bdf8 (sky-400)  hub | #818cf8 (indigo-400) satellite
 *   Edges       #1e3a5f (dark blue)
 */

import { deflateSync } from 'zlib';
import { writeFileSync, mkdirSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');
const ICONS_DIR = resolve(ROOT, 'apps/web/public/icons');

mkdirSync(ICONS_DIR, { recursive: true });

// ---------------------------------------------------------------------------
// Minimal PNG encoder - RGB (3 bytes/px), no alpha channel needed.
// Using RGB (colour type 2) keeps the encoder trivial.
// ---------------------------------------------------------------------------

function encodePNG(width, height, pixels /* Uint8Array, RGB rows */) {
  // PNG signature
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

  // IHDR chunk
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // colour type: RGB
  ihdr[10] = 0; // compression
  ihdr[11] = 0; // filter
  ihdr[12] = 0; // interlace

  // Apply PNG filter (None = 0) - prepend 0x00 to each row
  const filtered = Buffer.alloc(height * (1 + width * 3));
  for (let y = 0; y < height; y++) {
    filtered[y * (1 + width * 3)] = 0; // filter type None
    pixels.copy(filtered, y * (1 + width * 3) + 1, y * width * 3, (y + 1) * width * 3);
  }

  const compressed = deflateSync(filtered, { level: 6 });

  function chunk(type, data) {
    const typeBuf = Buffer.from(type, 'ascii');
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length, 0);
    const crcData = Buffer.concat([typeBuf, data]);
    const crc = crc32(crcData);
    const crcBuf = Buffer.alloc(4);
    crcBuf.writeUInt32BE(crc >>> 0, 0);
    return Buffer.concat([len, typeBuf, data, crcBuf]);
  }

  return Buffer.concat([
    sig,
    chunk('IHDR', ihdr),
    chunk('IDAT', compressed),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// CRC-32 lookup table
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
// Rasteriser - draw the GraphVault mark onto an RGB pixel buffer
// ---------------------------------------------------------------------------

/**
 * Draw an anti-aliased filled circle.
 * cx, cy, r - centre and radius in pixel units.
 * r, g, b   - fill colour 0-255.
 */
function drawCircle(pixels, width, height, cx, cy, r, col) {
  const [cr, cg, cb] = col;
  const rSq = r * r;
  const x0 = Math.max(0, Math.floor(cx - r - 1));
  const x1 = Math.min(width - 1, Math.ceil(cx + r + 1));
  const y0 = Math.max(0, Math.floor(cy - r - 1));
  const y1 = Math.min(height - 1, Math.ceil(cy + r + 1));
  for (let py = y0; py <= y1; py++) {
    for (let px = x0; px <= x1; px++) {
      const dx = px - cx;
      const dy = py - cy;
      const dist2 = dx * dx + dy * dy;
      if (dist2 <= rSq) {
        // simple fill - no AA for small circles, good enough at 192px+
        const idx = (py * width + px) * 3;
        pixels[idx] = cr;
        pixels[idx + 1] = cg;
        pixels[idx + 2] = cb;
      }
    }
  }
}

/**
 * Draw an anti-aliased line (Xiaolin Wu style, simplified to scanline).
 * Uses a stroke radius to make thicker lines.
 */
function drawLine(pixels, width, height, x0, y0, x1, y1, col, thickness) {
  const [cr, cg, cb] = col;
  const t = thickness / 2;
  // Rasterise as a thick line by stepping along the major axis
  const dx = x1 - x0;
  const dy = y1 - y0;
  const len = Math.sqrt(dx * dx + dy * dy);
  if (len === 0) return;
  const steps = Math.ceil(len * 2);
  for (let i = 0; i <= steps; i++) {
    const frac = i / steps;
    const px = x0 + dx * frac;
    const py = y0 + dy * frac;
    // Draw a small filled square (radius t) centered here
    for (
      let qy = Math.max(0, Math.floor(py - t));
      qy <= Math.min(height - 1, Math.ceil(py + t));
      qy++
    ) {
      for (
        let qx = Math.max(0, Math.floor(px - t));
        qx <= Math.min(width - 1, Math.ceil(px + t));
        qx++
      ) {
        const ddx = qx - px;
        const ddy = qy - py;
        if (ddx * ddx + ddy * ddy <= t * t) {
          const idx = (qy * width + qx) * 3;
          pixels[idx] = cr;
          pixels[idx + 1] = cg;
          pixels[idx + 2] = cb;
        }
      }
    }
  }
}

/**
 * Render the GraphVault brand mark at any size.
 *
 * The mark is three nodes arranged in a triangle with connecting edges:
 *   - Bottom-left node  (sky-400,    hub)
 *   - Top-right node    (sky-400,    hub)
 *   - Bottom-right node (indigo-400, satellite)
 * Edges between all three in a dark blue.
 *
 * @param {number} size      - canvas side (square)
 * @param {number} safePad   - extra padding factor for maskable safe zone (0-0.5)
 */
function renderMark(size, safePad = 0) {
  const pixels = Buffer.alloc(size * size * 3);

  // Background fill #0a0a0a
  pixels.fill(0x0a);

  const pad = size * (0.18 + safePad);
  const inner = size - 2 * pad;

  // Node positions (fractional of inner, then shifted by pad)
  // Mimics the SVG GraphMark: cx=5,cy=6 | cx=19,cy=8 | cx=12,cy=18
  // Normalised to 0-1 range over 24x24:
  //   A: (5/24, 6/24)  bottom-left - sky-400  (#38bdf8)
  //   B: (19/24, 8/24) top-right   - sky-400  (#38bdf8)
  //   C: (12/24, 18/24) bottom     - indigo-400 (#818cf8)
  const nodePos = [
    [5 / 24, 6 / 24], // A
    [19 / 24, 8 / 24], // B
    [12 / 24, 18 / 24], // C
  ];

  const pts = nodePos.map(([fx, fy]) => [pad + fx * inner, pad + fy * inner]);

  const edgeCol = [0x1e, 0x3a, 0x5f]; // #1e3a5f
  const skyCol = [0x38, 0xbd, 0xf8]; // #38bdf8 sky-400
  const indigoCol = [0x81, 0x8c, 0xf8]; // #818cf8 indigo-400

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
// Generate and write the three PNG files
// ---------------------------------------------------------------------------

function generate(filename, size, safePad = 0) {
  const pixels = renderMark(size, safePad);
  const png = encodePNG(size, size, pixels);
  const dest = resolve(ICONS_DIR, filename);
  writeFileSync(dest, png);
  console.log(`  wrote ${dest}  (${png.length} bytes)`);
}

console.log('Generating GraphVault PWA icons…');
generate('icon-192.png', 192);
generate('icon-512.png', 512);
// Maskable: 10% safe-zone inset on each side (20% total), per spec
generate('icon-512-maskable.png', 512, 0.1);
console.log('Done.');
