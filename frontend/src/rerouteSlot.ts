// rerouteSlot — the ONE-IN-FLIGHT reroute request slot, extracted pure (2026-09-05).
//
// Rodrigo, iOS + CarPlay, phone LOCKED, 2026-09-04 19:14-19:19 PT (crash_reports): every
// off-route trip issued its own reroute request and NOTHING bounded how many could be
// outstanding — the only cancellation was a `setTimeout` that could not fire while JS
// timers were frozen, so the abort timers landed in one burst minutes late. This module
// is the bound: at most one reroute request is registered here, it is aged and abandoned
// from LOCATION FIXES (`sweepRerouteInFlight`, which nav.ts calls on every off-route tick
// — the one clock that survived the freeze), and the off-route gate holds `inflight`
// while the registered request is young (src/offRouteGate.ts, GATE 4).
//
// WHY A SEPARATE, DEPENDENCY-FREE FILE: the first version of this registry lived inline
// in src/nav.ts, and the sim-qc storm gate kept its OWN `outstanding[]` to model it —
// adversarial review (2026-09-05) showed every L/N assertion would still have passed with
// the registry deleted. So the state machine lives here, nav.ts wraps it (adding the
// AbortController, the receipts and the Date.now()), and
// `tools/sim-qc/offroute_storm_test.mts` drives THIS code with an injected clock. Nothing
// here may import React, RN, or anything with side effects — it must run under plain Node.
//
// THE CLAIM TICKET. `useTurnByTurn` knows a reroute is about to be requested (it invokes
// `options.onOffRoute`), but the request itself is issued by the handler in
// app/(app)/map.tsx, which calls `fetchRoutes` / `fetchRouteViaStops` — the same
// functions the initial plot, the scenic route, the search preview and CarPlay search
// call. So the tick ARMS a one-shot ticket immediately before invoking the handler and
// DROPS it in a `finally` the moment the handler returns; the first fetch to run while
// the ticket is armed claims the slot. That claim is synchronous (both fetches register
// before their first `await`, and the handler reaches the fetch call with no `await` of
// its own), so no other fetch can race in between, and a handler that returns early
// without fetching leaves nothing armed.
//
// The slot is freed at ABORT time, not at settle time: an abandoned fetch may never
// settle at all, and a slot that waited for a zombie would wedge the gate shut forever.
// A late zombie result is rejected downstream by map.tsx's supersession + staleness
// checks, and nav end bumps the supersession counter so a result for a finished drive
// can never be applied (review finding F3, same day).
import { rerouteInflightExpired } from "./offRouteGate.ts";

export type RerouteAbortable = { abort(): void };

export type RerouteInFlight = {
  startedAt: number;
  ctl: RerouteAbortable;
  /** Cancels the request's OWN `setTimeout` abort so an abandoned request is reported
   *  once (`src=fix`), not again minutes later when the frozen timer finally fires. */
  cancelTimer?: () => void;
};

export type RerouteSlotState = {
  inflight: RerouteInFlight | null;
  /** The one-shot claim ticket — true only between `armRerouteClaim` and the handler
   *  returning. */
  claim: boolean;
};

export function newRerouteSlotState(): RerouteSlotState {
  return { inflight: null, claim: false };
}

/** Arm the next reroute fetch to occupy the slot. Call immediately before invoking the
 *  off-route handler; pair with `dropRerouteClaim` in a `finally`. */
export function armRerouteClaim(s: RerouteSlotState): void { s.claim = true; }
export function dropRerouteClaim(s: RerouteSlotState): void { s.claim = false; }

/**
 * Called by a route fetch before its first await. Takes the slot ONLY while the ticket is
 * armed — a fetch nobody armed (initial plot, scenic, preview, CarPlay search) must never
 * make the gate report `inflight`. Returns true when the slot was taken.
 */
export function claimRerouteSlot(
  s: RerouteSlotState,
  startedAt: number,
  ctl: RerouteAbortable,
  cancelTimer?: () => void,
): boolean {
  if (!s.claim) return false;
  s.claim = false;
  s.inflight = { startedAt, ctl, cancelTimer };
  return true;
}

/** Identity-checked release for a fetch that settled: a zombie that settles after its
 *  slot was swept must not clear a NEWER request's slot. Returns true when it cleared. */
export function releaseRerouteSlot(s: RerouteSlotState, ctl: RerouteAbortable): boolean {
  if (s.inflight && s.inflight.ctl === ctl) { s.inflight = null; return true; }
  return false;
}

/** Age of the outstanding reroute request, or null when the slot is empty. */
export function rerouteInFlightAgeMs(s: RerouteSlotState, now: number): number | null {
  return s.inflight ? now - s.inflight.startedAt : null;
}

/**
 * FIX-DRIVEN TIMEOUT. Abort and free an outstanding reroute older than
 * ROUTE_FETCH_TIMEOUT_MS (decided by `rerouteInflightExpired`, the same predicate the
 * gate's hold uses, so the two cannot drift). Frees the slot FIRST — the fetch may never
 * settle — then cancels the request's own timer and aborts it, best effort. Returns the
 * abandoned age, or null when nothing was old enough.
 */
export function sweepRerouteInFlight(s: RerouteSlotState, now: number): number | null {
  const f = s.inflight;
  if (!f) return null;
  const age = now - f.startedAt;
  if (!rerouteInflightExpired(age)) return null;
  s.inflight = null;
  try { f.cancelTimer?.(); } catch {}
  try { f.ctl.abort(); } catch {}
  return age;
}

/**
 * Free the slot WITHOUT aborting — the drive ended or the engine unmounted, so whatever
 * is outstanding belongs to a route nobody is on. The request's own timer and settle path
 * still run; map.tsx supersedes its result. Returns the freed age, or null when empty.
 */
export function abandonRerouteInFlight(s: RerouteSlotState, now: number): number | null {
  const f = s.inflight;
  if (!f) return null;
  s.inflight = null;
  return now - f.startedAt;
}
