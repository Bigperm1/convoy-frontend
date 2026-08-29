// deepLinks.ts — one-shot intents carried in from OUTSIDE the app: home-screen and
// lock-screen widgets, the iOS Action Button, and Shortcuts.
//
// WIDGETS.md (build 75) specs three: comms/transmit, crew, drive?to=. The widget
// extension itself is native and ships with the paid build, but every one of these
// links lands in JS — so the routing is OTA-able and can be finished, shipped and
// proven BEFORE the SwiftUI views exist. When the widgets land they light up against
// plumbing that has already been driven in the field.
//
// ⚠ THE SCHEME IS `convoy://`, NOT `hairpin://`. The spec writes hairpin:// because the
// brand renamed, but expo's `scheme` in app.json is still "convoy" and changing it is a
// NATIVE change (prebuild) — it belongs to the same cut as the widget target, and adding
// "hairpin" as a SECOND scheme rather than a rename, so existing convoy:// links, the
// Shortcuts people already built, and the CarPlay-connect stopgap keep working.
// Everything below matches on PATH only and is deliberately scheme-agnostic, so the day
// that alias lands this file needs no edit.
//
// WHY A ONE-SHOT STORE AND NOT DIRECT NAVIGATION: a cold launch from a widget races the
// React tree. The URL arrives (or is already waiting in getInitialURL) long before the
// Comms screen or the map has mounted, so "navigate and act" loses the action half. The
// shell routes immediately and PARKS the intent here; the destination screen claims it
// when it is actually ready. take() is destructive, so a claimed intent can never fire
// twice — the bug that would otherwise arm the mic again on every later focus.

export type DeepIntent =
  | { kind: "transmit" }
  | { kind: "crew" }
  | { kind: "drive"; to: string };

let pending: DeepIntent | null = null;
let pendingAt = 0;

// An intent older than this is stale — the driver has moved on, and firing it late
// (arming the mic minutes after a widget tap) is worse than dropping it.
const INTENT_TTL_MS = 20_000;

type Listener = (i: DeepIntent) => void;
const listeners = new Set<Listener>();

/** Park an intent for whichever screen owns it. */
export function setIntent(i: DeepIntent): void {
  pending = i;
  pendingAt = Date.now();
  listeners.forEach((fn) => { try { fn(i); } catch {} });
}

/** Claim an intent of this kind, if one is waiting and still fresh. Destructive. */
export function takeIntent(kind: DeepIntent["kind"]): DeepIntent | null {
  if (!pending || pending.kind !== kind) return null;
  if (Date.now() - pendingAt > INTENT_TTL_MS) { pending = null; return null; }
  const i = pending;
  pending = null;
  return i;
}

/** Fires when an intent arrives while the app is ALREADY running (warm tap). */
export function subscribeIntent(fn: Listener): () => void {
  listeners.add(fn);
  return () => { listeners.delete(fn); };
}

/**
 * Parse a widget / Shortcuts URL into an intent.
 *
 * Matches on the path so it works under any scheme (see the note above), and accepts
 * both `drive` (WIDGETS.md) and `go` (the existing convoy://go?to=work link that powers
 * the "when CarPlay connects" Shortcut) — that link is in testers' hands already and
 * must not break.
 *
 * Returns null for anything unrecognised, INCLUDING the ordinary expo-router URLs the
 * app opens itself, so this can sit on the same Linking listener without hijacking them.
 */
export function parseDeepLink(url: string | null | undefined): DeepIntent | null {
  if (!url) return null;
  // Strip scheme + host so "convoy://comms/transmit" and "https://x/comms/transmit"
  // both reduce to a path we can match.
  const afterScheme = url.replace(/^[a-z][a-z0-9+.-]*:\/\//i, "");
  const [rawPath, rawQuery = ""] = afterScheme.split("?");
  const path = rawPath.replace(/^\/+|\/+$/g, "").toLowerCase();

  if (path === "comms/transmit" || path === "talk/transmit") return { kind: "transmit" };
  if (path === "crew") return { kind: "crew" };

  if (path === "drive" || path === "go") {
    const m = rawQuery.match(/(?:^|&)to=([^&]+)/i);
    const to = m ? decodeURIComponent(m[1]).trim() : "";
    if (to) return { kind: "drive", to };
  }
  return null;
}
