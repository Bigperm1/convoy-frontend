// skinWave.ts — the unlock wave: the whole app turning to the next metal in front of you (2026-09-23).
//
// Jeff, 2026-09-23: "can we have a animation for each unlock tier? something cool like all the buttons etc.. on the
// screen turning to the next tier skin color in real time??"
//
// WHAT IT LOOKS LIKE. A band of light in the NEW metal sweeps down the screen (SkinWaveOverlay). Every skinned element
// turns as the band crosses it — the H tile, the category pills, the map's 2D/3D and Crew buttons, the wallpaper's
// road, the tab bar — then a badge names the unlock ("DIAMOND UNLOCKED · Your 1st 3D scan"). ~1.2 s, one haptic.
//
// HOW (build 79 has no snapshot or mask module — no view-shot, Skia or masked-view — so "sweep the new skin over a
// picture of the old one" is a native build; this is the over-the-air way):
//   • The skin itself does NOT change while the wave runs. Wrapped elements draw the NEW metal as a second layer and
//     reveal it as the band passes them (ui/SkinWave.tsx: SkinFade cross-fades images and gradients, useWaveMetal flips
//     a plain colour at the moment the band crosses, WaveWipe wipes the wallpaper top-down in step with the band).
//   • When the band has left the screen, `apply` makes the change real (setSkinChoice / releasing the unlock hold), so
//     every subscriber re-renders in the new metal — pixel-identical to what the layers already show. Elements not
//     wrapped yet simply turn at that moment.
//   • Opacity and transforms only, on the UI thread (Reanimated shared values — the same machinery LogoMenu runs). No
//     per-frame JS, no colour interpolation, nothing on the map's layers: the map never re-renders per frame (CLAUDE.md,
//     "Per-tick state never goes in a layer style").
//
// WHEN. Only when the change can be SEEN: the app active, no turn-by-turn session, no head unit attached — the caller
// passes that verdict in (`canPlay`, ui/SkinUnlock.tsx canPlayWave), so this module stays free of the nav modules' import
// side effects (it is reachable from the login screen's wallpaper).
// Otherwise the change is applied instantly, as before. Reduce Motion: no band, no sweep — every element cross-fades at
// once over MOTION.duration.fade (DESIGN.md §11.9: keep opacity, drop movement).

import { useEffect, useState } from "react";
import type { VisualTier } from "./tierTheme";
import { MOTION } from "./motion";

/** Milliseconds. The band crosses the screen in `sweep`; an element's reveal starts when the band reaches it and lasts
 *  `reveal`. `arm` lets the second layers mount (at opacity 0) before anything moves; `settle` keeps them on top while
 *  the real skin change re-renders underneath, so a decode can never show a gap. */
export const WAVE = {
  arm: 60,
  sweep: 760,
  reveal: 320,
  settle: 180,
  /** Reduce Motion: one cross-fade, everything at once. */
  reduceReveal: MOTION.duration.fade,
  /** The badge, after the band: in, hold, out. */
  badgeIn: MOTION.duration.popoverEnter,
  badgeHold: 1500,
  badgeOut: MOTION.duration.popoverExit,
  /** The band's height, as a fraction of the screen. */
  bandFrac: 0.2,
} as const;

export type WaveBadge = { title: string; sub?: string };

export type SkinWave = {
  id: number;
  from: VisualTier;
  to: VisualTier;
  /** Date.now() at which the band starts. */
  t0: number;
  reduce: boolean;
  /** 'run' — the layers reveal the new metal; 'settle' — the real skin has changed underneath. */
  phase: "run" | "settle";
  badge?: WaveBadge;
};

let wave: SkinWave | null = null;
let seq = 0;
const listeners = new Set<(w: SkinWave | null) => void>();

function publish(w: SkinWave | null) {
  wave = w;
  listeners.forEach((l) => { try { l(w); } catch {} });
}

export function getSkinWave(): SkinWave | null {
  return wave;
}

export function subscribeSkinWave(fn: (w: SkinWave | null) => void): () => void {
  listeners.add(fn);
  return () => { listeners.delete(fn); };
}

export function useSkinWave(): SkinWave | null {
  const [w, setW] = useState<SkinWave | null>(wave);
  useEffect(() => {
    setW(wave);
    return subscribeSkinWave(setW);
  }, []);
  return w;
}

/** How long a wave runs before `apply` (ms from its start). */
export function waveRunMs(reduce: boolean): number {
  return WAVE.arm + (reduce ? WAVE.reduceReveal : WAVE.sweep + WAVE.reveal);
}

/** When the band reaches `y` (0 = top of the screen, 1 = bottom): ms after t0. Reduce Motion: 0 for everyone. */
export function waveReachMs(y: number, reduce: boolean): number {
  if (reduce) return 0;
  return Math.max(0, Math.min(1, y)) * WAVE.sweep;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * Carry the app from `from` to `to` as a wave, then run `apply` — the write that makes `to` the metal in force
 * (setSkinChoice, releaseSkinHold). If the wave cannot be shown (another is running, nothing changes, the app is not in
 * front, a drive is on), `apply` runs at once and nothing animates. Resolves when the wave is over.
 */
export async function playSkinWave(opts: {
  from: VisualTier;
  to: VisualTier;
  reduce: boolean;
  /** The change can be seen: app in front, no drive (ui/SkinUnlock.tsx canPlayWave). */
  canPlay: boolean;
  apply: () => unknown;
  badge?: WaveBadge;
}): Promise<"played" | "applied"> {
  const { from, to, reduce, canPlay, apply, badge } = opts;
  if (wave || from === to || !canPlay) {
    await apply();
    return "applied";
  }
  const id = ++seq;
  const t0 = Date.now() + WAVE.arm;
  publish({ id, from, to, t0, reduce, phase: "run", badge });
  try {
    await sleep(waveRunMs(reduce));
    await apply();
    const cur = getSkinWave();
    if (cur?.id === id) publish({ ...cur, phase: "settle" });
    await sleep(WAVE.settle);
  } finally {
    if (getSkinWave()?.id === id) publish(null);
  }
  return "played";
}
