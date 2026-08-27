// Re-tint the brand teardrop onto a tier metal.
//
// The pin is a pure green gradient (verified: every opaque pixel is a green
// shade), so no green-dominance mask is needed — unlike the H tile, which had a
// black city grid to protect.
//
// ⚠ RAMP IN HSV, NOT RGB. The first attempt lerped RGB from a dark accent to an
// accent-mixed-with-white, which desaturated the whole pin: gold came out at 47%
// saturation against the accent's 72%. Calibration target is not the accent
// itself but the RELATIONSHIP the green pin already has to green: median
// saturation 95% vs the accent's 81% (ratio 1.17) and value 90% vs 93% (0.97).
// So: hold hue and saturation constant, ramp only VALUE.
const { PNG } = require("pngjs");
const fs = require("fs");

const hex2rgb = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
const lum = (r, g, b) => (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;

function rgb2hsv(r, g, b) {
  r /= 255; g /= 255; b /= 255;
  const mx = Math.max(r, g, b), mn = Math.min(r, g, b), d = mx - mn;
  let h = 0;
  if (d) {
    if (mx === r) h = ((g - b) / d) % 6;
    else if (mx === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
  }
  return [((h * 60) + 360) % 360, mx ? d / mx : 0, mx];
}
function hsv2rgb(h, s, v) {
  const c = v * s, x = c * (1 - Math.abs(((h / 60) % 2) - 1)), m = v - c;
  const t = h < 60 ? [c, x, 0] : h < 120 ? [x, c, 0] : h < 180 ? [0, c, x]
          : h < 240 ? [0, x, c] : h < 300 ? [x, 0, c] : [c, 0, x];
  return t.map((n) => Math.round((n + m) * 255));
}

/** How the GREEN pin sits relative to brand green — the character to reproduce. */
const SAT_RATIO = 1.17;
const V_LO = 0.66;   // darkest shading, as a fraction of the accent's value
const V_HI = 1.12;   // brightest highlight

function retint(src, dst, accentHex) {
  const p = PNG.sync.read(fs.readFileSync(src));
  const [aH, aS, aV] = rgb2hsv(...hex2rgb(accentHex));
  const S = Math.min(1, aS * SAT_RATIO);
  let lo = 1, hi = 0;
  for (let i = 0; i < p.data.length; i += 4) {
    if (p.data[i + 3] < 8) continue;
    const L = lum(p.data[i], p.data[i + 1], p.data[i + 2]);
    if (L < lo) lo = L; if (L > hi) hi = L;
  }
  for (let i = 0; i < p.data.length; i += 4) {
    if (p.data[i + 3] < 8) continue;
    const L = lum(p.data[i], p.data[i + 1], p.data[i + 2]);
    const t = hi > lo ? (L - lo) / (hi - lo) : 0.5;
    const v = Math.min(1, aV * (V_LO + (V_HI - V_LO) * t));
    const [r, g, b] = hsv2rgb(aH, S, v);
    p.data[i] = r; p.data[i + 1] = g; p.data[i + 2] = b;
  }
  fs.writeFileSync(dst, PNG.sync.write(p));

  const q = PNG.sync.read(fs.readFileSync(dst));
  const px = [];
  for (let i = 0; i < q.data.length; i += 4) if (q.data[i + 3] > 200) px.push([q.data[i], q.data[i + 1], q.data[i + 2]]);
  const med = [0, 1, 2].map((c) => px.map((v) => v[c]).sort((a, b) => a - b)[Math.floor(px.length / 2)]);
  const [mh, ms, mv] = rgb2hsv(...med);
  console.log(
    dst.split("/").pop().padEnd(23),
    "median #" + med.map((v) => v.toString(16).padStart(2, "0")).join(""),
    "sat " + (ms * 100).toFixed(0) + "% (accent " + (aS * 100).toFixed(0) + "%)",
    "val " + (mv * 100).toFixed(0) + "% (accent " + (aV * 100).toFixed(0) + "%)",
  );
}

retint("assets/images/brand-pin.png", "assets/images/brand-pin-gold.png", "#E0A93E");
retint("assets/images/brand-pin.png", "assets/images/brand-pin-silver.png", "#C9D2D8");
