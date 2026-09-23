// Pricing — THE catalog. One table for the paywall, Settings copy, the store consoles (product ids)
// and build 80's RevenueCat wiring. Nothing else in the app may carry a price literal.
//
// Jeff, 2026-09-22: "i think i want to go for volume instead of gouging. Lets stick with free arrow -
// silver $.99/mth - Gold $2.99/mth - Ultra $4.99/mth includes a 3d scan - additional scans $2.99/scan
// (have to have active Ultra plan)." Supersedes the 09-17 ladder ($5.99 / $9.99 / $14.99).
//
// The rungs keep their 09-17 CONTENTS (Jeff's clarified ladder): Free = green arrow, 2D map ·
// Silver = your class of car in your paint on the 2D map + every "Premium" feature · Gold = the 3D map
// and a 3D class car · Ultra = your own car scanned to 3D, ONE Garage Scan included, more at $2.99
// each while Ultra is active, and the diamond skin.
//
// Store mechanics (memory jeff-tier-plan-…, store rules checked 2026-09-17): the three subscriptions
// are one Apple subscription group (levels 1–3, upgrade immediate, downgrade at renewal) and three
// Play subscriptions (DEFERRED for downgrades); the extra scan is a CONSUMABLE in-app purchase that
// the app only offers to an active Ultra. Prices are USD list; CAD tiers are set in the consoles.
// Annual plans: not decided — none offered.

export type PaidRung = "premium" | "gold" | "ultra";   // "premium" is the Silver rung's storage key (unchanged since 8/20)

export type RungPrice = {
  rung: PaidRung;
  name: "Silver" | "Gold" | "Ultra";
  monthlyUsd: number;
  productId: string;          // identical on App Store Connect and Play Console
  tagline: string;
  includes: string[];         // what this rung ADDS over the one below it (the paywall shows the ladder)
};

export const PRICING: readonly RungPrice[] = [
  {
    rung: "premium", name: "Silver", monthlyUsd: 0.99, productId: "hairpin.silver.monthly",
    tagline: "Your car, your paint, the whole feature set.",
    includes: [
      "Your class of car in your paint instead of an arrow",
      "Dusk, night, satellite and Auto maps; route colours",
      "Speed cameras, speed alerts, the road-incident feed",
      "Every Scout voice and hands-free replies",
      "Unlimited convoy, your own clubs, events and cruises",
      "The silver app skin",
    ],
  },
  {
    rung: "gold", name: "Gold", monthlyUsd: 2.99, productId: "hairpin.gold.monthly",
    tagline: "The 3D map, and a 3D car on it.",
    includes: ["The live 3D map on every surface", "A 3D car of your class in your paint", "The gold app skin"],
  },
  {
    rung: "ultra", name: "Ultra", monthlyUsd: 4.99, productId: "hairpin.ultra.monthly",
    tagline: "Not a car like yours. Yours.",
    includes: ["Garage Scan: one 3D scan of your own car included", "Extra scans $2.99 each while Ultra is active", "The diamond app skin"],
  },
];

/** The extra Garage Scan: a consumable, sold only to an active Ultra. The first scan rides with Ultra. */
export const SCAN_EXTRA = {
  usd: 2.99,
  productId: "hairpin.scan.extra",
  requiresRung: "ultra" as const,
  includedWithUltra: 1,
};

export const priceLabel = (usd: number): string => `$${usd.toFixed(2)}/mo`;
export const rungPrice = (rung: PaidRung): RungPrice => PRICING.find((p) => p.rung === rung)!;
