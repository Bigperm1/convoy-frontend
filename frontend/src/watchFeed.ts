// watchFeed — what the phone pushes to the wrist, and when. Pure; node-gated by
// tools/sim-qc/watch_feed_test.mts. src/watchLink.ts is the only RN caller.
//
// The payload is built from the SAME carStore fields the car list renders (instruction,
// distanceToTurnM, maneuverIcon, maneuverKey, etaSeconds, peers) so the wrist can never show a
// different turn than the head unit. Sends are on-change and ≤ 2 Hz — WatchConnectivity
// applicationContext is last-writer-wins and sendMessage is not free — except that nav on/off
// and a step change go through at once. The watch treats a payload older than 30 s as stale.
import { tapSideFor, type TapSide } from "./watchTaps.ts";

export type WatchNav = { on: boolean; glyph: string; street: string; distM: number; side: TapSide; etaS: number; stepIdx: number };
export type WatchPayload = { v: 1; nav: WatchNav; crew: { live: number }; at: number };
export type WatchFeedInput = {
  navigating: boolean; maneuverIcon?: string; instruction: string; distanceToTurnM: number;
  maneuverKey?: string; etaSeconds?: number; stepIdx: number; peersLive: number;
};

export const WATCH_SEND_MIN_GAP_MS = 500;
export const WATCH_STALE_MS = 30_000;

export function buildWatchPayload(i: WatchFeedInput, atMs: number): WatchPayload {
  const on = !!i.navigating;
  const nav: WatchNav = on
    ? {
        on, glyph: i.maneuverIcon ?? "", street: i.instruction ?? "",
        distM: Number.isFinite(i.distanceToTurnM) ? Math.round(i.distanceToTurnM) : 0,
        side: tapSideFor(i.maneuverKey), etaS: Number.isFinite(i.etaSeconds ?? NaN) ? Math.round(i.etaSeconds as number) : 0,
        stepIdx: i.stepIdx,
      }
    : { on: false, glyph: "", street: "", distM: 0, side: "generic", etaS: 0, stepIdx: -1 };
  return { v: 1, nav, crew: { live: Math.max(0, i.peersLive | 0) }, at: atMs };
}

export function shouldSendWatch(prev: WatchPayload | null, next: WatchPayload, lastSentAt: number): boolean {
  if (!prev) return true;
  if (prev.nav.on !== next.nav.on || prev.nav.stepIdx !== next.nav.stepIdx) return true;
  if (prev.crew.live !== next.crew.live) return true;
  const changed = prev.nav.distM !== next.nav.distM || prev.nav.street !== next.nav.street || prev.nav.glyph !== next.nav.glyph || prev.nav.etaS !== next.nav.etaS || prev.nav.side !== next.nav.side;
  if (!changed) return false;
  return next.at - lastSentAt >= WATCH_SEND_MIN_GAP_MS;
}

export function isWatchStale(at: number, nowMs: number): boolean {
  return !(at > 0) || nowMs - at >= WATCH_STALE_MS;
}
