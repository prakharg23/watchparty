// Generates simple PNG icons (purple rounded square with a white play triangle)
// without any dependencies. Run: node make-icons.js
import fs from "node:fs";
import zlib from "node:zlib";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const outDir = path.join(here, "extension", "icons");
fs.mkdirSync(outDir, { recursive: true });

function crc32(buf) {
  let c,
    crc = 0xffffffff;
  for (let n = 0; n < buf.length; n++) {
    c = (crc ^ buf[n]) & 0xff;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    crc = (crc >>> 8) ^ c;
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}

function png(size) {
  const raw = Buffer.alloc((size * 4 + 1) * size);
  const r = size * 0.22; // corner radius
  const cx = size / 2;
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0; // filter byte
    for (let x = 0; x < size; x++) {
      const i = y * (size * 4 + 1) + 1 + x * 4;
      // Rounded square mask
      const dx = Math.max(Math.abs(x + 0.5 - cx) - (cx - r), 0);
      const dy = Math.max(Math.abs(y + 0.5 - cx) - (cx - r), 0);
      const inside = Math.hypot(dx, dy) <= r;
      if (!inside) {
        raw[i + 3] = 0;
        continue;
      }
      // Gradient background: #6c5ce7 -> #a855f7
      const t = (x + y) / (2 * size);
      let R = Math.round(0x6c + (0xa8 - 0x6c) * t);
      let G = Math.round(0x5c + (0x55 - 0x5c) * t);
      let B = Math.round(0xe7 + (0xf7 - 0xe7) * t);
      // Play triangle
      const px = (x + 0.5 - size * 0.40) / (size * 0.32);
      const py = (y + 0.5 - size * 0.5) / (size * 0.30);
      if (px >= 0 && px <= 1 && Math.abs(py) <= 1 - px) {
        R = G = B = 255;
      }
      raw[i] = R;
      raw[i + 1] = G;
      raw[i + 2] = B;
      raw[i + 3] = 255;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", zlib.deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

for (const s of [16, 48, 128]) {
  fs.writeFileSync(path.join(outDir, `icon${s}.png`), png(s));
  console.log(`wrote icon${s}.png`);
}
