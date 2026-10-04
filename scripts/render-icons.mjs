import { deflateSync } from 'node:zlib';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  }
  return (~crc) >>> 0;
}

function chunk(type, data) {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(data.length, 0);
  head.write(type, 4);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([Buffer.from(type), data])));
  return Buffer.concat([head, data, crc]);
}

function encodePng(width, height, rgba) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y += 1) {
    const row = y * (width * 4 + 1);
    raw[row] = 0;
    rgba.copy(raw, row + 1, y * width * 4, (y + 1) * width * 4);
  }
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  return Buffer.concat([
    signature,
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

function inside(x, y, polygon) {
  let hit = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i, i += 1) {
    const [xi, yi] = polygon[i];
    const [xj, yj] = polygon[j];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) hit = !hit;
  }
  return hit;
}

function inRoundedRect(nx, ny) {
  const margin = 0.06;
  const radius = 0.18;
  const left = margin;
  const right = 1 - margin;
  const top = margin;
  const bottom = 1 - margin;
  if (nx < left || nx > right || ny < top || ny > bottom) return false;
  const cx = nx < left + radius ? left + radius : nx > right - radius ? right - radius : nx;
  const cy = ny < top + radius ? top + radius : ny > bottom - radius ? bottom - radius : ny;
  const dx = nx - cx;
  const dy = ny - cy;
  return dx * dx + dy * dy <= radius * radius || (nx >= left + radius && nx <= right - radius) || (ny >= top + radius && ny <= bottom - radius);
}

function paint(size) {
  const rgba = Buffer.alloc(size * size * 4);
  const parcel = [
    [0.22, 0.70],
    [0.34, 0.28],
    [0.58, 0.20],
    [0.80, 0.40],
    [0.66, 0.78],
    [0.36, 0.82],
  ];
  const selected = [
    [0.58, 0.20],
    [0.80, 0.40],
    [0.70, 0.56],
    [0.52, 0.38],
  ];
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const nx = (x + 0.5) / size;
      const ny = (y + 0.5) / size;
      const offset = (y * size + x) * 4;
      if (!inRoundedRect(nx, ny)) continue;
      let color = [30, 58, 50, 255];
      if (inside(nx, ny, parcel)) color = [231, 199, 161, 255];
      if (inside(nx, ny, selected)) color = [184, 97, 58, 255];
      rgba[offset] = color[0];
      rgba[offset + 1] = color[1];
      rgba[offset + 2] = color[2];
      rgba[offset + 3] = color[3];
    }
  }
  return encodePng(size, size, rgba);
}

await mkdir(path.join(root, 'extension/icons'), { recursive: true });
await mkdir(path.join(root, 'public'), { recursive: true });
for (const size of [16, 32, 48, 128]) {
  const png = paint(size);
  await writeFile(path.join(root, 'extension/icons', `icon${size}.png`), png);
  if (size === 128) await writeFile(path.join(root, 'public/icon128.png'), png);
}
