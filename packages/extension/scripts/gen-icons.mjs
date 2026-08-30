// Generates the extension action icons as PNGs with no image dependencies:
// raw RGBA -> zlib deflate -> hand-built chunks.
//
// The motif is a suspension bridge (white on blue). Icon design is
// size-specific: 128/48/32 use the full drawing (towers, catenary cable,
// deck, lit tower tops); 16 uses a simplified pixel-aligned glyph (towers,
// cable, deck) that stays legible in the toolbar.
import { deflateSync } from "node:zlib";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const outDir = join(dirname(fileURLToPath(import.meta.url)), "..", "icons");
mkdirSync(outDir, { recursive: true });

// ---- PNG encoding ----

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, "ascii");
  data.copy(out, 8);
  out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length);
  return out;
}

function encodePng(size, rgba) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y++) {
    rgba.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

// ---- geometry helpers ----

/** Flatten a quadratic bezier into a polyline. */
function quadratic(p0, p1, p2, n = 64) {
  const pts = [];
  for (let i = 0; i <= n; i++) {
    const t = i / n;
    const u = 1 - t;
    pts.push([
      u * u * p0[0] + 2 * u * t * p1[0] + t * t * p2[0],
      u * u * p0[1] + 2 * u * t * p1[1] + t * t * p2[1],
    ]);
  }
  return pts;
}

function distToPolyline(x, y, pts) {
  let best = Infinity;
  for (let i = 0; i < pts.length - 1; i++) {
    const [ax, ay] = pts[i];
    const [bx, by] = pts[i + 1];
    const dx = bx - ax;
    const dy = by - ay;
    const len2 = dx * dx + dy * dy;
    const t =
      len2 === 0
        ? 0
        : Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / len2));
    best = Math.min(best, Math.hypot(x - (ax + t * dx), y - (ay + t * dy)));
  }
  return best;
}

const inBar = (x, y, x0, x1, cy, half) =>
  x >= x0 && x <= x1 && Math.abs(y - cy) <= half;
const inCol = (x, y, cx, half, y0, y1) =>
  y >= y0 && y <= y1 && Math.abs(x - cx) <= half;

// ---- the two drawings ----
// Each returns 'blue' | 'white' | null for a sample point (background handled
// separately). 'blue' punches the node centers back to the background color.

function fullGlyph(s) {
  const cable = quadratic(
    [0.14 * s, 0.42 * s],
    [0.5 * s, 0.72 * s],
    [0.86 * s, 0.42 * s],
  );
  return (x, y) => {
    // lit tower tops, with a background-colored core
    for (const cx of [0.22 * s, 0.78 * s]) {
      const d = Math.hypot(x - cx, y - 0.3 * s);
      if (d <= 0.06 * s) return d <= 0.0252 * s ? "blue" : "white";
    }
    if (distToPolyline(x, y, cable) <= 0.0275 * s) return "white";
    if (inBar(x, y, 0.1 * s, 0.9 * s, 0.72 * s, 0.0275 * s)) return "white";
    if (inCol(x, y, 0.22 * s, 0.03 * s, 0.34 * s, 0.72 * s)) return "white";
    if (inCol(x, y, 0.78 * s, 0.03 * s, 0.34 * s, 0.72 * s)) return "white";
    return null;
  };
}

/** The 16px glyph: towers + cable + deck, pixel-aligned, no nodes. */
function smallGlyph() {
  const cable = quadratic([2, 6], [8, 12.5], [14, 6]);
  return (x, y) => {
    if (x >= 1 && x < 15 && y >= 11 && y < 13) return "white"; // deck
    if (x >= 3 && x < 5 && y >= 4 && y < 11) return "white"; // towers
    if (x >= 11 && x < 13 && y >= 4 && y < 11) return "white";
    if (distToPolyline(x, y, cable) <= 1) return "white"; // cable
    return null;
  };
}

const BLUE = [0x1a, 0x66, 0xc2];
const WHITE = [0xff, 0xff, 0xff];

function render(size, glyph) {
  const rgba = Buffer.alloc(size * size * 4);
  const radius = size * 0.2;
  const samples = 3; // 3x3 supersampling
  for (let py = 0; py < size; py++) {
    for (let px = 0; px < size; px++) {
      let bgHits = 0;
      let fgWhite = 0;
      let fgBlue = 0;
      for (let sy = 0; sy < samples; sy++) {
        for (let sx = 0; sx < samples; sx++) {
          const x = px + (sx + 0.5) / samples;
          const y = py + (sy + 0.5) / samples;
          const cx = Math.max(radius - x, x - (size - radius), 0);
          const cy = Math.max(radius - y, y - (size - radius), 0);
          if (cx * cx + cy * cy > radius * radius) continue; // outside rounded square
          bgHits++;
          const hit = glyph(x, y);
          if (hit === "white") fgWhite++;
          else if (hit === "blue") fgBlue++;
        }
      }
      const total = samples * samples;
      const alpha = bgHits / total;
      if (alpha === 0) continue;
      // Composite: white glyph over blue; 'blue' samples stay background.
      const whiteRatio = fgWhite / bgHits;
      const i = (py * size + px) * 4;
      for (let c = 0; c < 3; c++) {
        rgba[i + c] = Math.round(
          BLUE[c] * (1 - whiteRatio) + WHITE[c] * whiteRatio,
        );
      }
      rgba[i + 3] = Math.round(alpha * 255);
    }
  }
  return rgba;
}

for (const size of [128, 48, 32]) {
  writeFileSync(
    join(outDir, `icon${size}.png`),
    encodePng(size, render(size, fullGlyph(size))),
  );
}
writeFileSync(
  join(outDir, "icon16.png"),
  encodePng(16, render(16, smallGlyph())),
);
console.log(`icons written to ${outDir}`);
