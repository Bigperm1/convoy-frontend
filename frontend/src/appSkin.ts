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
import { getSettings, updateSettings } from "./settings";

/** What the customer picked. "auto" = follow whatever they are entitled to, which is
 *  the default so the metal ARRIVES with the purchase without them touching a setting. */
export type SkinChoice = "auto" | "brand" | "premium" | "ultra";

type Listener = (t: VisualTier) => void;
const listeners = new Set<Listener>();

/** The highest metal this account has actually paid for. club_founder / beta_og sit at
 *  rank 99 and get the full palette — they are our earliest supporters, not free-riders.
 *  While ENTITLEMENTS_ENFORCED is false every gate answers "unlocked", so honouring that
 *  here too keeps the dev/tester experience consistent with every other gate. */
export function entitledSkin(): VisualTier {
  if (!ENTITLEMENTS_ENFORCED) return "ultra";
  switch (getTier()) {
    case "ultra":
    case "club_founder":
    case "beta_og":
      return "ultra";
    case "premium":
      return "premium";
    default:
      return "brand";
  }
}

const ORDER: VisualTier[] = ["brand", "premium", "ultra"];

/** Which metals this account may choose, cheapest first. Drives the Settings row.
 *  free → [green] · premium → [green, silver] · ultra → [green, silver, gold] */
export function allowedSkins(): VisualTier[] {
  return ORDER.slice(0, ORDER.indexOf(entitledSkin()) + 1);
}

/** The metal actually in force. A stored choice is CLAMPED to what is entitled, so an
 *  expired or downgraded subscription falls back on its own instead of leaving a gold
 *  app behind a lapsed card — and the choice is remembered, so re-subscribing restores
 *  it rather than resetting them to green. */
export function appSkinNow(): VisualTier {
  const max = entitledSkin();
  const choice = (getSettings().appSkin ?? "auto") as SkinChoice;
  if (choice === "auto") return max;
  const want = ORDER.indexOf(choice as VisualTier);
  return want < 0 ? max : ORDER[Math.min(want, ORDER.indexOf(max))];
}

function emit() {
  const t = appSkinNow();
  // One bad listener must never stop the others from re-rendering — a half-applied skin
  // (gold header, green tab bar) is the one state that looks broken rather than plain.
  listeners.forEach((l) => { try { l(t); } catch {} });
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

/** The whole ramp, for gradients and rims. */
export function useAppSkinColors(): TierSkin {
  return skin(useAppSkin());
}

/** The single most-used value: the mid-tone for text and icons on a dark ground.
 *  This is the drop-in replacement for a hardcoded "#2DEC86" in CHROME. */
export function useAccent(): string {
  return skin(useAppSkin()).accent;
}

/** Non-React read, for the car surfaces' imperative template builders. */
export function accentNow(): string {
  return skin(appSkinNow()).accent;
}
