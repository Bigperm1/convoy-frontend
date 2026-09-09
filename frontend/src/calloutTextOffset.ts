// calloutTextOffset — where the destination-weather callout's TEMPERATURE sits, and why the
// offset is in EMS rather than screen points.
//
// ── THE BUG THIS FILE EXISTS FOR (Jeff's head unit, 2026-09-07) ──────────────────────────
// The temperature climbed out of the top of the callout box on CarPlay. It had never been
// rendered anywhere before that photograph: the "fix" shipped on 2026-09-05/06 was verified
// with tools/wx-pin/preview_align.py, which is a PIL model of the PHONE's React Native <Text>
// ("PIL only, no app/JS involved" — its own docstring) and says nothing about the Mapbox
// SymbolLayer that actually draws it on the head unit.
//
// ── ROOT CAUSE, MEASURED 2026-09-08 ─────────────────────────────────────────────────────
// Mapbox multiplies a symbol's icon-size and text-size by a PERSPECTIVE RATIO on a pitched
// camera, so a billboarded symbol SHRINKS with distance:
//     ratio = 0.5 + 0.5 * (cameraToCenterDistance / w),  w = D + d_dp * sin(pitch),  D = 1.5 * H
// `text-translate` is a PAINT property in constant screen points and is NOT multiplied by that
// ratio. So the box shrank around a text that kept a fixed 25 pt rise, and the text climbed out.
// `text-offset` is in EMS, rides text-size, and therefore tracks the box exactly.
//
// MEASURED on the simulator at the head unit's own pitch (57 deg, zoom 16.5, 402x874 pt,
// 12 callouts at four distances, three mechanisms side by side) — text centre below the box top:
//     box width      69.7    66.7    63.3    59.3  pt   (shrinks with distance)
//     textTranslate  16.5    14.7    12.5    10.0  pt   <- drifts up 6.5 pt, the reported defect
//     textOffset     16.5    15.8    14.8    13.7  pt   <- tracks the box, matches the model
//     model (ems)    16.9    16.2    15.4    14.4  pt
// The stop-pin numeral in the same layer has always used ems, which is why IT was never reported.
// Gate: tools/sim-qc/callout_offset_test.mts.

/** Text sizes the callout draws at. >3 characters ("104", "-40") drop to the small size so the
 *  ink clears the 70 pt box — measured with PIL against SFNS.ttf in tools/wx-pin/preview_align.py. */
export const CALLOUT_TEXT_PT = 14;
export const CALLOUT_TEXT_SM_PT = 10.5;
export const CALLOUT_TEXT_LEN_MAX = 3;

/** The offset in EMS for a given text size. uiScale deliberately cancels: text-size already
 *  carries it, so ems = pt / sizePt is the same number on every surface, Android Auto included. */
export function calloutTextOffsetEms(dxPt: number, dyPt: number, sizePt: number): [number, number] {
  return [dxPt / sizePt, dyPt / sizePt];
}

/** Mapbox's symbol perspective ratio. dDp is the ground distance from the camera TARGET in dp. */
export function perspectiveRatio(dDp: number, pitchDeg: number, viewportHeightDp: number): number {
  const D = 1.5 * viewportHeightDp;
  return 0.5 + 0.5 * (D / (D + dDp * Math.sin((pitchDeg * Math.PI) / 180)));
}

/** Where the text's centre lands below the box's top edge, per mechanism. `dyPt` is negative
 *  (the text sits above the anchor); `boxHPt` is the full baked image height including the tail. */
export function textCyFromBoxTop(
  boxHPt: number, dyPt: number, ratio: number, mode: "ems" | "translate",
): number {
  return boxHPt * ratio + (mode === "ems" ? dyPt * ratio : dyPt);
}

/** THE EXACT `text-offset` EXPRESSION THE CARPLAY TEMPERATURE LAYER SHIPS.
 *  It lives here, not inline in CarMapView, so the gate can evaluate the SHIPPED expression
 *  instead of a copy of the arithmetic. Codex's adversarial review of 2026-09-08 caught that
 *  the first version of the gate would have passed against a production layer whose offset had
 *  been zeroed or given the wrong divisor — it only exercised the helpers. */
export function calloutTextOffsetExpr(dxPt: number, dyPt: number): unknown[] {
  return [
    "case",
    [">", ["length", ["get", "temp"]], CALLOUT_TEXT_LEN_MAX],
    ["literal", calloutTextOffsetEms(dxPt, dyPt, CALLOUT_TEXT_SM_PT)],
    ["literal", calloutTextOffsetEms(dxPt, dyPt, CALLOUT_TEXT_PT)],
  ];
}
