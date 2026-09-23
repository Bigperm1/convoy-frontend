// motion.ts — the ONE source of motion values (Jeff, 2026-09-23: Apple-feel batch 1, "go").
//
// Mirrors DESIGN.md §11 "Motion, haptics & type". Change a value THERE and HERE together, never per
// screen: a screen imports MOTION / NAV and never writes a duration, curve or spring of its own.
// The nav-locked mixed files (map.tsx, ConvoyMapbox.tsx, CarMapView.tsx, settings.ts, src/carplay/*)
// fail nav_lock_test on any NEW column-0 ALL_CAPS const, so they can only IMPORT from here.
//
// Values are the animate-expo skill's tables (Apple's two-number springs, the strong ease-out).
// Nothing here drives the drive map: the nav camera is paced by src/framePacer.ts, not by these.
import {
  cubicBezier,
  Easing,
  type WithSpringConfig,
  type WithTimingConfig,
} from "react-native-reanimated";

// One cubic-bézier in two code forms, because one object cannot serve both APIs:
//   fn  — Easing.bezier(), an EasingFunctionFactory, for withTiming and layout-animation builders;
//   css — cubicBezier(), for Reanimated CSS transitions. Their transitionTimingFunction type is a
//         keyword or a ParametrizedTimingFunction — NOT a 'cubic-bezier(…)' string (read in
//         react-native-reanimated 4.1.7 lib/typescript/css/easing/types.d.ts).
function curve(x1: number, y1: number, x2: number, y2: number) {
  return { fn: Easing.bezier(x1, y1, x2, y2), css: cubicBezier(x1, y1, x2, y2) };
}

const out = curve(0.23, 1, 0.32, 1); // enter / exit — the default. Never Easing.in on UI.
const inOut = curve(0.77, 0, 0.175, 1); // something moving across the screen
const sheet = curve(0.32, 0.72, 0, 1); // the iOS sheet curve

// Milliseconds. Declared once and READ by press / popover below, so the documented token (DESIGN.md §11.4)
// is the value on screen — never a second literal to drift from it.
const D = {
  press: 120,
  small: 180,
  popoverEnter: 200,
  popoverExit: 160,
  fade: 200,
  reflow: 200,
} as const;

export const MOTION = {
  ease: {
    out: out.fn,
    inOut: inOut.fn,
    sheet: sheet.fn,
    outCss: out.css,
    inOutCss: inOut.css,
    sheetCss: sheet.css,
  },

  /** Milliseconds. UI motion stays ≤ 300; exits run ~20% faster than entries. */
  duration: D,

  // Apple's two numbers. ⚠ Reanimated 4's spring `duration` is PERCEPTUAL: the real settle is
  // 1.5× it (lib/typescript/animation/spring/springConfigs.d.ts), so {400} lands in ~600 ms.
  // Add the gesture's `velocity` at the call site: withSpring(v, { ...MOTION.spring.snap, velocity }).
  spring: {
    /** Default settle, no overshoot. */
    default: { duration: 400, dampingRatio: 1 },
    /** Snap back / reposition after a drag — bounce only because a finger threw it. */
    snap: { duration: 400, dampingRatio: 0.8 },
    /** Sheet or drawer let go after a drag. */
    sheet: { duration: 300, dampingRatio: 0.8 },
  } satisfies Record<string, WithSpringConfig>,

  /** Press feedback: scale on press-IN via a CSS transition; a child tint instead under Reduce Motion. */
  press: {
    scale: 0.97,
    duration: D.press,
    durationCss: `${D.press}ms`,
    hitSlop: 12,
    highlight: "rgba(255,255,255,0.10)",
  },

  /** Menus and popovers: from scale 0.95 + opacity 0, origin at the trigger's corner. Never scale(0). */
  popover: {
    fromScale: 0.95,
    enter: { duration: D.popoverEnter, easing: out.fn } satisfies WithTimingConfig,
    exit: { duration: D.popoverExit, easing: out.fn } satisfies WithTimingConfig,
  },
} as const;

export const NAV = {
  // Jeff, 2026-09-23: Android hardware Back "goes back to where we came from" — tab history,
  // not always the Map. Tab switches themselves stay un-animated.
  tabs: { backBehavior: "history" },
} as const;

/**
 * Where a flick would come to rest if it kept decelerating (Apple's exponential decay, not v²/2a).
 * Add it to the release position, then snap to the target nearest that projected point.
 */
export function project(velocity: number, decelerationRate = 0.998): number {
  "worklet";
  return ((velocity / 1000) * decelerationRate) / (1 - decelerationRate);
}

/** Past a boundary, the element follows less the further it goes — resistance, never a hard stop. */
export function rubberband(overshoot: number, dimension: number, constant = 0.55): number {
  "worklet";
  return (overshoot * dimension * constant) / (dimension + constant * Math.abs(overshoot));
}
