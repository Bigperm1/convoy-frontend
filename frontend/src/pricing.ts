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
//   Free   — the 2D green arrow on the 2D map, and everything you need to drive with the club: every car on the map (NO convoy cap), push-to-
//            talk, turn-by-turn on phone + CarPlay + Android Auto, Scout, hazards, clubs and cruises.
//            The promise: paying changes how YOU look and what YOU get alerted about, never who you can
//            see or talk to.
//   Silver — $4.99/mo or $39.99/yr: alerts and identity (speed cameras + alerts, incident feed, every
//            Scout voice + hands-free, your class car in your paint, every map style, route colours,
//            Top Cruise Speed, the silver skin).
//   Gold   — $9.99/mo or $79.99/yr: the 3D map, the 3D arrow or a 3D car of your class, the gold skin
//            (Jeff 2026-09-22: "the free tier has a 2d arrow and the gold tier gets the 3d arrow").
//   Ultra  — NOT a tier: GOLD-YEARLY'S ADD-ON, sold as one yearly plan "Gold + Ultra" at $84.99 (Jeff,
//            2026-09-22, SET IN STONE: "what if ultra was $4.99 and that get 3 more scans would that work at
//            $84.99?" … "i like your ideas and lets set this in stone"). Includes the diamond skin, the Ultra
//            garage that holds every scanned car, and 3 Garage Scans a year — unused scans carry over while
//            Ultra stays active; scans past those are $2.99 each. Monthly Gold cannot add Ultra: switching to
//            Gold + Ultra is an upgrade (higher level), so it applies at once with a prorated refund.
//
// Store mechanics: Silver, Gold and Gold + Ultra are ONE Apple subscription group, levels Silver < Gold <
// Gold + Ultra (Apple: one plan per group at a time; "They're immediately upgraded and receive a refund of
// the prorated amount"; downgrades wait for renewal). Apple has no add-on subscription, so Ultra is never a
// second $5 subscription — that would bill on its own date and keep charging after Gold lapses. On Play,
// Gold + Ultra is its own yearly plan at the same $84.99 (Play's add-ons exist but not in India/Korea and
// block pause), downgrades DEFERRED. USD list prices; CAD tiers are set by hand in both consoles. Family Sharing
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
    tagline: "The map in 3D, and your car on it in 3D.",
    includes: [
      "The live 3D map on the phone and in the car",
      "The 3D arrow, or a 3D car of your class in your paint",
      "The gold app skin",
      "Go yearly and add Ultra for $5: your own car scanned, the diamond skin, the Ultra garage",
    ],
  },
];

// ULTRA — Gold-yearly's add-on, one plan (see the header). The 3 included scans are a subscription allowance
// that CARRIES OVER while Ultra stays active and PAUSES if Ultra lapses (back when it is renewed) (Apple 3.1.1 says purchased credits "may not expire"; whether that
// reaches a subscription allowance is unverified, so we never expire them). An extra scan is a CONSUMABLE
// bought at the moment of the scan and used at once — never banked — and sold only while Ultra is active.
// What a member has scanned stays theirs if Ultra or Gold lapses (Jeff 09-17: "i agree" — the car is kept
// and shown flat from the scan's photo on the 2D map).
export const ULTRA = {
  name: "Gold + Ultra",
  annualUsd: 84.99,                    // = Gold yearly $79.99 + $5.00; ONE yearly plan, no monthly
  annualProductId: "hairpin.gold_ultra.annual",
  includedScansPerYear: 3,
  scansCarryOver: true,                // while Ultra stays active
  scansPauseOnLapse: true,             // Jeff 2026-09-22: "unused scans pause till ultra is back" — kept, not usable, until renewal
  extraScanUsd: 2.99,
  extraScanProductId: "hairpin.scan.extra",
  tagline: "Your own car on the map — and every car you own in your garage.",
  includes: [
    "Everything in Gold",
    "3 Garage Scans a year — your own car on the map; unused scans carry over",
    "Extra scans $2.99 each",
    "The Ultra garage — every car you scan, pick today's car",
    "The diamond app skin",
  ],
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
