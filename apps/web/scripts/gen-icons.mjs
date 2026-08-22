#!/usr/bin/env node
// Génère les icônes PWA (PNG 192/512/180 + favicon SVG) sans dépendance : encodeur PNG minimal
// (zlib + CRC32) dessinant un « M » pixel-art sur fond vert sombre. Relancer : `pnpm icons`.
import { deflateSync } from 'node:zlib';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const OUT = path.resolve(import.meta.dirname, '../public');
mkdirSync(OUT, { recursive: true });

// Grille 12×12 : 0 = fond, 1 = bloc « herbe », 2 = bloc « terre » (M stylisé).
const GRID = [
  '............',
  '............',
  '..11....11..',
  '..11....11..',
  '..1111.111..',
  '..11.11.11..',
  '..11....11..',
  '..22....22..',
  '..22....22..',
  '..22....22..',
  '............',
  '............',
];
const COLORS = {
  bg: [0x14, 0x15, 0x17, 255],
  1: [0x4c, 0xaf, 0x50, 255],
  2: [0x8d, 0x5a, 0x2b, 255],
};

const CRC_TABLE = new Int32Array(256).map((_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c;
});
function crc32(buf) {
  let c = -1;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}
function png(size, { radius = 0, padding = 0 } = {}) {
  const rows = [];
  const cell = (size - padding * 2) / GRID.length;
  for (let y = 0; y < size; y++) {
    const row = Buffer.alloc(1 + size * 4);
    row[0] = 0;
    for (let x = 0; x < size; x++) {
      const gx = Math.floor((x - padding) / cell);
      const gy = Math.floor((y - padding) / cell);
      const ch = GRID[gy]?.[gx] ?? '.';
      let color = ch === '.' ? COLORS.bg : COLORS[ch];
      if (radius > 0) {
        const dx = Math.max(radius - x, x - (size - 1 - radius), 0);
        const dy = Math.max(radius - y, y - (size - 1 - radius), 0);
        if (dx * dx + dy * dy > radius * radius) color = [0, 0, 0, 0];
      }
      row.set(color, 1 + x * 4);
    }
    rows.push(row);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(Buffer.concat(rows), { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

writeFileSync(path.join(OUT, 'pwa-192.png'), png(192));
writeFileSync(path.join(OUT, 'pwa-512.png'), png(512));
writeFileSync(path.join(OUT, 'apple-touch-icon.png'), png(180));

const rects = GRID.flatMap((row, y) =>
  [...row].flatMap((ch, x) =>
    ch === '.'
      ? []
      : [
          `<rect x="${x}" y="${y}" width="1" height="1" fill="${ch === '1' ? '#4caf50' : '#8d5a2b'}"/>`,
        ],
  ),
);
writeFileSync(
  path.join(OUT, 'favicon.svg'),
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 12 12" shape-rendering="crispEdges"><rect width="12" height="12" rx="2" fill="#141517"/>${rects.join('')}</svg>\n`,
);
console.log(`icons written to ${OUT}`);
