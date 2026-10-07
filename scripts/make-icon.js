// Рисует иконку приложения — листок заметки с кошачьими ушками в цветах MeowsConvert (без внешних зависимостей):
//   assets/icon.png       — 512px
//   assets/icon.ico       — все размеры для Windows (exe, ярлыки, Пуск)
//   assets/tray.ico       — трей (упрощённый рисунок, чтобы читалось в 16px)
//   assets/icon-small.png — 64px, значок в шапке виджета
//   build/icon.ico        — для electron-builder
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const root = path.join(__dirname, '..');

const hex = (h) => [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)];
const ACCENT = hex('#ff9f0a');
const FACE = hex('#121214');
const EAR_INNER = hex('#3d3222');
const LINE = hex('#8e8e93');
const LINE_MAIN = hex('#f5cf8a');
const WHITE = hex('#ffffff');

// ---------- Фигуры в координатах 0..1 ----------

function inRoundRect(x, y, r) {
  const qx = Math.max(Math.abs(x - 0.5) - (0.5 - r), 0);
  const qy = Math.max(Math.abs(y - 0.5) - (0.5 - r), 0);
  return qx * qx + qy * qy <= r * r;
}

const inCircle = (x, y, cx, cy, r) => (x - cx) ** 2 + (y - cy) ** 2 <= r * r;

function inTriangle(x, y, [a, b, c]) {
  const s = (p, q) => (x - q[0]) * (p[1] - q[1]) - (p[0] - q[0]) * (y - q[1]);
  const d1 = s(a, b), d2 = s(b, c), d3 = s(c, a);
  return !((d1 < 0 || d2 < 0 || d3 < 0) && (d1 > 0 || d2 > 0 || d3 > 0));
}

// Отрезок со скруглёнными концами
function inCapsule(x, y, x1, y1, x2, y2, r) {
  const dx = x2 - x1, dy = y2 - y1;
  const t = Math.max(0, Math.min(1, ((x - x1) * dx + (y - y1) * dy) / (dx * dx + dy * dy)));
  return inCircle(x, y, x1 + t * dx, y1 + t * dy, r);
}

// ---------- Рисунок ----------

// Прямоугольник [x0..x1]×[y0..y1] со скруглением r
function inBox(x, y, x0, y0, x1, y1, r) {
  const qx = Math.max(Math.abs(x - (x0 + x1) / 2) - ((x1 - x0) / 2 - r), 0);
  const qy = Math.max(Math.abs(y - (y0 + y1) / 2) - ((y1 - y0) / 2 - r), 0);
  return qx * qx + qy * qy <= r * r;
}

// Слои снизу вверх: [проверка попадания, цвет]. simple — для мелких размеров: толще рамка, две строки.
function layers(simple) {
  const earL = [[0.2, 0.4], [0.25, 0.08], [0.47, 0.3]];
  const earR = earL.map(([x, y]) => [1 - x, y]);
  const shrink = (tri) => {
    const mx = (tri[0][0] + tri[1][0] + tri[2][0]) / 3, my = (tri[0][1] + tri[1][1] + tri[2][1]) / 3;
    return tri.map(([x, y]) => [mx + (x - mx) * 0.5, my + (y - my) * 0.5 + 0.02]);
  };
  const border = simple ? 0.075 : 0.055;
  const [x0, y0, x1, y1] = [0.16, 0.26, 0.84, 0.88];

  const list = [
    [(x, y) => inRoundRect(x, y, 0.22), (x, y) => mix(hex('#2a2a2e'), hex('#101012'), y)],
    [(x, y) => inTriangle(x, y, earL) || inTriangle(x, y, earR), ACCENT],
  ];
  if (!simple) list.push([(x, y) => inTriangle(x, y, shrink(earL)) || inTriangle(x, y, shrink(earR)), EAR_INNER]);
  list.push([(x, y) => inBox(x, y, x0, y0, x1, y1, 0.1), ACCENT]);
  list.push([(x, y) => inBox(x, y, x0 + border, y0 + border, x1 - border, y1 - border, 0.1 - border / 2), FACE]);

  const rows = simple
    ? [[0.46, 0.68, LINE_MAIN], [0.65, 0.56, WHITE]]
    : [[0.43, 0.68, LINE_MAIN], [0.555, 0.68, WHITE], [0.68, 0.52, LINE]];
  const lw = simple ? 0.045 : 0.026;
  for (const [ly, lx2, color] of rows) list.push([(x, y) => inCapsule(x, y, 0.32, ly, lx2, ly, lw), color]);
  return list;
}

