// framePacer.ts — the drive map draws at 60 fps on every surface (Jeff, 2026-09-23: "make sure the nav
// is stuck at 60fps for all 4 platforms").
//
// WHY. The heat-probe rows (src/heatProbe.ts, 2026-09-16…23) show the shared self-car ease loop in
// ConvoyMapbox running at 60 on the iPhone and CarPlay (dtP50 17 ms) but at ~120 on Android phones
// (dtP50 8 ms) and ~100–110 on Android Auto (dtP50 9–10 ms, up to ~75 camera pushes a second):
// requestAnimationFrame follows the panel's refresh rate and the loop assumed 60. Every extra frame is
// a setCamera round trip plus a re-render of the self-car tree — heat, for frames nobody needs.
//
// Two pieces, both pure (no React, no platform reads) so tools/sim-qc/frame_pacer_test.mts can drive
// them with a synthetic clock:
//
//  1. frameDue() — a slot pacer for the ease loop. It measures the panel from the callback gaps. On a
//     60 Hz panel (the iPhone, CarPlay, most car heads) it draws EVERY callback — never paced, so a late
//     callback can never cost the next frame. On anything faster (75/90/120/144 Hz) it draws on a
//     60 Hz grid of slots: the long-run rate is 60, and two drawn frames are never closer than
//     MIN_GAP_MS. A declined frame does nothing — the caller just asks for the next one.
//
//     msUntilDue() tells a TIMER standing in for rAF (ConvoyMapbox's pump guard, which falls back to
//     setTimeout when rAF callbacks run away at 1–3 ms) when the next slot is — a flat 16 ms timer on top
//     of eight declined runaway callbacks settled at ~42 fps (Codex review of 39cdbc34).
//
//  2. navMapFps() — the Mapbox MapView `preferredFramesPerSecond` value. rnmapbox 10.3.1 on ANDROID
//     applies that prop only when its MapView already exists (RNMBXMapView.setReactPreferredFramesPerSecond:
//     `if (this::mMapView.isInitialized)`), and a mount's first props land BEFORE the map is created
//     (RNMBXMapViewManager.onAfterUpdateTransaction → applyAllChanges → createMapView). A constant 60
//     was therefore dropped on every Android mount and never sent again, so Mapbox drew at the panel's
//     rate. The value starts one below the cap and becomes the cap right after the MapView's first render
//     (its native MapView is created in that first mount transaction), so the setter runs against a live
//     map — not after the map "loads", which waits for every visible tile and could leave a slow network
//     uncapped (Codex review of 39cdbc34). iOS applies the prop at any time and gets the cap from the start.

export const NAV_FPS = 60;
const FRAME_MS = 1000 / NAV_FPS;
/** A panel whose median callback gap is at least this (≈67 Hz or slower — a 60 Hz panel) is never paced. */
const PACE_BELOW_GAP_MS = 15;
/** How early a callback may land and still take its slot — absorbs vsync jitter. */
const SLACK_MS = 4;
/** Never two drawn frames closer than this: above one 120 Hz period (8.3 ms), below one 60 Hz period. */
const MIN_GAP_MS = 10;
/** Callback gaps kept to measure the panel. */
const GAP_WINDOW = 15;
/** Fewer gaps than this and the panel is not known yet: draw everything. */
const GAP_MIN_SAMPLES = 5;
/** A gap longer than this is the loop idling and restarting, not a refresh period. */
const GAP_MAX_MS = 100;

export type FramePacer = { last: number; gaps: number[]; next: number; drawnAt: number };

export function createFramePacer(): FramePacer {
  return { last: 0, gaps: [], next: 0, drawnAt: 0 };
}

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

/** Call once per animation-frame callback with the current wall clock. True → draw this frame;
 *  false → do nothing and ask for the next frame. */
export function frameDue(p: FramePacer, now: number): boolean {
  if (p.last > 0) {
    const gap = now - p.last;
    if (gap > 0 && gap < GAP_MAX_MS) {
      p.gaps.push(gap);
      if (p.gaps.length > GAP_WINDOW) p.gaps.shift();
    }
  }
  p.last = now;
  if (p.gaps.length < GAP_MIN_SAMPLES || median(p.gaps) >= PACE_BELOW_GAP_MS) {
    p.next = now + FRAME_MS;
    p.drawnAt = now;
    return true;
  }
  if (now < p.next - SLACK_MS || now - p.drawnAt < MIN_GAP_MS) return false;
  // More than a frame behind the grid (the loop idled, or JS stalled): re-anchor on this frame rather
  // than drawing a catch-up burst.
  p.next = now - p.next > FRAME_MS ? now + FRAME_MS : Math.max(p.next + FRAME_MS, now + MIN_GAP_MS);
  p.drawnAt = now;
  return true;
}

/** Milliseconds until frameDue() would next say yes (0 if it would now) — for a timer standing in for rAF. */
export function msUntilDue(p: FramePacer, now: number): number {
  return Math.max(0, p.next - SLACK_MS - now, p.drawnAt + MIN_GAP_MS - now);
}

/** preferredFramesPerSecond for a nav MapView. See piece 2 in the header for why Android starts one below. */
export function navMapFps(platformOS: string, mapMounted: boolean): number {
  return platformOS === "android" && !mapMounted ? NAV_FPS - 1 : NAV_FPS;
}
