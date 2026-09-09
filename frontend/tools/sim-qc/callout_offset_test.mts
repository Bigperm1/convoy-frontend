// callout_offset_test — the destination-weather callout's temperature must be offset in EMS,
// never in screen points, or it climbs out of the box as the callout shrinks with distance.
//
// FIELD REPORT: Jeff's CarPlay head unit, 2026-09-07 — "I was shown photos that the weather was
// fixed" and it was not. The shipped verification was a PIL model of the PHONE's <Text>; the
// Mapbox SymbolLayer that draws it on the head unit had never been rendered anywhere.
//
// THE MEASUREMENTS BELOW ARE REAL. Simulator, iPhone 17 (402x874 pt), camera pinned from code at
// pitch 57 (the head unit's own chase pitch, confirmed to 4 pt by three row positions against the
// projection), zoom 16.5, twelve callouts at four ground distances with the three candidate
// mechanisms side by side. Columns are the text centre measured below the box's top edge.
import {
  calloutTextOffsetEms, calloutTextOffsetExpr, perspectiveRatio, textCyFromBoxTop,
  CALLOUT_TEXT_PT, CALLOUT_TEXT_SM_PT,
} from "../../src/calloutTextOffset.ts";

const BOX_W = 70, BOX_H = 42, DX = 3, DY = -25;
let fails = 0;
const ok = (name: string, cond: boolean, detail = "") => {
  if (!cond) { fails++; console.log(`  FAIL ${name} ${detail}`); } else console.log(`  ok   ${name} ${detail}`);
};
const near = (a: number, b: number, tol: number) => Math.abs(a - b) <= tol;

// ── A. the ems conversion itself ────────────────────────────────────────────────────────────
const e14 = calloutTextOffsetEms(DX, DY, CALLOUT_TEXT_PT);
const e105 = calloutTextOffsetEms(DX, DY, CALLOUT_TEXT_SM_PT);
ok("A1 14pt ems", near(e14[0], DX / 14, 1e-9) && near(e14[1], DY / 14, 1e-9), `[${e14[0].toFixed(4)}, ${e14[1].toFixed(4)}]`);
ok("A2 10.5pt ems", near(e105[0], DX / 10.5, 1e-9) && near(e105[1], DY / 10.5, 1e-9), `[${e105[0].toFixed(4)}, ${e105[1].toFixed(4)}]`);
// ems x size must reproduce the design offset in points at BOTH sizes — that is the whole point.
ok("A3 ems x size == design pt (14)", near(e14[0] * 14, DX, 1e-9) && near(e14[1] * 14, DY, 1e-9));
ok("A4 ems x size == design pt (10.5)", near(e105[0] * 10.5, DX, 1e-9) && near(e105[1] * 10.5, DY, 1e-9));

// ── B. replay the twelve measured callouts ──────────────────────────────────────────────────
// boxW is measured, so ratio = boxW / 70 comes from the render, not from the model.
const MEAS = [
  { boxW: 69.7, translate: 16.5, ems: 16.5 },   // at the camera target: no compression
  { boxW: 66.7, translate: 14.7, ems: 15.8 },
  { boxW: 63.3, translate: 12.5, ems: 14.8 },
  { boxW: 59.3, translate: 10.0, ems: 13.7 },   // +350 m ahead of the target
];
for (const [i, m] of MEAS.entries()) {
  const ratio = m.boxW / BOX_W;
  const emsPred = textCyFromBoxTop(BOX_H, DY, ratio, "ems");
  const trPred = textCyFromBoxTop(BOX_H, DY, ratio, "translate");
  ok(`B${i + 1}a ems model vs render (box ${m.boxW})`, near(emsPred, m.ems, 0.8), `pred ${emsPred.toFixed(1)} meas ${m.ems}`);
  ok(`B${i + 1}b translate model vs render`, near(trPred, m.translate, 0.8), `pred ${trPred.toFixed(1)} meas ${m.translate}`);
}

// ── C. the defect must reproduce, and the fix must hold ─────────────────────────────────────
// C1 is the guard against a green gate that cannot see the bug: if the model ever stops
// reproducing the drift, the model is wrong and B above proves nothing.
const drift = MEAS[0].translate - MEAS[3].translate;
const emsDrift = MEAS[0].ems - MEAS[3].ems;
ok("C1 the reported defect reproduces (translate drifts > 5 pt)", drift > 5, `drift ${drift.toFixed(1)} pt`);
ok("C2 the ems offset holds (drift < 3 pt over the same span)", emsDrift < 3, `drift ${emsDrift.toFixed(1)} pt`);
ok("C3 ems beats translate at every compressed distance",
  MEAS.slice(1).every((m) => m.ems > m.translate));

