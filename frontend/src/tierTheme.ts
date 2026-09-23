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

// ── NO LOCAL IMPORTS IN THIS FILE. EVER. (2026-08-25) ────────────────────────
// These four used to be imported from components/ManeuverArrow. On 2026-08-25
// ManeuverArrow started importing TIER_SKIN from here so the turn square could wear
// the app skin — which closed a CYCLE: tierTheme -> ManeuverArrow -> tierTheme.
// Whichever module loads second sees the other's exports as undefined, so
// TIER_SKIN.brand.colors evaluated to undefined and <LinearGradient colors={undefined}>
// threw "Cannot read property 'map' of undefined" the moment Settings rendered.
// Jeff hit it twice in a row on a shipped build.
// tierTheme is the ROOT of the visual language, so it owns the values and everything
// else imports FROM it. ManeuverArrow re-exports these names so its existing consumers
// are unaffected.
export const CANDY_COLORS = ["#8CFFC4", "#2DEC86", "#0E9B58"] as const;
export const CANDY_LOCATIONS = [0, 0.45, 1] as const;
export const CANDY_RIM = "rgba(150,255,200,0.55)";
/** The dark glyph/label colour that rides on top of the candy fill. */
export const CANDY_INK = "#04150B";

/** The metals a customer can wear: the untiered brand green, Silver ("premium"), Gold (named "ultra"
 *  from before the 2026-09-22 ladder — the Gold tier's metal) and Diamond (the Ultra add-on's). */
export type VisualTier = "brand" | "premium" | "ultra" | "diamond";

export type TierSkin = {
  /** Vertical gradient, light → mid → deep. Three stops for the classic metals; diamond uses more,
   *  with a hard "horizon" (two stops 0.03 apart) — that edge is what reads as a reflection. */
  colors: readonly [string, string, ...string[]];
  locations: readonly [number, number, ...number[]];
  /** Optional texture laid over every fill (diamond: facets + glints) — see SkinSheen. */
  sheen?: number;
  sheenOpacity?: number;
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
  // DIAMOND — the Ultra add-on's metal (Jeff, 2026-09-17: "yes ultra unlocks diamond skin"; 2026-09-22:
  // "the diamond is only for ultra"). Icy white-blue, kept clear of silver on purpose: platinum sat
  // ΔE76 5–9 from the silver mid, this sits ~18. Reflective on his ask ("a little more reflective like a
  // diamond"): white table → ice → a HARD horizon at 0.47/0.50 into deep blue → lighter crown → a violet
  // fire flash at the bottom edge; SkinSheen lays the facets and glints over every fill.
  diamond: {
    colors: ["#FFFFFF", "#E4F7FF", "#B5E6FF", "#4F9FDB", "#79C3EE", "#D3F1FF", "#EFE6FF"],
    locations: [0, 0.2, 0.47, 0.5, 0.73, 0.9, 1],
    rim: "rgba(236,250,255,0.85)",
    ink: "#062235",
    accent: "#A9E7FF",
    label: "Ultra",
    sheen: require("../assets/images/skin/diamond_sheen.png"),
    sheenOpacity: 0.75,
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
  diamond: require("../assets/images/tier/h-diamond.png"),
} as const;

/** A metal that can sit on a lock or a badge — every metal but the brand green. */
export type LockMetal = Exclude<VisualTier, "brand">;

export const tierH = (tier: LockMetal) => TIER_H[tier];
