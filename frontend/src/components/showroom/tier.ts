// showroom/tier.ts — the Showroom's metal and its words (2026-09-22).
//
// ONE metal lookup for the whole Garage page (header chip, stage light, turntable ring, dots, plate
// rim, the primary button, the quiet actions). DESIGN.md: a screen is one metal all the way through.
// The page wears the TIER it is drawn for — Free green, Silver silver, Gold gold, Ultra diamond — the
// existing skin ladder (src/appSkin.ts / src/tierTheme.ts). Locks and the "Up next" card are paywall
// surfaces and wear the FEATURE's metal instead (useFeatureTier), never this one.
//
// Prices come ONLY from src/pricing.ts — no price literal lives in this file.

import type { VisualTier } from "../../tierTheme";
import type { PremiumFeature } from "../../entitlements";
import { rungPrice, ULTRA, priceLabel, annualLabel } from "../../pricing";
import { goldIsYearly, type CarKind, type GarageTier } from "../../garageCars";

export function garageMetal(t: GarageTier): VisualTier {
  switch (t) {
    case "free": return "brand";
    case "silver": return "premium";
    case "gold": return "ultra";
    case "ultra": return "diamond";
  }
}

/** The tier's word — the header chip's (Ultra's header chip is the scan allowance instead, the approved
 *  design) and the stage's right-hand chip's (which always says the word, ULTRA included). */
export const TIER_WORD: Record<GarageTier, string> = {
  free: "FREE", silver: "SILVER", gold: "GOLD", ultra: "ULTRA",
};

/** The rung a car comes with — the stage's right-hand chip, so the member can tell which tier the car on
 *  the turntable belongs to (Jeff, 2026-09-23: "on the right side of the screen (across from 'in your
 *  garage') should have the tier with matching colour"). The same ladder as garageCars' BASE_CARS: the 2D
 *  arrow is Free, the 2D class car Silver, both 3D cars Gold, a scanned car Ultra. No default on purpose:
 *  a new CarKind fails the typecheck here until someone says which rung it is. */
export function carTier(kind: CarKind): GarageTier {
  switch (kind) {
    case "arrow": return "free";
    case "class": return "silver";
    case "arrow3d":
    case "class3d": return "gold";
    case "scan": return "ultra";
  }
}

/** The rung above this view, and the feature whose paywall sells it (PaywallSheet quotes
 *  featureRung(feature): class_marker → Silver, car_3d → Gold, car_scan → Gold + Ultra). */
export function nextRung(t: GarageTier): { tier: GarageTier; feature: PremiumFeature; word: string } | null {
  switch (t) {
    case "free": return { tier: "silver", feature: "class_marker", word: "Silver" };
    case "silver": return { tier: "gold", feature: "car_3d", word: "Gold" };
    case "gold": return { tier: "ultra", feature: "car_scan", word: "Ultra" };
    case "ultra": return null;
  }
}

const usd = (n: number) => `$${n.toFixed(2)}`;

export type UpNext = { label: string; title: string; body: string; cta: string };

/** The one "Up next" card (never a pop-up). Ultra's version is the scan tray, not an upsell. */
export function upNextCopy(t: GarageTier, scansLeft: number): UpNext {
  switch (t) {
    case "free": {
      const s = rungPrice("premium");
      return {
        label: "UP NEXT · SILVER",
        title: "Your car's class, in your paint",
        body: `Plus speed cameras, every Scout voice and all map styles. ${priceLabel(s.monthlyUsd)} or ${annualLabel(s.annualUsd)}.`,
        cta: "See Silver",
      };
    }
    case "silver": {
      const g = rungPrice("gold");
      return {
        label: "UP NEXT · GOLD",
        title: "The map in 3D. Your car in 3D.",
        body: `The 3D arrow or a 3D car of your class, on the phone and in the car. ${priceLabel(g.monthlyUsd)} or ${annualLabel(g.annualUsd)}.`,
        cta: "See Gold",
      };
    }
    case "gold": {
      if (!goldIsYearly()) {
        const g = rungPrice("gold");
        return {
          label: "ADD ULTRA · YEARLY",
          title: "Go yearly to add Ultra",
          body: `Ultra rides on Gold yearly: ${annualLabel(ULTRA.annualUsd)} instead of ${annualLabel(g.annualUsd)} — your own car scanned (${ULTRA.includedScansPerYear} a year), every car in your garage, the diamond skin.`,
          cta: "See yearly",
        };
      }
      return {
        label: "ADD ULTRA · YEARLY",
        title: "Your own car on the map",
        body: `Scan your car (${ULTRA.includedScansPerYear} a year), keep every car in your garage, the diamond skin. ${annualLabel(ULTRA.annualUsd)} on Gold yearly.`,
        cta: "Add Ultra",
      };
    }
    case "ultra": {
      const left = Math.max(0, scansLeft);
      const lead = left === 0
        ? "No included scans left this year"
        : `${left} scan${left === 1 ? "" : "s"} left this year — unused ones carry over`;
      return {
        label: "",
        title: "Scan another car",
        body: `${lead}. After that, ${usd(ULTRA.extraScanUsd)} a scan.`,
        cta: "",
      };
    }
  }
}
