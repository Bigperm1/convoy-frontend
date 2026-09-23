// appSkin.ts — the app-wide metal. Gold for Ultra, Silver for Premium, green for free.
//
// ── WHAT THIS IS (Jeff, 2026-08-24) ─────────────────────────────────────────────
// "could we make it so everything on the app turns to silver and gold when the tier
//  are purchased. and in the setting you have the option to switch back to silver and
//  green when ultra is purchased, and when silver is purchased you can switch back to
//  green but cant get gold? another Ultra feature???"
//
// Yes — and the ladder is the feature. The metal ARRIVES with the tier; the CHOICE is
// what Ultra buys. Premium gets one metal and an escape hatch back to green; Ultra gets
// the whole palette. "Silver cannot reach gold" is what keeps it a perk rather than a
// setting. It is also the best kind of subscription feature: the customer sees what they
// pay for every single time they open the app.
//
// ── ⛔ THIS SKINS THE CHROME. IT MUST NEVER SKIN THE MAP. ───────────────────────
// Measured 2026-08-24, and this is the whole reason the feature is scoped the way it is.
// src/mapboxDirections.ts CONGESTION_COLOR:
//     low/clear "#2DEC86" green · moderate "#FFD60A" yellow · heavy "#FF9500" orange
// Our gold is "#E0A93E" — it lands BETWEEN "slowing" and "congested". A gold route line
// would read as traffic ahead to a driver at speed. So:
//
//   ✅ chrome  — tab bar, toggles, links, headers, page dots, counters, CTAs
//   ❌ NEVER   — route line, congestion, hazards, speed alerts, the green arrow
//                (which is a baked GLB anyway: assets/models/green-arrow-v10.glb)
//   ❌ NEVER   — the tier LOCKS. A gold H has to keep meaning "Ultra"; if every surface
//                is already gold the lock stops selling anything. Locks stay on
//                useFeatureTier(feature), never on the user's chosen skin.
//
// That last carve-out is how this coexists with DESIGN.md's "green means yours, metal
// means a tier": chrome wears YOUR metal, paywall surfaces wear the FEATURE's metal.
//
// ── WHY A MODULE-LEVEL BUS ──────────────────────────────────────────────────────
// Most of the ~140 brand-green call sites live inside StyleSheet.create(), which is
// evaluated once at module load and can never read a hook. Those are overridden at the
// USE site (`style={[styles.x, { color: accent }]}`), which needs a hook — and the
// CarPlay / Android Auto roots are separate React trees with no shared provider. Same
// pattern as mapViewMode / voiceBus / hailBus: a Set of listeners, emit + subscribe.

import { useEffect, useState } from "react";
import { getTier, subscribeEntitlement, ENTITLEMENTS_ENFORCED } from "./entitlements";
import { skin, type VisualTier, type TierSkin } from "./tierTheme";
import { getSettings, updateSettings, subscribeSettings } from "./settings";
import {
  ensureGarageLoaded, getGarage, hasCompletedScan, subscribeGarage, updateGarage, type GarageState, type SkinHold,
} from "./garageStore";

/** What the customer picked. "auto" = follow whatever they are entitled to, which is
 *  the default so the metal ARRIVES with the purchase without them touching a setting. */
export type SkinChoice = "auto" | "brand" | "premium" | "ultra" | "diamond";

type Listener = (t: VisualTier) => void;
const listeners = new Set<Listener>();

// ── DIAMOND IS EARNED BY A SCAN (Jeff, 2026-09-23) ───────────────────────────────
// "lets gate the diamond to when someone actually scans their car it unlocks diamond not on the purchase."
// Buying Gold + Ultra buys the SCANS; the member's first finished 3D scan is what unlocks the Diamond metal —
// with entitlements on or off. Until then the top of the ladder is Gold. One gate, here, because every surface
// (phone chrome, the map's pins, CarPlay and Android Auto buttons) reads its metal through appSkinNow().

/** The signed-in account, set by the app shell (app/(app)/_layout.tsx). The garage store is per ACCOUNT but is only
 *  re-claimed when the Garage gains focus, so until then it can still be the previous account's on this phone: a
 *  store owned by someone else unlocks nothing. Unknown (a car-first launch before the phone UI mounts) = trust the
 *  store, which is this phone's last claimed account. */
let account: string | undefined;
export function setSkinAccount(userId: string | null | undefined): void {
  const next = userId || undefined;
  if (next === account) return;
  account = next;
  emitIfChanged();
}
function storeIsMine(g: GarageState): boolean {
  return !account || !g.ownerId || g.ownerId === account;
}

/** True once this account's first 3D scan has finished (garageStore.hasCompletedScan) — and, with entitlements on,
 *  while it still holds a plan that includes Ultra. */
export function diamondUnlocked(): boolean {
  if (!storeIsMine(getGarage()) || !hasCompletedScan(getSettings())) return false;
  if (!ENTITLEMENTS_ENFORCED) return true;
  const t = getTier();
  return t === "ultra" || t === "club_founder" || t === "beta_og";
}

