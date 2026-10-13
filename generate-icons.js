// Run with: node generate-icons.js
// Writes icons/icon-192.png and icons/icon-512.png with no extra packages.
const fs = require('fs');
const zlib = require('zlib');
const path = require('path');

function crc32(buf) {
  let c = ~0;
  for (let i = 0; i < buf.length; i++) {
    c ^= buf[i];
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return ~c >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([len, body, crc]);
}

function mix(a, b, t) {
  return a + (b - a) * t;
}

function pixel(x, y, size) {
  const nx = x / (size - 1);
  const ny = y / (size - 1);
  let r = mix(7, 15, ny);
  let g = mix(22, 36, ny);
  let b = mix(40, 68, ny);

  const waves = [
    { base: 0.58, amp: 0.045, freq: 2.2, color: [0, 196, 160] },
    { base: 0.70, amp: 0.038, freq: 3.1, color: [30, 144, 255] },
  ];
  for (const wave of waves) {
    const crest = wave.base + Math.sin(nx * Math.PI * wave.freq + 0.4) * wave.amp;
    if (ny >= crest) {
      const depth = Math.min(1, (ny - crest) / 0.32);
      const cover = 0.82 * (1 - depth * 0.35);
      r = mix(r, wave.color[0], cover);
      g = mix(g, wave.color[1], cover);
      b = mix(b, wave.color[2], cover);
    } else if (ny > crest - 0.012) {
      r = mix(r, 244, 0.85);
      g = mix(g, 251, 0.85);
      b = mix(b, 255, 0.85);
    }
  }

  return [Math.max(0, Math.min(255, r)), Math.max(0, Math.min(255, g)), Math.max(0, Math.min(255, b))];
}

function makePNG(size) {
  const stride = 1 + size * 3;
  const raw = Buffer.alloc(size * stride);
  for (let y = 0; y < size; y++) {
    const row = y * stride;
    raw[row] = 0;
    for (let x = 0; x < size; x++) {
      const [r, g, b] = pixel(x, y, size);
      const i = row + 1 + x * 3;
      raw[i] = r;
      raw[i + 1] = g;
      raw[i + 2] = b;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  return Buffer.concat([
    sig,
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

const dir = path.join(__dirname, 'icons');
fs.mkdirSync(dir, { recursive: true });
fs.writeFileSync(path.join(dir, 'icon-192.png'), makePNG(192));
fs.writeFileSync(path.join(dir, 'icon-512.png'), makePNG(512));
console.log('Wrote icons/icon-192.png and icons/icon-512.png');
