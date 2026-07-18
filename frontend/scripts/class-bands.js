// class-bands.js <class> [--white-pri]
// Generates the 4 runtime paint-band layers for a baked class photo
// (assets/images/classes/<class>.png → <class>_{priblack,primask,secblack,secmask}.png).
//
// Band model (see src/classLayers.tsx): each band ships a BLACK floor (solid
// black, alpha = band coverage) + a WHITE shading mask (alpha = shading × mix).
// RN tintColor recolors the white mask preserving alpha, so tint × mask over
// the black floor renders shaded paint in any hex.
//
// --white-pri (the 2026-07-17 white-render sets): PRIMARY = the bright white
// body (lum ≥ .68), SECONDARY = the black panels/glass (lum ≤ .32). The mid
// zone (.32–.68: stripes, grey mechanicals, shadows) and any SATURATED detail
// (red seats, Ducati frame — sat > .28) never paint, keeping the character
// pieces of each render in their original color.
const fs = require("fs");
const { PNG } = require("pngjs");
const [,, cls] = process.argv;
if (!cls) { console.log("usage: node class-bands.js <class>"); process.exit(1); }

const src = PNG.sync.read(fs.readFileSync(`assets/images/classes/${cls}.png`));
const { width: W, height: H, data: D } = src;

const mk = () => new PNG({ width: W, height: H });
const priBlack = mk(), priMask = mk(), secBlack = mk(), secMask = mk();

for (let p = 0; p < W * H; p++) {
  const i = p << 2;
  const a = D[i + 3];
  // Solid pixels only: semi-transparent keyed EDGES otherwise land in a band
  // and read as color fringe/speckle around the outline at map size.
  if (a <= 200) continue;
  const r = D[i] / 255, g = D[i + 1] / 255, b = D[i + 2] / 255;
  const mx = Math.max(r, g, b), mn = Math.min(r, g, b);
  const lum = 0.2126 * r + 0.7152 * g + 0.0722 * b;
  const sat = mx === 0 ? 0 : (mx - mn) / mx;
  if (sat > 0.28) continue;               // colored detail stays original
  const setPx = (png, R, G, B, A) => {
    const d = png.data; d[i] = R; d[i + 1] = G; d[i + 2] = B; d[i + 3] = A;
  };
  if (lum >= 0.68) {
    // PRIMARY (white body): shading follows luminance within the band, with a
    // floor so even creases keep readable color.
    const t = (lum - 0.68) / (1 - 0.68);
    const shade = Math.round((0.45 + 0.55 * t) * a);
    setPx(priBlack, 0, 0, 0, a);
    setPx(priMask, 255, 255, 255, shade);
  } else if (lum <= 0.32) {
    // SECONDARY (black panels/glass): high color floor so the tint clearly
    // reads even on near-black, brighter darks get slightly more.
    const t = lum / 0.32;
    const shade = Math.round((0.55 + 0.35 * t) * a);
    setPx(secBlack, 0, 0, 0, a);
    setPx(secMask, 255, 255, 255, shade);
  }
}

for (const [suffix, png] of [["priblack", priBlack], ["primask", priMask], ["secblack", secBlack], ["secmask", secMask]]) {
  const out = `assets/images/classes/${cls}_${suffix}.png`;
  fs.writeFileSync(out, PNG.sync.write(png));
}
console.log(`wrote ${cls} bands (${W}x${H})`);
