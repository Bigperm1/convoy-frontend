// micArbiter.ts — ONE owner of the microphone, process-wide.
//
// ── WHY THIS EXISTS ────────────────────────────────────────────────────────────
// expo-av allows exactly ONE Recording per process, and the loser does not fail
// cleanly: its teardown calls setIdleAudioMode(), which flips
// `allowsRecordingIOS: false` and drops the iOS category from `.playAndRecord` to
// `.playback` — killing the mic of whoever was ALREADY recording. So a second
// recorder does not just get refused, it silently sabotages the first.
//
// Four things record, and until now nothing coordinated them:
//   scout      src/askScout.ts       — "ask Scout", the assistant
//   voice      src/useVoice.ts       — the Nova voice-intent controller
//   ptt        src/pttChannel.ts     — the phone's Comms push-to-talk (60s cap)
//   carComms   src/carplay/carComms.ts — the head unit's transmit (25s cap)
// carComms already refused to start while Scout was capturing, by hand. That was
// the right instinct and the wrong scope: it is one arrow in a four-way problem.
//
// ── THE SECOND, WORSE PROBLEM THIS FIXES ──────────────────────────────────────
// Recorders are not the only things that call setIdleAudioMode(). Every PLAYBACK
// path does too, on the way out: a speed ding (speedDing.ts), a Nova sample
// (novaVoices.ts), a turn announcement (nav.ts), an incoming crew clip
// (livePtt.ts). None of them know a mic is open. Hold the PTT button, let a turn
// announcement finish, and your transmission dies mid-sentence.
//
// And audioMode's own duck backstop made it certain rather than merely likely:
// entering recording mode armed a 10s timer that force-restores idle. The PTT caps
// are 25s and 60s. EVERY transmission over ten seconds had its audio category
// pulled out from under it.
//
// ── WHAT THE ARBITER ACTUALLY DOES ────────────────────────────────────────────
// 1. Exactly one lease at a time. A second request is DENIED, not queued and not
//    preempted — refusing beats colliding, because colliding kills both.
// 2. The lease owns the audio session. Acquire applies RECORDING mode; release
//    applies IDLE. Nobody else has to think about it.
// 3. While a lease is held, setIdleAudioMode() DEFERS instead of applying. The
//    intent is remembered and applied the instant the lease releases, so a ding or
//    a TTS clip finishing can no longer cut a live transmission.
// 4. Every lease has a hard deadline. A recorder that throws, hangs, or is killed
//    by a screen lock cannot strand the mic — the lease self-expires and the
//    session returns to idle.
//
// This module deliberately does NOT touch expo-av. It arbitrates INTENT; the
// recorders still own their own Recording objects.

import { logEvent } from "./crashBreadcrumb";

export type MicOwner = "scout" | "voice" | "ptt" | "carComms";

export type MicLease = {
  readonly owner: MicOwner;
  /** Release the mic. Idempotent — safe to call from a finally AND a catch. */
  release: () => void;
  /** False once released or expired; check before a late async continuation. */
  readonly active: boolean;
};

type Held = {
  owner: MicOwner;
  since: number;
  /** Wall-clock deadline. This — NOT the setTimeout — is the source of truth. */
  expiresAt: number;
  deadline: ReturnType<typeof setTimeout> | null;
  released: boolean;
};

let _held: Held | null = null;
const listeners = new Set<(o: MicOwner | null) => void>();

/** Hard ceiling for any lease that does not name its own. A recorder should always
 *  pass its real cap; this only catches the ones that forget. */
const DEFAULT_LEASE_MS = 65000;

function emit() {
  const o = _held && !_held.released ? _held.owner : null;
  // One bad listener must never strand the mic.
  listeners.forEach((l) => { try { l(o); } catch {} });
}

function finish(held: Held, why: "release" | "expire" | "force", reason?: string) {
  if (held.released) return;
  held.released = true;
  if (held.deadline) { clearTimeout(held.deadline); held.deadline = null; }
  if (_held === held) _held = null;
  if (why !== "release") {
    try { logEvent(`mic-${why} owner=${held.owner} afterMs=${Date.now() - held.since}${reason ? ` why=${reason}` : ""}`); } catch {}
  }
  emit();
}

/**
 * ── WHY THE DEADLINE IS CHECKED ON READ, NOT LEFT TO THE TIMER (2026-08-26) ────
 * iOS suspends JS timers while the phone is locked — that is the documented root
 * cause of the CarPlay dead-buttons bug, and the standing rule from it is: never
 * hinge driver-facing behaviour on a JS timer firing. A lease whose recorder died
 * behind a lock screen would therefore hold the mic until the app came back.
 *
 * So expiry is LAZY: every read reaps an over-deadline lease first. The setTimeout
 * stays as the fast path (it fires the release listeners promptly while the app is
 * awake), but it is an optimisation, not the guarantee. The guarantee is that
 * nobody can ever OBSERVE an expired lease, because observing it reaps it.
 */
function reap() {
  const h = _held;
  if (h && !h.released && Date.now() >= h.expiresAt) finish(h, "expire");
}

/** Who holds the mic right now, or null. */
export function micOwner(): MicOwner | null {
  reap();
  return _held && !_held.released ? _held.owner : null;
}

/** Is the mic hot? audioMode reads this to know whether an idle flip is destructive. */
export function micIsHot(): boolean {
  return micOwner() !== null;
}

export function subscribeMic(fn: (o: MicOwner | null) => void): () => void {
  listeners.add(fn);
  return () => { listeners.delete(fn); };
}

// Denial crumbs are a Supabase INSERT each (see crashBreadcrumb.ts), and a driver can
// drive them in a loop just by mashing a mic button that is being refused. One row per
// (want, held) pair per window is enough to see the collision in telemetry.
const DENY_LOG_WINDOW_MS = 10000;
let _lastDenyKey = "";
let _lastDenyAt = 0;

/**
 * Take the microphone, or fail.
 *
 * Returns null when another owner holds it — the caller must NOT start recording.
 * Denial is the designed outcome, not an error: two recorders is the bug.
 *
 * `maxMs` should be the caller's own recording cap. The lease self-expires past it
 * so a crashed or suspended recorder cannot hold the mic for the rest of the drive.
 */
export function acquireMic(owner: MicOwner, maxMs = DEFAULT_LEASE_MS): MicLease | null {
  const current = micOwner();
  if (current) {
    const key = `${owner}>${current}`;
    const now = Date.now();
    if (key !== _lastDenyKey || now - _lastDenyAt > DENY_LOG_WINDOW_MS) {
      _lastDenyKey = key; _lastDenyAt = now;
      try { logEvent(`mic-denied want=${owner} held=${current} heldMs=${now - (_held?.since ?? now)}`); } catch {}
    }
    return null;
  }

  const ms = Math.max(1000, maxMs + 2000);
  const held: Held = { owner, since: Date.now(), expiresAt: Date.now() + ms, deadline: null, released: false };
  _held = held;

  held.deadline = setTimeout(() => finish(held, "expire"), ms);
  emit();

  return {
    owner,
    get active() { reap(); return !held.released; },
    release: () => finish(held, "release"),
  };
}

/**
 * Escape hatch for teardown paths that must guarantee the mic is free — a nav session
 * ending, Reset app data. Never call this to take the mic from a live owner; use
 * acquireMic and respect the denial. Deliberately NOT wired to app backgrounding:
 * transmitting while backgrounded is a supported case (audioMode sets
 * staysActiveInBackground), so a background force-release would cut a live clip.
 */
export function forceReleaseMic(reason: string): void {
  const h = _held;
  if (!h || h.released) return;
  finish(h, "force", reason);
}
