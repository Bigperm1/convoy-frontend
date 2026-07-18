// class-asset.js <input.png> <class> <rotate:0|90|180|270>
// Normalizes a top-down vehicle photo into the GRC marker format:
//   1. key out the studio background (flood from the borders on near-uniform color)
//   2. rotate so the nose points UP
//   3. trim to content + fit into a 44x44 transparent canvas (GRC parity)
//   4. write assets/images/classes/<class>.png
// PNG input only — convert JPEGs first: `sips -s format png in.jpeg --out in.png`
const fs = require("fs");
const { PNG } = require("pngjs");
const [,, inPath, cls, rotArg, tolArg] = process.argv;
if (!inPath || !cls) { console.log("usage: node class-asset.js <in.png> <class> [rotate]"); process.exit(1); }
let img = PNG.sync.read(fs.readFileSync(inPath));

// 1) background key: sample border pixels, flood-fill matching colors to alpha 0.
const W = img.width, H = img.height, D = img.data;
const idx = (x, y) => (y * W + x) << 2;

// Blur-mask: run the background MATCH test on a box-blurred copy so grainy
// textures (asphalt) average out to a uniform key color; alpha is still
// applied to the ORIGINAL pixels so the car keeps its detail.
const BLUR = new Uint8ClampedArray(D.length);
BLUR.set(D);
const R = 3;
for (let pass = 0; pass < 2; pass++) {
  const src = BLUR.slice();
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    let r = 0, g = 0, b = 0, n = 0;
    for (let dy = -R; dy <= R; dy += R) for (let dx = -R; dx <= R; dx += R) {
      const xx = x + dx, yy = y + dy;
      if (xx < 0 || yy < 0 || xx >= W || yy >= H) continue;
      const i = idx(xx, yy); r += src[i]; g += src[i + 1]; b += src[i + 2]; n++;
    }
    const i = idx(x, y);
    BLUR[i] = r / n; BLUR[i + 1] = g / n; BLUR[i + 2] = b / n;
  }
}
const border = [];
for (let x = 0; x < W; x += 7) { border.push(idx(x, 0), idx(x, H - 1)); }
for (let y = 0; y < H; y += 7) { border.push(idx(0, y), idx(W - 1, y)); }
const br = border.reduce((s, i) => s + BLUR[i], 0) / border.length;
const bg = border.reduce((s, i) => s + BLUR[i + 1], 0) / border.length;
const bb = border.reduce((s, i) => s + BLUR[i + 2], 0) / border.length;
const TOL = parseInt(tolArg || "34", 10); // tolerance vs the sampled background (studio grey/white gradients)
// Edge barrier (CLASS_EDGE, 0 = off): with a barrier set, the flood may ALSO
// cross smooth regions far from the bg color (soft drop shadows, vignettes)
// but is stopped by strong local gradients (the car's outline). Fixes
// white-car-on-white-studio sources where any pure color tolerance either
// leaves a shadow apron or eats through the body glare.
const EDGE = parseInt(process.env.CLASS_EDGE || "0", 10);
let GRAD = null;
if (EDGE) {
  GRAD = new Float32Array(W * H);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const i = idx(x, y);
    let g = 0;
    for (const [dx, dy] of [[1, 0], [0, 1]]) {
      const xx = Math.min(W - 1, x + dx), yy = Math.min(H - 1, y + dy);
      const j = idx(xx, yy);
      g = Math.max(g,
        Math.abs(BLUR[i] - BLUR[j]),
        Math.abs(BLUR[i + 1] - BLUR[j + 1]),
        Math.abs(BLUR[i + 2] - BLUR[j + 2]));
    }
    GRAD[y * W + x] = g;
  }
}
const match = (i) => {
  const colorOk = Math.abs(BLUR[i] - br) < TOL && Math.abs(BLUR[i + 1] - bg) < TOL && Math.abs(BLUR[i + 2] - bb) < TOL;
  if (!EDGE) return colorOk;
  const p = i >> 2;
  const lum = (0.2126 * BLUR[i] + 0.7152 * BLUR[i + 1] + 0.0722 * BLUR[i + 2]) / 255;
  // smooth AND bright → background/shadow, floodable; strong edge → stop.
  return GRAD[p] < EDGE && (colorOk || lum > 0.7);
};
// flood from all border pixels (BFS) so interior colors similar to bg survive
const seen = new Uint8Array(W * H);
const q = [];
for (let x = 0; x < W; x++) { q.push(x, x + (H - 1) * W); }
for (let y = 0; y < H; y++) { q.push(y * W, y * W + W - 1); }
while (q.length) {
  const p = q.pop(); if (seen[p]) continue; seen[p] = 1;
  const i = p << 2; if (!match(i)) continue;
  D[i + 3] = 0;
  const x = p % W, y = (p / W) | 0;
  if (x > 0) q.push(p - 1); if (x < W - 1) q.push(p + 1);
  if (y > 0) q.push(p - W); if (y < H - 1) q.push(p + W);
}

