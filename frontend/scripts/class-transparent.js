// class-transparent.js <in.png> <class> [rotate] — pipeline for ALREADY-TRANSPARENT
// source renders (2026-07-18). No flood-key, no matte cleanup, no erosion: the
// source alpha is already a clean anti-aliased cutout, so we PRESERVE it exactly
// (that's what finally fixed the "rough edges" — keying white studio backdrops
// never could). Steps: (1) strip a leftover UNIFORM white background card if the
// export left one, guarded by local gradient so it can't eat the vehicle;
// (2) trim to the alpha bbox; (3) rotate nose-up; (4) fit into CLASS_SIZE.
const fs = require("fs");
const { PNG } = require("pngjs");
const [, , inPath, cls, rotArg] = process.argv;
if (!inPath || !cls) { console.log("usage: node class-transparent.js <in.png> <class> [rotate]"); process.exit(1); }
let img = PNG.sync.read(fs.readFileSync(inPath));
let W = img.width, H = img.height, D = img.data;
const idx = (x, y) => (y * W + x) << 2;

// (1) White-card removal (only touches images that HAVE one). Flood from the
// border through: transparent pixels (free) OR opaque near-white pixels whose
// local gradient is tiny (a uniform card, never a shaded car edge). Stops at the
// vehicle. A clean transparent source has no border-adjacent white card → no-op.
{
  const lumAt = (i) => 0.2126 * D[i] + 0.7152 * D[i + 1] + 0.0722 * D[i + 2];
  const grad = (x, y) => {
    const i = idx(x, y); let g = 0;
    for (const [dx, dy] of [[1, 0], [0, 1], [-1, 0], [0, -1]]) {
      const xx = x + dx, yy = y + dy; if (xx < 0 || yy < 0 || xx >= W || yy >= H) continue;
      const j = idx(xx, yy);
      g = Math.max(g, Math.abs(D[i] - D[j]), Math.abs(D[i + 1] - D[j + 1]), Math.abs(D[i + 2] - D[j + 2]));
    }
    return g;
  };
  const floodable = (x, y) => {
    const i = idx(x, y);
    if (D[i + 3] < 20) return true;                      // already transparent
    const mn = Math.min(D[i], D[i + 1], D[i + 2]);
    return mn > 232 && lumAt(i) > 240 && grad(x, y) < 12; // uniform near-white card
  };
  const seen = new Uint8Array(W * H);
  const q = [];
  const push = (x, y) => { if (x < 0 || y < 0 || x >= W || y >= H) return; const p = y * W + x; if (!seen[p]) { seen[p] = 1; q.push(p); } };
  for (let x = 0; x < W; x++) { push(x, 0); push(x, H - 1); }
  for (let y = 0; y < H; y++) { push(0, y); push(W - 1, y); }
  while (q.length) {
    const p = q.pop(); const x = p % W, y = (p / W) | 0;
    if (!floodable(x, y)) continue;
    D[idx(x, y) + 3] = 0;
    push(x - 1, y); push(x + 1, y); push(x, y - 1); push(x, y + 1);
  }
  // Nibble thin near-white card-edge strips the flood left behind: an opaque
  // near-white pixel with ≥6/8 transparent neighbours is a 1-2px floating sliver,
  // never solid vehicle body. Two passes clears the strips.
  for (let pass = 0; pass < 2; pass++) {
    const kill = [];
    for (let y = 1; y < H - 1; y++) for (let x = 1; x < W - 1; x++) {
      const i = idx(x, y); if (D[i + 3] < 200) continue;
      if (Math.min(D[i], D[i + 1], D[i + 2]) < 232) continue;
      let clear = 0;
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) { if (!dx && !dy) continue; if (D[idx(x + dx, y + dy) + 3] < 40) clear++; }
      if (clear >= 6) kill.push(i);
    }
    if (!kill.length) break;
    for (const i of kill) D[i + 3] = 0;
  }
}

// (2) trim to alpha bbox
let minX = W, minY = H, maxX = 0, maxY = 0;
for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
  if (D[idx(x, y) + 3] > 20) { if (x < minX) minX = x; if (x > maxX) maxX = x; if (y < minY) minY = y; if (y > maxY) maxY = y; }
}

// (3) rotate nose-up (0/90/180/270)
function rotate(png, deg) {
  const times = ((deg / 90) % 4 + 4) % 4; let cur = png;
  for (let t = 0; t < times; t++) {
    const out = new PNG({ width: cur.height, height: cur.width });
    for (let y = 0; y < cur.height; y++) for (let x = 0; x < cur.width; x++) {
      const si = (y * cur.width + x) << 2, dx = cur.height - 1 - y, dy = x, di = (dy * out.width + dx) << 2;
      for (let k = 0; k < 4; k++) out.data[di + k] = cur.data[si + k];
    }
    cur = out;
  }
  return cur;
}
img = rotate(img, parseInt(rotArg || "0", 10));
W = img.width; H = img.height; D = img.data;
// re-trim after rotation
minX = W; minY = H; maxX = 0; maxY = 0;
for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
  if (D[((y * W + x) << 2) + 3] > 20) { if (x < minX) minX = x; if (x > maxX) maxX = x; if (y < minY) minY = y; if (y > maxY) maxY = y; }
}
const cw = maxX - minX + 1, ch = maxY - minY + 1;

// (4) fit into CLASS_SIZE (contain, box-filtered) — premultiplied so the AA edge
// stays clean (no dark fringe from averaging color across transparent pixels).
const SIZE = parseInt(process.env.CLASS_SIZE || "512", 10), PAD = Math.max(2, Math.round(SIZE / 44));
const scale = Math.min((SIZE - PAD * 2) / cw, (SIZE - PAD * 2) / ch);
const ow = Math.max(1, Math.round(cw * scale)), oh = Math.max(1, Math.round(ch * scale));
const out = new PNG({ width: SIZE, height: SIZE });
const ox = ((SIZE - ow) / 2) | 0, oy = ((SIZE - oh) / 2) | 0;
for (let y = 0; y < oh; y++) for (let x = 0; x < ow; x++) {
  const sx0 = minX + x / scale, sx1 = minX + (x + 1) / scale, sy0 = minY + y / scale, sy1 = minY + (y + 1) / scale;
  let r = 0, g = 0, b = 0, a = 0, n = 0;
  for (let sy = Math.floor(sy0); sy < Math.min(H, Math.ceil(sy1)); sy++)
    for (let sx = Math.floor(sx0); sx < Math.min(W, Math.ceil(sx1)); sx++) {
      const i = (sy * W + sx) << 2, al = D[i + 3];
      r += D[i] * al; g += D[i + 1] * al; b += D[i + 2] * al; a += al; n++;
    }
  const di = ((y + oy) * SIZE + (x + ox)) << 2;
  if (n && a > 0) { out.data[di] = Math.round(r / a); out.data[di + 1] = Math.round(g / a); out.data[di + 2] = Math.round(b / a); out.data[di + 3] = Math.round(a / n); }
}
fs.mkdirSync("assets/images/classes-v2", { recursive: true });
fs.writeFileSync(`assets/images/classes-v2/${cls}.png`, PNG.sync.write(out));
console.log(`wrote ${cls}.png ${SIZE}x${SIZE} (content ${cw}x${ch}, rot ${rotArg || 0})`);