/** The highest metal this account may wear. club_founder / beta_og sit at rank 99 and get the full palette — they
 *  are our earliest supporters, not free-riders. While ENTITLEMENTS_ENFORCED is false every PAID metal is open, as
 *  every other gate answers "unlocked" — but Diamond still waits for the first scan (see above). */
export function entitledSkin(): VisualTier {
  const top = ENTITLEMENTS_ENFORCED ? tierCeiling() : "diamond";
  return top === "diamond" && !diamondUnlocked() ? "ultra" : top;
}
function tierCeiling(): VisualTier {
  switch (getTier()) {
    case "ultra":      // Gold + Ultra — Diamond, once scanned (Jeff, 2026-09-22: "the diamond is only for ultra")
    case "club_founder":
    case "beta_og":
      return "diamond";
    case "gold":
      return "ultra";  // the gold metal
    case "premium":
      return "premium";
    default:
      return "brand";
  }
}

const ORDER: VisualTier[] = ["brand", "premium", "ultra", "diamond"];

/** What "auto" wears: the best metal the account may wear. While entitlements are OFF that is Gold — what every
 *  tester's app wore before Diamond merged (2026-09-22) — until the first 3D scan unlocks Diamond (2026-09-23), which
 *  "auto" then wears: the unlock is the whole point, and it arrives as the unlock wave (skinWave.ts). */
export function autoSkin(): VisualTier {
  return entitledSkin();
}

/** Which metals this account may choose, cheapest first. Drives the Settings row.
 *  free → [green] · silver → [green, silver] · gold → [+ gold] · gold + ultra → [+ diamond] */
export function allowedSkins(): VisualTier[] {
  return ORDER.slice(0, ORDER.indexOf(entitledSkin()) + 1);
}

/** The metal the CHOICE resolves to, ignoring an unlock that is waiting to be shown. A stored choice is CLAMPED to
 *  what is entitled, so an expired or downgraded subscription falls back on its own instead of leaving a gold app
 *  behind a lapsed card — and the choice is remembered, so re-subscribing restores it rather than resetting to green. */
export function appSkinUnheld(): VisualTier {
  return skinForChoice((getSettings().appSkin ?? "auto") as SkinChoice);
}

/** The metal a choice resolves to right now (the App Skin page's wave target). */
export function skinForChoice(choice: SkinChoice): VisualTier {
  const max = entitledSkin();
  if (choice === "auto") return autoSkin();
  const want = ORDER.indexOf(choice as VisualTier);
  return want < 0 ? max : ORDER[Math.min(want, ORDER.indexOf(max))];
}

/** An unlock older than this is shown no more: it simply takes effect (the host could not play it — a long drive,
 *  the app never opened on a tab screen). The metal must never be held back indefinitely. */
const HOLD_MAX_MS = 24 * 60 * 60 * 1000;

function activeHold(): SkinHold | undefined {
  const g = getGarage();
  const h = g.skinHold;
  if (!h || !storeIsMine(g)) return undefined;
  const age = Date.now() - Date.parse(h.at);
  return age >= 0 && age < HOLD_MAX_MS ? h : undefined;
}

/** The metal actually in force: the choice (appSkinUnheld) — or, while an unlock waits to be shown, the metal worn
 *  before it, so every surface (CarPlay and Android Auto included) keeps one metal until the wave carries the new one
 *  in. Clamped, so a hold can never show a metal the account may no longer wear. */
export function appSkinNow(): VisualTier {
  const h = activeHold();
  if (!h) return appSkinUnheld();
  return ORDER[Math.min(ORDER.indexOf(h.from), ORDER.indexOf(entitledSkin()))];
}

/** The unlock waiting to be shown: from → to, and only when it is one — a step UP the ladder (the first scan's only
 *  unlock is Diamond). A hold that now resolves sideways or down (the member picked the arrow in the Garage while it
 *  waited) is no unlock: null, and the host releases it without a wave — never a "GREEN UNLOCKED" for a downgrade the
 *  member chose (review of 84dccea4). */
export function pendingUnlock(): { key: SkinHold["key"]; from: VisualTier; to: VisualTier } | null {
  const h = activeHold();
  if (!h) return null;
  const from = appSkinNow();
  const to = appSkinUnheld();
  if (ORDER.indexOf(to) <= ORDER.indexOf(from)) return null;
  if (h.key === "first-scan" && to !== "diamond") return null;
  return { key: h.key, from, to };
}

/** Hold the metal worn NOW while an unlock lands, so it can be shown (src/skinWave.ts). Call BEFORE the write that
 *  unlocks. A hold already waiting is kept — its `from` is what the member last saw. */
export async function holdSkinForUnlock(key: SkinHold["key"]): Promise<void> {
  await ensureGarageLoaded();
  if (activeHold()) return;
  await updateGarage({ skinHold: { key, from: appSkinNow(), at: new Date().toISOString() } });
}

