// Tier visual language — GOLD = Ultra Premium, SILVER = Premium.
//
// Jeff, 2026-08-23: "change the ultra Premium colours to Gold and the Premium
// colours to Silver replacing the green."
//
// The five-value ladder in entitlements.ts (free / premium / ultra /
// club_founder / beta_og) collapses onto exactly TWO visual treatments here,
// because a customer only ever needs to know two things: is this locked, and
// which thing do I buy. club_founder and beta_og outrank ultra and therefore see
// nothing locked at all — they never need a treatment of their own.
//
// The green brand ramp stays for everything that is NOT tier-gated. Green means
// "yours"; gold and silver mean "a tier". Mixing them is what makes a paywall
// feel like a feature and a feature feel like a paywall.
//
// Construction is the same candy language as the map banner (see
// src/components/ManeuverArrow.tsx): a three-stop vertical gradient plus a pale
// hairline rim, so a gold CTA and a green one are visibly the same object in
// different metal. Full spec: DESIGN.md.

import { CANDY_COLORS, CANDY_LOCATIONS, CANDY_RIM, CANDY_INK } from "./components/ManeuverArrow";

/** The two treatments a customer can see, plus the untiered brand green. */
export type VisualTier = "brand" | "premium" | "ultra";

export type TierSkin = {
  /** Three-stop vertical gradient, light → mid → deep. */
  colors: readonly [string, string, string];
  locations: readonly [number, number, number];
  /** Pale hairline rim that sits on the gradient's edge. */
  rim: string;
  /** Dark ink for glyphs and labels riding ON the fill. */
  ink: string;
  /** Mid-tone for text/icons drawn on a DARK ground (labels, links, outlines). */
  accent: string;
  /** Human name, used for page titles and badge labels. */
  label: string;
};

export const TIER_SKIN: Record<VisualTier, TierSkin> = {
  // Untiered. The map banner's candy green — "this is yours".
  brand: {
    colors: CANDY_COLORS,
    locations: CANDY_LOCATIONS,
    rim: CANDY_RIM,
    ink: CANDY_INK,
    accent: "#2DEC86",
    label: "Hairpin",
  },
  // PREMIUM — silver. Class marker, palettes, and every other rank-1 lock.
  premium: {
    colors: ["#FFFFFF", "#C9D2D8", "#7E878E"],
    locations: [0, 0.45, 1],
    rim: "rgba(255,255,255,0.62)",
    ink: "#14181B",
    accent: "#C9D2D8",
    label: "Premium",
  },
  // ULTRA PREMIUM — gold. Your exact car: the authored library today, Garage
  // Scan when it ships. Stops match the existing PremiumBadge pill so the two
  // never disagree about what gold is.
  ultra: {
    colors: ["#F6D77A", "#E0A93E", "#B97F1F"],
    locations: [0, 0.45, 1],
    rim: "rgba(255,231,163,0.62)",
    ink: "#3A2A05",
    accent: "#E0A93E",
    label: "Ultra Premium",
  },
};

export const skin = (tier: VisualTier): TierSkin => TIER_SKIN[tier];

/**
 * The Hairpin H, cut from the brand mark and re-metalled. This is the LOCK:
 * a silver H means Premium, a gold H means Ultra Premium. Jeff, 2026-08-23:
 * "when you are on the free tier you see the Class locked with a Silver H and
 * the Ultra with a Gold H, as them being the locks."
 *
 * A padlock says "you can't". The H says "this is the part of Hairpin you
 * haven't got yet" — same mark, different metal.
 */
export const TIER_H = {
  premium: require("../assets/images/tier/h-silver.png"),
  ultra: require("../assets/images/tier/h-gold.png"),
} as const;

export const tierH = (tier: Exclude<VisualTier, "brand">) => TIER_H[tier];
