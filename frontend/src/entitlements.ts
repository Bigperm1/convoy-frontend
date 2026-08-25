// Entitlements — the single source of truth for what this account may use.
//
// STAGED (2026-08-20, build-80 plan): ENTITLEMENTS_ENFORCED is FALSE, so every
// gate in the app answers "unlocked" and NOTHING changes for today's testers.
// Flipping the one flag below (or, later, the backend-driven remote flag) arms
// the whole free/premium split at once. Do not flip it before the backend can
// hand out tiers by email — existing testers would see locks.
//
// Tiers (build-80 plan, Jeff 8/20; three-rung ladder confirmed 8/20 evening):
//   beta_og      — original beta testers; personal codes, never expire. All access.
//   club_founder — GRC club members; all access until the store launch flag.
//   ultra        — paid top tier: YOUR exact car on the map (the authored car
//                  library today, Garage Scan when it ships).
//   premium      — paid subscriber: Class 3D + palette and every other lock.
//   free         — green arrow, the store-launch free tier.
//
// The truth lives server-side against the account email; this module only
// caches it. `syncEntitlement()` refreshes the cache from the backend (endpoint
// ships with the referral work, build 77); until then the cached tier simply
// stays at its default and the master switch keeps everything open.

import AsyncStorage from "@react-native-async-storage/async-storage";
import { api } from "./api";

// ── Master switch ────────────────────────────────────────────────────────────
export const ENTITLEMENTS_ENFORCED = false;

export type Tier = "free" | "premium" | "ultra" | "club_founder" | "beta_og";

// Every gated surface names its feature here — one key per lock in the app.
// (Jeff's free-tier list, 8/20.)
export type PremiumFeature =
  | "arrow_colors"      // arrow paint — green stays free
  | "class_marker"      // Class 3D map appearance (premium)
  | "car_3d"            // ULTRA — your exact car (authored library / Garage Scan)
  | "club_create"       // creating Clubs/Events/Cruises (viewing is free)
  | "top_speed"         // Top Cruise Speed card
  | "map_modes"         // map styles beyond Day
  | "route_colors"      // route colours beyond green
  | "speed_cameras"
  | "road_incidents"
  | "voice_extras"      // Scout voices beyond Nova
  | "spoken_extras"
  | "speed_alert"
  | "comms_handsfree"   // VOX — push-to-talk stays free
  | "convoy_size"       // >3 cars in a live convoy
  // The app-wide metal (src/appSkin.ts). TWO features, not one, because the skin is a
  // LADDER and a single FEATURE_RANK entry cannot express two gates: silver unlocks at
  // premium, gold only at ultra. Modelling it this way means the Settings rows get the
  // right H and the right paywall for free, via the same useFeature/useFeatureTier path
  // every other gate uses.
  | "app_skin_silver"    // PREMIUM — the silver app skin
  | "app_skin_gold";     // ULTRA — the gold app skin (silver can never reach it)

const STORE_KEY = "convoy.entitlement.v1";
const DEV_KEY = "convoy.entitlement.devTier"; // manual QA override, survives reload

let tier: Tier = "free";
let hydrated = false;

type Listener = () => void;
const listeners = new Set<Listener>();
const emit = () => listeners.forEach((l) => l());

export function subscribeEntitlement(fn: Listener): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function getTier(): Tier {
  return tier;
}

async function hydrate() {
  if (hydrated) return;
  hydrated = true;
  try {
    const dev = await AsyncStorage.getItem(DEV_KEY);
    const stored = await AsyncStorage.getItem(STORE_KEY);
    const t = (dev || stored) as Tier | null;
    if (t === "free" || t === "premium" || t === "ultra" || t === "club_founder" || t === "beta_og") {
      tier = t;
      emit();
    }
  } catch {}
}
hydrate();

async function setTier(t: Tier) {
  tier = t;
  emit();
  try {
    await AsyncStorage.setItem(STORE_KEY, t);
  } catch {}
}

// Manual QA: flip the local tier without a backend (e.g. from a dev screen or
// a debugger). Clears with null.
export async function __setDevTier(t: Tier | null) {
  try {
    if (t) await AsyncStorage.setItem(DEV_KEY, t);
    else await AsyncStorage.removeItem(DEV_KEY);
  } catch {}
  if (t) {
    tier = t;
    emit();
  } else {
    hydrated = false;
    tier = "free";
    await hydrate();
    emit();
  }
}

// ── Gating ───────────────────────────────────────────────────────────────────
// Rank ladder: a feature is unlocked at its required rank or above. beta_og and
// club_founder sit above ultra — all access, per Jeff (their reward tiers).
const TIER_RANK: Record<Tier, number> = {
  free: 0,
  premium: 1,
  ultra: 2,
  club_founder: 99,
  beta_og: 99,
};

// Everything defaults to premium (rank 1); only the exact-car experience is ultra.
const FEATURE_RANK: Partial<Record<PremiumFeature, number>> = {
  car_3d: 2,
  app_skin_gold: 2,
};

/**
 * WHICH tier gates a feature — the visual axis, not the unlocked axis.
 *
 * isUnlocked() answers "can I use this"; this answers "what would I buy". The UI
 * needs both, and until 2026-08-23 it only had the first: the Class tile
 * (premium) and the 3D tile (ultra) rendered an IDENTICAL gold badge, so the
 * screen quietly told customers the two cost the same thing.
 *
 * Gold = ultra, Silver = premium. See src/tierTheme.ts and DESIGN.md.
 */
export function featureTier(feature: PremiumFeature): "premium" | "ultra" {
  return (FEATURE_RANK[feature] ?? 1) >= TIER_RANK.ultra ? "ultra" : "premium";
}

export function isUnlocked(feature: PremiumFeature): boolean {
  if (!ENTITLEMENTS_ENFORCED) return true;
  return TIER_RANK[tier] >= (FEATURE_RANK[feature] ?? 1);
}

// Free accounts convoy with up to 3 cars total (them + 2). The check belongs at
// the JOIN moment — that's the one paywall that fires under social pressure.
export function maxConvoySize(): number {
  if (!ENTITLEMENTS_ENFORCED) return Number.POSITIVE_INFINITY;
  return tier === "free" ? 3 : Number.POSITIVE_INFINITY;
}

// ── Backend sync (endpoints ship with the referral work, build 77) ──────────
export async function syncEntitlement(): Promise<Tier | null> {
  try {
    const r = await api.get("/entitlement");
    const t = r?.data?.tier as Tier | undefined;
    if (t === "free" || t === "premium" || t === "ultra" || t === "club_founder" || t === "beta_og") {
      await setTier(t);
      return t;
    }
  } catch {}
  return null; // offline / endpoint not live yet — keep the cached tier
}

export async function redeemCode(code: string): Promise<{ ok: boolean; message: string }> {
  try {
    const r = await api.post("/entitlement/redeem", { code: code.trim() });
    const t = r?.data?.tier as Tier | undefined;
    if (t) {
      await setTier(t);
      return { ok: true, message: r?.data?.message || "Code applied — you're in." };
    }
    return { ok: false, message: r?.data?.message || "That code didn't work." };
  } catch (e: any) {
    return { ok: false, message: e?.response?.data?.message || "Couldn't reach the server — try again." };
  }
}
