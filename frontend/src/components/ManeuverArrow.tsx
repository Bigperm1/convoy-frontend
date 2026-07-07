// ManeuverArrow — a real VECTOR turn arrow (react-native-svg), shared by the phone
// nav banner AND the CarPlay maneuver strip so the two are pixel-identical. Replaces
// the old unicode glyphs (↱ ↗ …), which rendered inconsistently and looked wrong.
//
// react-native-svg draws the same path on every surface (no icon-font loading), so it
// works on the CarPlay window where icon fonts were flaky.

import React from "react";
import Svg, { Path, Circle } from "react-native-svg";

export type ManeuverDir =
  | "straight" | "left" | "right" | "slight-left" | "slight-right"
  | "uturn" | "roundabout";

// Parse a turn instruction → a direction. Order matters: specific before general
// (e.g. "slight right" before "right"). Mirrors the old maneuverArrow() regex.
export function maneuverDir(instruction: string): ManeuverDir {
  const t = (instruction || "").toLowerCase();
  if (/\bu[- ]?turn\b/.test(t)) return "uturn";
  if (/\bround ?about\b|\brotary\b/.test(t)) return "roundabout";
  if (/\bslight left\b|\bkeep left\b|\bfork left\b/.test(t)) return "slight-left";
  if (/\bslight right\b|\bkeep right\b|\bfork right\b/.test(t)) return "slight-right";
  if (/\bleft\b/.test(t)) return "left";
  if (/\bright\b/.test(t)) return "right";
  if (/\bmerge\b|\b(ramp|exit|take)\b/.test(t)) return "slight-right";
  return "straight";
}

// Path data per direction (viewBox 0 0 28 28). [stem, head, ...extra]. Stroked, no fill.
const PATHS: Record<ManeuverDir, string[]> = {
  straight: ["M14 23.5 L14 8", "M8.5 13 L14 7 L19.5 13"],
  right: ["M11 24 L11 12.5 Q11 9.5 14 9.5 L19 9.5", "M15.5 6 L20.5 9.5 L15.5 13"],
  left: ["M17 24 L17 12.5 Q17 9.5 14 9.5 L9 9.5", "M12.5 6 L7.5 9.5 L12.5 13"],
  "slight-right": ["M9.5 22.5 L19 9.5", "M14 9.5 L19 9.5 L19 14.5"],
  "slight-left": ["M18.5 22.5 L9 9.5", "M14 9.5 L9 9.5 L9 14.5"],
  uturn: ["M9.5 23 L9.5 13 Q9.5 7.5 14.5 7.5 Q19.5 7.5 19.5 13 L19.5 17", "M16 14 L19.5 17.5 L23 14"],
  // Circle + short entry stem + exit arrow up-right.
  roundabout: ["M14.5 23.5 L14.5 20", "M18 11 L22.5 6.5", "M18.5 6.5 L22.5 6.5 L22.5 10.5"],
};

export function ManeuverArrow({
  dir,
  size = 30,
  color = "#0B0B0C",
}: {
  dir: ManeuverDir;
  size?: number;
  color?: string;
}) {
  const paths = PATHS[dir] || PATHS.straight;
  const sw = 2.8;
  return (
    <Svg width={size} height={size} viewBox="0 0 28 28">
      {dir === "roundabout" && (
        <Circle cx="14.5" cy="14.5" r="5.5" stroke={color} strokeWidth={sw} fill="none" />
      )}
      {paths.map((d, i) => (
        <Path
          key={i}
          d={d}
          stroke={color}
          strokeWidth={sw}
          strokeLinecap="round"
          strokeLinejoin="round"
          fill="none"
        />
      ))}
    </Svg>
  );
}

export default ManeuverArrow;
