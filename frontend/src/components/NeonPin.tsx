// NeonPin — Hairpin's map pin: the wordmark's ring-head teardrop (the dot on the two i's) drawn the
// way the app icon is drawn — a dark glass body with a thin neon rim in the meaning's colour, a soft
// glow behind it, and the glyph glowing in the hole. ONE component for all four surfaces: the phone
// snapshots it into Mapbox symbol images (GLPinLayers), CarPlay / Android Auto render it live in
// MarkerViews. Jeff, 2026-09-10, off the mockup ("F · Neon rings"): cameras, DriveBC events, crew
// reports and the gas / food / coffee place pins as one family at 26 pt, replacing the 44 pt
// teardrops, the 40 pt stock triangle and the glass camera square.
//
// Colour rule (DESIGN.md): places and crew reports are brand green — "green means yours" — and take
// silver / gold on a tier page like every other place pin; cameras and road events keep their
// semantic colours and NEVER take a metal (a gold pin between the congestion colours reads as traffic).
import React from "react";
import { View, Text } from "react-native";
import Svg, { Path } from "react-native-svg";
import { MaterialCommunityIcons } from "@expo/vector-icons";
import type { VisualTier } from "../tierTheme";

export type NeonTone = "brand" | "camera" | "roadwork" | "incident" | "weather" | "premium" | "ultra";
export type NeonGlyph = keyof typeof MaterialCommunityIcons.glyphMap;

/** rim = the candy ramp's LIGHT stop (the neon line and the glyph); glow = the MID stop, behind it. */
export const NEON_TONE: Record<NeonTone, { rim: string; glow: string }> = {
  brand:    { rim: "#8CFFC4", glow: "#2DEC86" },
  camera:   { rim: "#8CC5FF", glow: "#0A84FF" },
  roadwork: { rim: "#FFD27A", glow: "#FF9F0A" },
  incident: { rim: "#FF9A93", glow: "#FF453A" },
  weather:  { rim: "#DDEFFF", glow: "#8CC5FF" },
  premium:  { rim: "#FFFFFF", glow: "#C9D2D8" },
  ultra:    { rim: "#F6D77A", glow: "#E0A93E" },
};

/** Design height, tip to the top of the head, in pt. Every size is a multiple of this. */
export const NEON_PIN_H = 26;
/** The snapshot box around a 26 pt pin: glow padding on the sides and the top, the tip ON the bottom edge
 *  so a bottom-anchored symbol / MarkerView puts the tip on the coordinate. */
export const NEON_PIN_BOX_W = 32;
export const NEON_PIN_BOX_H = 36;
/** The hole centre sits this far above the tip (the number / glyph slot). */
export const NEON_PIN_HOLE_ABOVE_TIP = 21;

// Design geometry in pt at size 26: tip 0,0 · head centre 0,-21 · head r 12 · hole r 5.5.
const BODY = "M0 0 C -8.5 -9.5, -12 -15, -12 -21 A12 12 0 1 1 12 -21 C 12 -15, 8.5 -9.5, 0 0 Z";
const HOLE = "M0 -26.5 A5.5 5.5 0 1 0 0 -15.5 A5.5 5.5 0 1 0 0 -26.5 Z";
const GLASS = "rgba(12,14,18,0.86)";

export type NeonPinProps = {
  tone: NeonTone;
  /** The glyph in the hole (MaterialCommunityIcons name), or nothing for a plain ring. */
  glyph?: NeonGlyph;
  /** A number in the hole instead of a glyph (search results, cluster counts). */
  number?: number | string;
  /** Height in pt (26 = design). CarPlay passes 26 × 0.8. */
  size?: number;
  /** Glow strength 0..1 (0.35 = design; the next one ahead on the route gets 0.7). */
  glowOpacity?: number;
  opacity?: number;
};