/** The unlock has been shown (or will not be): wear the new metal. */
export async function releaseSkinHold(): Promise<void> {
  await ensureGarageLoaded();
  if (getGarage().skinHold) await updateGarage({ skinHold: undefined });
}

let lastWorn: VisualTier | null = null;

function emit() {
  const t = appSkinNow();
  lastWorn = t;
  // One bad listener must never stop the others from re-rendering — a half-applied skin
  // (gold header, green tab bar) is the one state that looks broken rather than plain.
  listeners.forEach((l) => { try { l(t); } catch {} });
}

/** Repaint only when the metal in force actually changed — the garage and settings stores notify on every write. */
function emitIfChanged() {
  if (appSkinNow() !== lastWorn) emit();
}

/** Persist a choice and repaint every subscribed surface. Rejects a metal the account
 *  is not entitled to, so "silver cannot reach gold" is enforced HERE and not merely
 *  hidden in the Settings UI — a stale UI can never buy a tier by accident. */
export async function setSkinChoice(choice: SkinChoice): Promise<VisualTier> {
  if (choice !== "auto" && !allowedSkins().includes(choice as VisualTier)) {
    return appSkinNow();
  }
  await updateSettings({ appSkin: choice });
  emit();
  return appSkinNow();
}

export function subscribeAppSkin(fn: Listener): () => void {
  listeners.add(fn);
  return () => { listeners.delete(fn); };
}

// Buying (or losing) a tier repaints the app immediately — no relaunch, and no reading
// of a tier the account no longer holds.
subscribeEntitlement(() => emit());
// A scan landing (completeScanIds / a 'ready' scan), an unlock being held or released, an account claim, and both stores
// finishing their launch load all change what is worn — repaint when they do. The callbacks must not throw
// (settings.ts notifies synchronously inside updateSettings).
subscribeGarage(() => { try { emitIfChanged(); } catch {} });
subscribeSettings(() => { try { emitIfChanged(); } catch {} });
// Start the garage load as early as anything reads the metal — the CarPlay / Android Auto roots build their buttons
// from appSkinNow() at connect, possibly before any phone screen has mounted.
void ensureGarageLoaded();

/** React binding. Re-reads on mount because the value can change between module load
 *  and this mount (a purchase completing while a screen is off-stack, say). */
export function useAppSkin(): VisualTier {
  const [t, setT] = useState<VisualTier>(appSkinNow);
  useEffect(() => {
    setT(appSkinNow());
    return subscribeAppSkin(setT);
  }, []);
  return t;
}

/** React binding for the Diamond unlock (the App Skin row). Re-renders when a scan lands or the account changes, even
 *  when the metal worn does not (a member on Gold who has just unlocked Diamond). */
export function useDiamondUnlocked(): boolean {
  const [v, setV] = useState<boolean>(diamondUnlocked);
  useEffect(() => {
    const read = () => setV(diamondUnlocked());
    read();
    const a = subscribeAppSkin(read);
    const b = subscribeGarage(read);
    const c = subscribeSettings(read);
    return () => { a(); b(); c(); };
  }, []);
  return v;
}

/** The whole ramp, for gradients and rims. */
export function useAppSkinColors(): TierSkin {
  return skin(useAppSkin());
}

/** The single most-used value: the mid-tone for text and icons on a dark ground.
 *  This is the drop-in replacement for a hardcoded "#2DEC86" in CHROME. */
export function useAccent(): string {
  return skin(useAppSkin()).accent;
}

/**
 * The accent at a given opacity, for tint wells, hairline borders and glows.
 *
 * WHY THIS EXISTS: a large share of the brand green in this codebase is not written as
 * "#2DEC86" at all — it is `rgba(45, 236, 134, 0.14)` and friends (45,236,134 IS
 * 0x2D,0xEC,0x86). A hex-only search misses every one of them, and a naive
 * `{ backgroundColor: accent }` override would turn a 14% tint WELL into a solid disc —
 * a visual regression at green tier too, not just under a metal. So alpha must be
 * carried through, never dropped.
 *
 * React Native accepts 8-digit #RRGGBBAA on every platform we ship, so this is a string
 * concat rather than a parse — cheap enough to call in a render.
 */
export function withAlpha(hex: string, alpha: number): string {
  const a = Math.max(0, Math.min(1, alpha));
  return hex + Math.round(a * 255).toString(16).padStart(2, "0");
}

/** The skin accent at a given opacity. `useAccentAlpha(0.14)` replaces a hardcoded
 *  `rgba(45,236,134,0.14)` and keeps the tint a tint. */
export function useAccentAlpha(alpha: number): string {
  return withAlpha(useAccent(), alpha);
}

/** Non-React read, for the car surfaces' imperative template builders. */
export function accentNow(): string {
  return skin(appSkinNow()).accent;
}
