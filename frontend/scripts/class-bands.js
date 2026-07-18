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

// Per-class band profiles. Default = the white-render rule. BOAT keeps its
// Jeff-approved 2026-07-17 look: PRIMARY = the mid-grey swim-platform/hull
// accents, SECONDARY = the white deck, dark detail never paints.
const PROFILES = {
  default: { priLo: 0.68, priHi: 1.0, secLo: 0.0, secHi: 0.32, secFloor: 0.55 },
  boat:    { priLo: 0.28, priHi: 0.66, secLo: 0.66, secHi: 1.0, secFloor: 0.45 },
  // silver-bodied render — widen the primary band so the darker flank paints too
  sedan:   { priLo: 0.55, priHi: 1.0, secLo: 0.0, secHi: 0.32, secFloor: 0.55 },
};
const P = PROFILES[cls] || PROFILES.default;

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
  if (lum >= P.priLo && lum <= P.priHi) {
    // PRIMARY band: shading follows luminance within the band, with a floor so
    // even creases keep readable color.
    const t = (lum - P.priLo) / (P.priHi - P.priLo);
    const shade = Math.round((0.45 + 0.55 * t) * a);
    setPx(priBlack, 0, 0, 0, a);
    setPx(priMask, 255, 255, 255, shade);
  } else if (lum >= P.secLo && lum <= P.secHi) {
    // SECONDARY band: high color floor so the tint clearly reads even at the
    // band's dark end; brighter pixels get slightly more.
    const t = (lum - P.secLo) / (P.secHi - P.secLo);
    const shade = Math.round((P.secFloor + (0.90 - P.secFloor) * t) * a);
    setPx(secBlack, 0, 0, 0, a);
    setPx(secMask, 255, 255, 255, shade);
  }
}

for (const [suffix, png] of [["priblack", priBlack], ["primask", priMask], ["secblack", secBlack], ["secmask", secMask]]) {
  const out = `assets/images/classes/${cls}_${suffix}.png`;
  fs.writeFileSync(out, PNG.sync.write(png));
}
console.log(`wrote ${cls} bands (${W}x${H})`);