// 1b) fill interior holes: the flood can eat INTO a white body where it touches
// pure-white background (911 body-glare bug). Any transparent region NOT
// reachable from the border through other transparent pixels is an interior
// hole — restore it. Exterior background stays keyed.
{
  const ext = new Uint8Array(W * H);
  const q2 = [];
  const tryPush = (p) => { if (!ext[p] && D[(p << 2) + 3] === 0) { ext[p] = 1; q2.push(p); } };
  for (let x = 0; x < W; x++) { tryPush(x); tryPush(x + (H - 1) * W); }
  for (let y = 0; y < H; y++) { tryPush(y * W); tryPush(y * W + W - 1); }
  while (q2.length) {
    const p = q2.pop();
    const x = p % W, y = (p / W) | 0;
    if (x > 0) tryPush(p - 1); if (x < W - 1) tryPush(p + 1);
    if (y > 0) tryPush(p - W); if (y < H - 1) tryPush(p + W);
  }
  let filled = 0;
  for (let p = 0; p < W * H; p++) {
    if (D[(p << 2) + 3] === 0 && !ext[p]) { D[(p << 2) + 3] = 255; filled++; }
  }
  if (filled) console.log("filled", filled, "interior hole px");
}

// 1c) MATTE CLEANUP (2026-07-18 — kills the grey halo on the black garage bg).
// The flood leaves a ~1-2px ring of the studio background's anti-aliased
// transition (light grey) just OUTSIDE the true body. On green it hid; on
// black it glowed. Fix in three surgical steps:
//   (1) ERODE the opaque mask inward past that ring (into clean body pixels),
//   (2) rebuild a 1px anti-aliased edge whose COLOR is pulled from solid body
//       neighbors (so the AA fringe is body-colored, never grey),
//   (3) leave the interior untouched.
{
  const ERODE = parseInt(process.env.CLASS_ERODE || "2", 10);
  // binary mask (flood/hole-fill already produced 0/255)
  let M = new Uint8Array(W * H);
  for (let p = 0; p < W * H; p++) M[p] = D[(p << 2) + 3] > 128 ? 1 : 0;
  // iterative 4-neighbour erosion: strip ERODE rings off the exterior boundary
  for (let e = 0; e < ERODE; e++) {
    const N = M.slice();
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      const p = y * W + x; if (!M[p]) continue;
      if ((x > 0 && !M[p - 1]) || (x < W - 1 && !M[p + 1]) ||
          (y > 0 && !M[p - W]) || (y < H - 1 && !M[p + W])) N[p] = 0;
    }
    M = N;
  }
  // snapshot the original (pre-cleanup) RGB so decontamination reads true color
  const R0 = new Uint8ClampedArray(W * H), G0 = new Uint8ClampedArray(W * H), B0 = new Uint8ClampedArray(W * H);
  for (let p = 0; p < W * H; p++) { const i = p << 2; R0[p] = D[i]; G0[p] = D[i + 1]; B0[p] = D[i + 2]; }
  // rebuild alpha + edge color from the eroded mask
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const p = y * W + x, i = p << 2;
    if (M[p]) { D[i + 3] = 255; continue; }          // solid body: fully opaque
    // outside the eroded body: cover only the immediate 1px rim, colored by
    // the solid neighbours it touches (kills the grey halo entirely)
    let cov = 0, n = 0, sr = 0, sg = 0, sb = 0, sn = 0;
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
      const xx = x + dx, yy = y + dy; if (xx < 0 || yy < 0 || xx >= W || yy >= H) continue;
      const q = yy * W + xx; n++;
      if (M[q]) { cov++; sr += R0[q]; sg += G0[q]; sb += B0[q]; sn++; }
    }
    if (sn > 0) {
      D[i]     = Math.round(sr / sn);
      D[i + 1] = Math.round(sg / sn);
      D[i + 2] = Math.round(sb / sn);
      D[i + 3] = Math.round((cov / n) * 255);        // coverage AA, body-colored
    } else {
      D[i + 3] = 0;                                   // clean transparent
    }
  }
}