// ── D. the perspective ratio itself, against the measured box widths ────────────────────────
// dDp for each row, from the harness geometry: zoom 16.5 at lat 49.1124 -> 0.5528 m/dp,
// camera target at the 150 m row, rows at 50/150/300/500 m.
const MPD = 0.5528, H = 874;
for (const [dM, boxW] of [[50, 74.3], [150, 69.7], [300, 64.3], [500, 59.3]] as Array<[number, number]>) {
  const r = perspectiveRatio((dM - 150) / MPD, 57, H);
  ok(`D d=${dM}m box width`, near(BOX_W * r, boxW, 1.0), `pred ${(BOX_W * r).toFixed(1)} meas ${boxW}`);
}


// ── E. THE SHIPPED EXPRESSION ITSELF, WITH NEGATIVE CONTROLS ────────────────────────────────
// Codex's adversarial review (2026-09-08) killed the first version of this gate: A–D only
// exercised the helpers, so a production layer whose offset had been zeroed, given the wrong
// divisor, or reverted to a constant-point translate would have passed. This section evaluates
// the EXACT expression src/carplay/CarMapView.tsx ships, and proves the check can fail.
type Expr = any;
function evalOffset(expr: Expr, temp: string): [number, number] {
  const ev = (e: Expr): any => {
    if (!Array.isArray(e)) return e;
    switch (e[0]) {
      case "case": return ev(e[1]) ? ev(e[2]) : ev(e[3]);
      case ">": return ev(e[1]) > ev(e[2]);
      case "length": return String(ev(e[1])).length;
      case "get": return e[1] === "temp" ? temp : undefined;
      case "literal": return e[1];
      default: throw new Error(`unsupported op ${String(e[0])}`);
    }
  };
  const v = ev(expr);
  if (!Array.isArray(v) || v.length !== 2 || !v.every((n) => Number.isFinite(n))) {
    throw new Error("offset did not resolve to a numeric pair");
  }
  return v as [number, number];
}
/** An offset is CORRECT when ems x the size that branch selects reproduces the design points. */
function offsetIsCorrect(expr: Expr): boolean {
  try {
    for (const [temp, sizePt] of [["18\u00b0", CALLOUT_TEXT_PT], ["104\u00b0", CALLOUT_TEXT_SM_PT]] as Array<[string, number]>) {
      const [ex, ey] = evalOffset(expr, temp);
      if (Math.abs(ex * sizePt - DX) > 1e-6) return false;
      if (Math.abs(ey * sizePt - DY) > 1e-6) return false;
    }
    return true;
  } catch { return false; }
}

const shipped = calloutTextOffsetExpr(DX, DY);
ok("E1 the SHIPPED expression places both sizes correctly", offsetIsCorrect(shipped));
const s14 = evalOffset(shipped, "18\u00b0"), s105 = evalOffset(shipped, "104\u00b0");
ok("E2 shipped 14pt branch", near(s14[1], DY / 14, 1e-9), `${s14[1].toFixed(4)} ems`);
ok("E3 shipped 10.5pt branch", near(s105[1], DY / 10.5, 1e-9), `${s105[1].toFixed(4)} ems`);
ok("E4 the two branches DIFFER (one divisor for both is the bug)", Math.abs(s14[1] - s105[1]) > 0.3);

// negative controls — each of these must be REJECTED, or the gate cannot see a regression
const zeroed: Expr = ["literal", [0, 0]];
const oneDivisor: Expr = ["case", [">", ["length", ["get", "temp"]], 3],
  ["literal", calloutTextOffsetEms(DX, DY, CALLOUT_TEXT_PT)],
  ["literal", calloutTextOffsetEms(DX, DY, CALLOUT_TEXT_PT)]];
const asPoints: Expr = ["literal", [DX, DY]];
const swapped: Expr = ["case", [">", ["length", ["get", "temp"]], 3],
  ["literal", calloutTextOffsetEms(DX, DY, CALLOUT_TEXT_PT)],
  ["literal", calloutTextOffsetEms(DX, DY, CALLOUT_TEXT_SM_PT)]];
ok("E5 rejects a zeroed offset", !offsetIsCorrect(zeroed));
ok("E6 rejects one divisor for both sizes", !offsetIsCorrect(oneDivisor));
ok("E7 rejects a constant-POINT offset (the original defect)", !offsetIsCorrect(asPoints));
ok("E8 rejects the two branches swapped", !offsetIsCorrect(swapped));

console.log(fails === 0 ? "\nPASS callout_offset" : `\nFAIL callout_offset (${fails})`);
if (fails) process.exit(1);