export function NeonPin({ tone, glyph, number, size = NEON_PIN_H, glowOpacity = 0.35, opacity = 1 }: NeonPinProps) {
  const s = size / NEON_PIN_H;
  const W = NEON_PIN_BOX_W * s, H = NEON_PIN_BOX_H * s;
  const t = NEON_TONE[tone];
  const holeCY = (NEON_PIN_BOX_H - NEON_PIN_HOLE_ABOVE_TIP) * s;   // from the top of the box
  const slot = 20 * s;
  const glyphPt = 9.5 * s;
  const shadow = { textShadowColor: t.glow, textShadowRadius: 4 * s, textShadowOffset: { width: 0, height: 0 } } as const;
  return (
    <View style={{ width: W, height: H, opacity }} collapsable={false} pointerEvents="none">
      <Svg width={W} height={H} viewBox={`-${NEON_PIN_BOX_W / 2} -${NEON_PIN_BOX_H} ${NEON_PIN_BOX_W} ${NEON_PIN_BOX_H}`}>
        {/* the glow: two soft strokes behind the body (react-native-svg has no blur — stacked strokes read the same) */}
        <Path d={BODY} fill="none" stroke={t.glow} strokeWidth={6} strokeOpacity={glowOpacity * 0.45} strokeLinejoin="round" />
        <Path d={BODY} fill="none" stroke={t.glow} strokeWidth={3.5} strokeOpacity={glowOpacity * 0.8} strokeLinejoin="round" />
        {/* the glass body with the hole cut through (the map shows in the ring), rimmed in neon */}
        <Path d={`${BODY} ${HOLE}`} fillRule="evenodd" fill={GLASS} stroke={t.rim} strokeWidth={1.5} strokeLinejoin="round" />
      </Svg>
      {(glyph || number != null) && (
        <View style={{ position: "absolute", left: W / 2 - slot / 2, top: holeCY - slot / 2, width: slot, height: slot, alignItems: "center", justifyContent: "center" }}>
          {number != null
            ? <Text allowFontScaling={false} style={[{ color: t.rim, fontSize: 10.5 * s, fontWeight: "800", includeFontPadding: false, textAlign: "center" }, shadow]}>{String(number)}</Text>
            : <MaterialCommunityIcons name={glyph!} size={glyphPt} color={t.rim} style={shadow} />}
        </View>
      )}
    </View>
  );
}

// ── The families ───────────────────────────────────────────────────────────────────────
/** Crew reports (/api/hazards): brand green — a member's report is yours. */
const HAZARD_PIN: Record<string, { tone: NeonTone; glyph: NeonGlyph }> = {
  police:   { tone: "brand", glyph: "police-badge" },
  accident: { tone: "brand", glyph: "car-emergency" },
  traffic:  { tone: "brand", glyph: "car-multiple" },
  road:     { tone: "brand", glyph: "alert" },
};
export const HAZARD_PIN_DEFAULT: { tone: NeonTone; glyph: NeonGlyph } = { tone: "brand", glyph: "alert" };
export const HAZARD_PIN_KINDS = Object.keys(HAZARD_PIN);
export function hazardPin(kind: string): { tone: NeonTone; glyph: NeonGlyph } { return HAZARD_PIN[kind] || HAZARD_PIN_DEFAULT; }
/** The symbol-image name a hazard kind snapshots to (unknown kinds share the default). */
export function hazardPinImage(kind: string): string { return HAZARD_PIN[kind] ? `neon_hz_${kind}` : "neon_hz_default"; }

/** Fixed speed cameras (OpenStreetMap): blue, the CCTV glyph. */
export const CAMERA_PIN: { tone: NeonTone; glyph: NeonGlyph } = { tone: "camera", glyph: "cctv" };

/** DriveBC road events (Open511), by kind. Severity does not change the colour — a minor event is drawn
 *  smaller and dimmer instead (GLPinLayers), so only what matters stands up. */
export const INCIDENT_PIN: Record<"incident" | "construction" | "road" | "weather" | "event", { tone: NeonTone; glyph: NeonGlyph }> = {
  incident:     { tone: "incident", glyph: "car-emergency" },
  construction: { tone: "roadwork", glyph: "traffic-cone" },
  road:         { tone: "incident", glyph: "close-octagon" },
  weather:      { tone: "weather",  glyph: "snowflake" },
  event:        { tone: "roadwork", glyph: "calendar-alert" },
};
export const INCIDENT_PIN_KINDS = Object.keys(INCIDENT_PIN) as (keyof typeof INCIDENT_PIN)[];

/** Place pins (the search pills' results): the page's metal, like every other place pin. */
export const PLACE_TONE: Record<VisualTier, NeonTone> = { brand: "brand", premium: "premium", ultra: "ultra" };
