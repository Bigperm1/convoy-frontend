// Pricing — THE catalog. One table for the paywall, Settings copy, the store consoles (product ids)
// and build 80's RevenueCat wiring. Nothing else in the app may carry a price literal.
//
// Jeff, 2026-09-22 (after the researched review, memory pricing-honest-review-2026-09-22):
// "go with $4.99 - $9.99 with anaul 3 rung (hold ultra for a later date a features". Supersedes the
// same morning's $0.99 / $2.99 / $4.99 four-rung ladder. Why, in one line each (all cited in the review):
// freemium apps convert a median 2.1 % of downloads, not 40 %; cheaper apps convert WORSE (1.5 % vs
// 2.7 %); $0.99 nets $0.84, below what a user costs us; every direct convoy rival's entry plan is
// $5.99–12.99; four rungs was the confusing part.
//
// THE LADDER — three rungs:
//   Free   — everything you need to drive with the club: every car on the map (NO convoy cap), push-to-
//            talk, turn-by-turn on phone + CarPlay + Android Auto, Scout, hazards, clubs and cruises.
//            The promise: paying changes how YOU look and what YOU get alerted about, never who you can
//            see or talk to.
//   Silver — $4.99/mo or $39.99/yr: alerts and identity (speed cameras + alerts, incident feed, every
//            Scout voice + hands-free, your class car in your paint, every map style, route colours,
//            Top Cruise Speed, the silver skin).
//   Gold   — $9.99/mo or $79.99/yr: the 3D map and a 3D car of your class, the gold skin.
//   Ultra  — NOT a tier: Gold's add-on (Jeff, 2026-09-22 evening: "lets do the ultra which is add on to
//            gold when you have gold you have access to ultra, for $2.99 per extra scans also gives you
//            the diamond skin and a custom garage to house your car scans into. its not a tier."). Every
//            Gold member gets Garage Scan (one scan a year included — "extra" scans are the $2.99 ones),
//            the diamond skin, and the custom garage that holds their scanned cars. See ULTRA below.
//
// Store mechanics: Silver + Gold are ONE Apple subscription group (Gold the higher level: upgrade
// immediate, downgrade at renewal); on Play two subscriptions, each with a monthly and a yearly base
// plan, downgrades DEFERRED. USD list prices; CAD tiers are set by hand in both consoles. Family Sharing
// stays OFF (once on, Apple never lets it be turned off).

export type PaidRung = "premium" | "gold";   // "premium" is the Silver rung's storage key (unchanged since 8/20)

export type RungPrice = {
  rung: PaidRung;
  name: "Silver" | "Gold";
  monthlyUsd: number;
  annualUsd: number;
  monthlyProductId: string;   // identical on App Store Connect and Play Console
  annualProductId: string;
  tagline: string;
  includes: string[];         // what this rung ADDS over the one below it
};

export const PRICING: readonly RungPrice[] = [
  {
    rung: "premium", name: "Silver", monthlyUsd: 4.99, annualUsd: 39.99,
    monthlyProductId: "hairpin.silver.monthly", annualProductId: "hairpin.silver.annual",
    tagline: "Every alert, every voice, your car in your paint.",
    includes: [
      "Speed cameras, speed alerts and the road-incident feed",
      "Every Scout voice and hands-free replies",
      "Your class of car in your paint instead of an arrow",
      "Dusk, night, satellite and Auto maps; route colours",
      "Top Cruise Speed and the silver app skin",
    ],
  },
  {
    rung: "gold", name: "Gold", monthlyUsd: 9.99, annualUsd: 79.99,
    monthlyProductId: "hairpin.gold.monthly", annualProductId: "hairpin.gold.annual",
    tagline: "The map in 3D, and your own car on it.",
    includes: [
      "The live 3D map on the phone and in the car",
      "A 3D car of your class in your paint",
      "Ultra: Garage Scan — your own car on the map, one scan a year included",
      "Extra scans $2.99 each, kept in your custom garage",
      "The gold and diamond app skins",
    ],
  },
];

// ULTRA — Gold's add-on, not a tier (see the header). The scan is a CONSUMABLE bought at the moment of the
// scan and used at once, never a banked credit (Apple 3.1.1: purchased credits "may not expire"); the app
// sells it only while Gold is active. What a member has scanned stays theirs if Gold lapses (Jeff 09-17:
// "i agree" — the car is kept and shown flat from the scan's photo on the 2D map).
export const ULTRA = {
  requiresRung: "gold" as const,
  includedScansPerYear: 1,
  extraScanUsd: 2.99,
  extraScanProductId: "hairpin.scan.extra",
  includes: ["Garage Scan of your own car", "The diamond app skin", "A custom garage for every car you scan"],
};

// Server-granted access (build 80, through RevenueCat — never store promo codes, which on Play need a card
// and auto-renew into a charge). A new account gets the Silver trial; a GRC club member gets the club
// grant INSTEAD (not stacked). Neither needs a card; both fall back to Free on their own.
export const GRANTS = {
  newAccountSilverDays: 30,
  clubSilverDays: 90,
} as const;

export const priceLabel = (usd: number): string => `$${usd.toFixed(2)}/mo`;
export const annualLabel = (usd: number): string => `$${usd.toFixed(2)}/yr`;
/** Whole-percent saving of the annual plan against twelve months: 39.99 vs 59.88 → 33. */
export const annualSavingPct = (p: RungPrice): number => Math.round((1 - p.annualUsd / (p.monthlyUsd * 12)) * 100);
export const rungPrice = (rung: PaidRung): RungPrice => PRICING.find((p) => p.rung === rung)!;
