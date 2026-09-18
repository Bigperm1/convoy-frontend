// RibbonNear — the first stretch of the route line, re-drawn EVERY frame from the car's drawn pose.
//
// 2026-09-18, Jeff: "the car is smooth but the route line when its dissappearing in front of the car
// is notchy any way to smooth it out?" The ribbon was one big source rebuilt at most at the 12 Hz
// ticker, and only when its quantised cut moved (8 m steps at a z14 highway camera), while the car
// is drawn every frame — so the line's start stair-stepped against a smoothly moving car (measured:
// tools/sim-qc/ribbon_gap.py). See the NEAR / FAR SPLIT note in src/routeRibbon.ts.
//
// This component draws only [cut, seam] — the fade-in plus a short solid stretch — so a per-frame
// rebuild is a few dozen vertices. The parent keeps drawing [seam, destination] and rebuilds it only
// when the seam moves. The per-frame trigger is SelfCarModel's pushCam (the same call that moves the
// car and the camera), handed in through `sinkRef` — no extra animation loop. The layer styles are
// constant: everything that moves is in the SOURCE (the 2026-09-01 watchdog rule, src/routeRibbon.ts).
import React, { useEffect, useMemo, useRef, useState } from "react";
import { LineLayer, ShapeSource } from "@rnmapbox/maps";
import {
  anchorCutM, buildRibbonNearFeatures, ribbonSeamStepM, RIBBON_CASING, RIBBON_CORE,
  type CutAnchorHint, type RibbonPartition,
} from "./routeRibbon";
import { clampCutToRoute } from "./routeTrim";

/** SelfCarModel calls this with the drawn pose on every frame it draws. */
export type DrawSinkRef = React.MutableRefObject<((lat: number, lng: number) => void) | null>;

/** Below this the start has not visibly moved (0.05 m ≈ 0.05 dp even at z17) — skip the rebuild. */
const NEAR_MIN_MOVE_M = 0.05;

export default function RibbonNear({
  id, partition, cutM, leadM, fadeM, seamM, fallbackM, index, edgeColor, sinkRef, hidden = false,
  glowWidth = 20, glowBlur = 7, glowOpacity = 0.55, coreWidth = 10,
}: {
  /** Source/layer id prefix — one per map surface. */
  id: string;
  partition: RibbonPartition | null;
  /** The render-time cut: shown until the first drawn frame arrives, and after a route change. */
  cutM: number | null;
  /** The speed-aware lead added to the car's along-route metre (the same one the parent uses). */
  leadM: number;
  fadeM: number;
  /** Where the parent's far piece starts. */
  seamM: number | null;
  /** The parent's fallback metre when the car is off this line (see anchorCutM). */
  fallbackM: number;
  index: number;
  edgeColor: string;
  sinkRef: DrawSinkRef;
  hidden?: boolean;
  glowWidth?: number;
  glowBlur?: number;
  glowOpacity?: number;
  coreWidth?: number;
}) {
  // The car's anchored metre on this partition, from the last drawn frame. The LEAD is applied at render
  // (Codex review 2026-09-18): the lead also changes without a camera push — the parked lift animates on
  // SelfCarModel's own timer — so a cut frozen at the last push would sit at the wrong distance.
  const [frameBase, setFrameBase] = useState<{ key: RibbonPartition; m: number } | null>(null);
  const hintRef = useRef<CutAnchorHint>(null);
  const live = useRef({ partition, fallbackM, off: hidden || seamM == null });
  live.current = { partition, fallbackM, off: hidden || seamM == null };

  useEffect(() => {
    const sink = (lat: number, lng: number) => {
      const { partition: p, fallbackM: fb, off } = live.current;
      if (off || !p || !Number.isFinite(lat) || !Number.isFinite(lng)) return;
      const a = anchorCutM(p, lat, lng, hintRef.current, p, fb);
      hintRef.current = a.hint;
      setFrameBase((prev) => (prev && prev.key === p && Math.abs(prev.m - a.m) < NEAR_MIN_MOVE_M ? prev : { key: p, m: a.m }));
    };
    sinkRef.current = sink;
    return () => { if (sinkRef.current === sink) sinkRef.current = null; };
  }, [sinkRef]);

  // A new route (reroute / swap) invalidates the per-frame base and the anchor hint until the next frame.
  const cut = frameBase && frameBase.key === partition && partition
    ? clampCutToRoute(frameBase.m + leadM, frameBase.m, partition.totalM)
    : cutM;
  const shape: any = useMemo(() => ({
    type: "FeatureCollection",
    features: (!hidden && partition && cut != null && seamM != null)
      ? buildRibbonNearFeatures(partition, { cutM: cut, fadeM, endM: seamM, index, coreOverlapM: ribbonSeamStepM(fadeM) })
      : [],
  }), [hidden, partition, cut, fadeM, seamM, index]);   // `cut` already folds in leadM

  // Styles and filters are MEMOISED: this component re-renders every frame, and although RN's prop
  // diff skips deep-equal objects, a per-frame style object is exactly the pattern trap-check hunts
  // (per-tick layer-style writes = the 2026-09-01 watchdog kills). They change only with the colour.
  const casingFilter = useMemo(() => ["==", ["get", "kind"], RIBBON_CASING] as any, []);
  const coreFilter = useMemo(() => ["==", ["get", "kind"], RIBBON_CORE] as any, []);
  const casingStyle = useMemo(() => ({
    lineColor: edgeColor, lineWidth: glowWidth, lineBlur: glowBlur,
    lineOpacity: ["*", glowOpacity, ["get", "alpha"]] as any,
    lineCap: "butt" as const, lineJoin: "round" as const, lineEmissiveStrength: 1,
  }), [edgeColor, glowWidth, glowBlur, glowOpacity]);
  const coreStyle = useMemo(() => ({
    lineColor: ["get", "color"] as any, lineOpacity: ["get", "alpha"] as any, lineWidth: coreWidth,
    lineCap: "butt" as const, lineJoin: "round" as const, lineEmissiveStrength: 1,
  }), [coreWidth]);

  return (
    <ShapeSource id={`${id}-src`} shape={shape}>
      {/* Same numbers as the far ribbon's layers on this surface; BUTT caps on both so the two
          pieces meet flush at the seam (a round cap on the translucent glow overlaps and beads). */}
      <LineLayer id={`${id}-casing`} slot="top" filter={casingFilter} style={casingStyle} />
      <LineLayer id={`${id}-core`} slot="top" filter={coreFilter} style={coreStyle} />
    </ShapeSource>
  );
}