function mix(a, b, t) {
  return a.map((v, i) => v + (b[i] - v) * t);
}

// Отрисовка с суперсэмплингом: цвет усредняется по подвыборкам пикселя
function render(size, simple) {
  const shapes = layers(simple);
  const ss = size <= 64 ? 8 : 3;
  const out = Buffer.alloc(size * size * 4);
  for (let py = 0; py < size; py++) {
    for (let px = 0; px < size; px++) {
      let r = 0, g = 0, b = 0, a = 0;
      for (let sy = 0; sy < ss; sy++) {
        for (let sx = 0; sx < ss; sx++) {
          const x = (px + (sx + 0.5) / ss) / size;
          const y = (py + (sy + 0.5) / ss) / size;
          let color = null;
          for (const [hit, c] of shapes) {
            if (hit(x, y)) color = typeof c === 'function' ? c(x, y) : c;
          }
          if (color) {
            r += color[0];
            g += color[1];
            b += color[2];
            a++;
          }
        }
      }
      const o = (py * size + px) * 4;
      if (a) {
        out[o] = Math.round(r / a);
        out[o + 1] = Math.round(g / a);
        out[o + 2] = Math.round(b / a);
        out[o + 3] = Math.round((a / (ss * ss)) * 255);
      }
    }
  }
  return out;
}

// ---------- PNG / ICO: запись ----------

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

function crc32(buf) {
  let c = 0xffffffff;
  for (const byte of buf) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}

function encodePng(rgba, size) {
  const raw = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y++) {
    rgba.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

function encodeIco(images) {
  const header = Buffer.alloc(6 + 16 * images.length);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(images.length, 4);
  let offset = header.length;
  images.forEach(({ size, png }, i) => {
    const e = 6 + 16 * i;
    header[e] = size >= 256 ? 0 : size;
    header[e + 1] = size >= 256 ? 0 : size;
    header.writeUInt16LE(1, e + 4);
    header.writeUInt16LE(32, e + 6);
    header.writeUInt32LE(png.length, e + 8);
    header.writeUInt32LE(offset, e + 12);
    offset += png.length;
  });
  return Buffer.concat([header, ...images.map((im) => im.png)]);
}

// ---------- Сборка ----------

const pngOf = (size, simple = size <= 32) => encodePng(render(size, simple), size);

const appIco = encodeIco([16, 20, 24, 32, 40, 48, 64, 96, 128, 256].map((size) => ({ size, png: pngOf(size) })));
const trayIco = encodeIco([16, 20, 24, 32, 40, 48].map((size) => ({ size, png: pngOf(size, true) })));

fs.mkdirSync(path.join(root, 'assets'), { recursive: true });
fs.mkdirSync(path.join(root, 'build'), { recursive: true });
fs.writeFileSync(path.join(root, 'assets', 'icon.png'), pngOf(512));
fs.writeFileSync(path.join(root, 'assets', 'icon-small.png'), pngOf(64));
fs.writeFileSync(path.join(root, 'assets', 'icon.ico'), appIco);
fs.writeFileSync(path.join(root, 'assets', 'tray.ico'), trayIco);
fs.writeFileSync(path.join(root, 'build', 'icon.ico'), appIco);

console.log('Иконки созданы: assets/icon.png, icon-small.png, icon.ico, tray.ico, build/icon.ico');