// 2) rotate
const rot = parseInt(rotArg || "0", 10);
function rotate(png, deg) {
  if (!deg) return png;
  const times = ((deg / 90) % 4 + 4) % 4;
  let cur = png;
  for (let t = 0; t < times; t++) {
    const out = new PNG({ width: cur.height, height: cur.width });
    for (let y = 0; y < cur.height; y++) for (let x = 0; x < cur.width; x++) {
      const si = ((y * cur.width + x) << 2);
      const dx = cur.height - 1 - y, dy = x; // 90° clockwise
      const di = ((dy * out.width + dx) << 2);
      for (let k = 0; k < 4; k++) out.data[di + k] = cur.data[si + k];
    }
    cur = out;
  }
  return cur;
}
img = rotate(img, rot);

// 3) trim to content
let minX = img.width, minY = img.height, maxX = 0, maxY = 0;
for (let y = 0; y < img.height; y++) for (let x = 0; x < img.width; x++) {
  if (img.data[((y * img.width + x) << 2) + 3] > 20) {
    if (x < minX) minX = x; if (x > maxX) maxX = x;
    if (y < minY) minY = y; if (y > maxY) maxY = y;
  }
}
const cw = maxX - minX + 1, ch = maxY - minY + 1;

// 4) fit into 44x44 (contain, centered) with nearest-neighbor + 2x supersample box filter
// 3x density target: the sprite draws at ~59-66pt, so 198px fills a 3x display
// with no upscale (132px was slightly under; 44px was 4x-upscaled mush).
// Override per run with CLASS_SIZE=nnn.
const SIZE = parseInt(process.env.CLASS_SIZE || "198", 10), PAD = Math.max(2, Math.round(SIZE / 44));
const scale = Math.min((SIZE - PAD * 2) / cw, (SIZE - PAD * 2) / ch);
const ow = Math.max(1, Math.round(cw * scale)), oh = Math.max(1, Math.round(ch * scale));
const out = new PNG({ width: SIZE, height: SIZE });
const ox = ((SIZE - ow) / 2) | 0, oy = ((SIZE - oh) / 2) | 0;
for (let y = 0; y < oh; y++) for (let x = 0; x < ow; x++) {
  // box-average the source region for each output pixel (cheap anti-alias)
  const sx0 = minX + x / scale, sx1 = minX + (x + 1) / scale;
  const sy0 = minY + y / scale, sy1 = minY + (y + 1) / scale;
  let r = 0, g = 0, b = 0, a = 0, n = 0;
  for (let sy = Math.floor(sy0); sy < Math.min(img.height, Math.ceil(sy1)); sy++)
    for (let sx = Math.floor(sx0); sx < Math.min(img.width, Math.ceil(sx1)); sx++) {
      const i = ((sy * img.width + sx) << 2);
      const al = img.data[i + 3];
      r += img.data[i] * al; g += img.data[i + 1] * al; b += img.data[i + 2] * al; a += al; n++;
    }
  const di = ((y + oy) * SIZE + (x + ox)) << 2;
  if (n && a > 0) {
    out.data[di] = Math.round(r / a); out.data[di + 1] = Math.round(g / a);
    out.data[di + 2] = Math.round(b / a); out.data[di + 3] = Math.round(a / n);
  }
}
fs.mkdirSync("assets/images/classes", { recursive: true });
const outPath = `assets/images/classes/${cls}.png`;
fs.writeFileSync(outPath, PNG.sync.write(out));
console.log("wrote", outPath, `${SIZE}x${SIZE}`, `(content ${cw}x${ch} keyed+rotated ${rot})`);
