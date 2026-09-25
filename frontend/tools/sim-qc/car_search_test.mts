// car_search_test — the head-unit search query rules (src/carSearchQuery.ts). Say Phin, Android
// Auto, 2026-09-24: the host's voice input typed "navigate home" into our search box verbatim and
// Google Places (New) answered with "Navigate Homes, Coralville IA" and friends — the 50 km
// locationBias is soft, and saved places were listed only for an EMPTY query. Pins: the command
// words are stripped (and only as whole leading words — "Navigation Ave", "Golden Ears", "Drive
// Thru Cafe" survive), a query that is only a verb comes back empty (→ the saved list), the
// normalised text names a saved place through its label or a spoken alias with Home/Work/custom
// precedence, the 150 km restriction is a rectangle that holds Whistler and drops Kamloops and
// Seattle from Vancouver, and the crumb text is one quote-free line.
import {
  CAR_SEARCH_COMMANDS, CAR_SEARCH_CRUMB_QUIET_MS, CAR_SEARCH_REGIONS, CAR_SEARCH_RESTRICT_KM,
  carSearchRestriction, crumbText, matchSavedPlace, normalizeCarQuery, orderSavedPlaces, pickCarSearchScope,
  type SavedPlaceLike,
} from "../../src/carSearchQuery.ts";

let fails = 0;
const ok = (name: string, cond: boolean, detail = "") => {
  if (!cond) { fails++; console.log(`  FAIL ${name} ${detail}`); } else console.log(`  ok   ${name} ${detail}`);
};
const eq = (name: string, got: string, want: string) => ok(name, got === want, `got=${JSON.stringify(got)} want=${JSON.stringify(want)}`);

// A — the normaliser
{
  eq("A1 Say Phin's literal phrase", normalizeCarQuery("navigate home"), "home");
  eq("A2 'navigate to' + an address keeps its case", normalizeCarQuery("Navigate to 123 Main St"), "123 Main St");
  eq("A3 take me to", normalizeCarQuery("take me to work"), "work");
  eq("A4 go to keeps the article for the alias", normalizeCarQuery("Go to the office"), "the office");
  eq("A5 drive to", normalizeCarQuery("drive to Whistler"), "Whistler");
  eq("A6 directions to + trailing please", normalizeCarQuery("Directions to Tim Hortons please"), "Tim Hortons");
  eq("A7 get me to", normalizeCarQuery("get me to home"), "home");
  eq("A8 a bare verb is EMPTY (saved list)", normalizeCarQuery("navigate"), "");
  eq("A9 'navigate to' alone is EMPTY", normalizeCarQuery("Navigate to"), "");
  eq("A10 a plain place is untouched", normalizeCarQuery("Tim Hortons"), "Tim Hortons");
  eq("A11 whitespace + punctuation", normalizeCarQuery("  navigate   to   home. "), "home");
  eq("A12 word boundary: Navigation Ave survives", normalizeCarQuery("Navigation Ave"), "Navigation Ave");
  eq("A13 'Navigate Homes' loses only the verb", normalizeCarQuery("Navigate Homes"), "Homes");
  eq("A14 leading filler", normalizeCarQuery("please take me to work"), "work");
  eq("A15 'Drive Thru Cafe' survives (bare drive is not a command)", normalizeCarQuery("Drive Thru Cafe"), "Drive Thru Cafe");
  eq("A16 'Golden Ears' survives ('go' needs 'to')", normalizeCarQuery("Golden Ears"), "Golden Ears");
  eq("A17 navigate me to", normalizeCarQuery("navigate me to the gym"), "the gym");
  eq("A18 only ONE command stripped", normalizeCarQuery("go to go to"), "go to");
  eq("A19 empty in, empty out", normalizeCarQuery("   "), "");
  eq("A20 'ok navigate to' filler + verb, nothing left", normalizeCarQuery("ok navigate to"), "");
  eq("A21 a comma after the verb", normalizeCarQuery("Navigate to, 45 Water St"), "45 Water St");
  ok("A22 every command phrase strips to empty on its own", CAR_SEARCH_COMMANDS.every((c) => normalizeCarQuery(c) === "" && normalizeCarQuery(c.toUpperCase()) === ""),
    CAR_SEARCH_COMMANDS.filter((c) => normalizeCarQuery(c) !== "").join(","));
}

// B — the saved-place match
type P = SavedPlaceLike & { id: string };
const home: P = { id: "h", kind: "home", label: "Home", createdAt: 1 };
const work: P = { id: "w", kind: "work", label: "Work", createdAt: 2 };
const gym: P = { id: "g", kind: "custom", label: "Gym", createdAt: 3 };
const moms: P = { id: "m", kind: "custom", label: "Mom's", createdAt: 4 };
const gymNew: P = { id: "g2", kind: "custom", label: "gym", createdAt: 5 };
const all: P[] = [gym, moms, work, home];
{
  ok("B1 'home' → Home", matchSavedPlace("home", all)?.id === "h");
  ok("B2 'my house' → Home", matchSavedPlace("my house", all)?.id === "h");
  ok("B3 'the office' → Work", matchSavedPlace("the office", all)?.id === "w");
  ok("B4 'work' → Work", matchSavedPlace("work", all)?.id === "w");
  ok("B5 exact custom label", matchSavedPlace("Gym", all)?.id === "g");
  ok("B6 'the gym' → Gym", matchSavedPlace("the gym", all)?.id === "g");
  ok("B7 prefix while typing: 'gy' → Gym", matchSavedPlace("gy", all)?.id === "g");
  ok("B8 a place that is not saved → null", matchSavedPlace("Tim Hortons", all) === null);
  ok("B9 no saved Home → 'home' is null (Places gets it)", matchSavedPlace("home", [work, gym]) === null);
  ok("B10 case-insensitive", matchSavedPlace("HOME", all)?.id === "h");
  ok("B11 duplicate label → the newest custom", matchSavedPlace("gym", [...all, gymNew])?.id === "g2");
  ok("B12 one character never matches", matchSavedPlace("h", all) === null);
  ok("B13 'homes' is not Home", matchSavedPlace("homes", all) === null);
  ok("B14 apostrophe label", matchSavedPlace("mom's", all)?.id === "m");
  ok("B15 empty saved list", matchSavedPlace("home", []) === null);
  ok("B16 'wo' prefix → Work", matchSavedPlace("wo", all)?.id === "w");
  ok("B17 the pipeline: 'navigate home' → Home", matchSavedPlace(normalizeCarQuery("navigate home"), all)?.id === "h");
  ok("B18 the pipeline: 'take me to the office' → Work", matchSavedPlace(normalizeCarQuery("take me to the office"), all)?.id === "w");
  const ord = orderSavedPlaces([gymNew, moms, work, gym, home, { id: "x", kind: "custom", label: "", createdAt: 9 }]);
  ok("B19 list order Home, Work, custom newest-first, blank labels dropped", ord.map((p) => p.id).join(",") === "h,w,g2,m,g", ord.map((p) => p.id).join(","));
}

// C — the restriction rectangle (Vancouver 49.28, -123.12)
{
  const r = carSearchRestriction(49.28, -123.12);
  const inside = (lat: number, lng: number) =>
    lat >= r.rectangle.low.latitude && lat <= r.rectangle.high.latitude && lng >= r.rectangle.low.longitude && lng <= r.rectangle.high.longitude;
  ok("C1 half-side is 150 km of latitude", Math.abs((r.rectangle.high.latitude - r.rectangle.low.latitude) / 2 * 111.32 - CAR_SEARCH_RESTRICT_KM) < 0.5,
    `${((r.rectangle.high.latitude - r.rectangle.low.latitude) / 2 * 111.32).toFixed(1)} km`);
  ok("C2 longitude widened by cos(lat)", Math.abs((r.rectangle.high.longitude - r.rectangle.low.longitude) / 2 - 150 / (111.32 * Math.cos((49.28 * Math.PI) / 180))) < 1e-9);
  ok("C3 Whistler inside", inside(50.116, -122.957));
  ok("C4 Hope inside", inside(49.383, -121.441));
  ok("C5 Kamloops outside (the fallback request's job)", !inside(50.676, -120.34));
  ok("C6 Seattle outside", !inside(47.606, -122.33));
  ok("C7 centred on the car", Math.abs((r.rectangle.low.latitude + r.rectangle.high.latitude) / 2 - 49.28) < 1e-9 && Math.abs((r.rectangle.low.longitude + r.rectangle.high.longitude) / 2 + 123.12) < 1e-9);
  const pole = carSearchRestriction(89.5, 10);
  const finite = (x: number) => Number.isFinite(x) && x >= -180 && x <= 180;
  ok("C8 clamped at the pole, finite box", pole.rectangle.high.latitude === 90 && finite(pole.rectangle.low.longitude) && finite(pole.rectangle.high.longitude), JSON.stringify(pole));
  const wrap = carSearchRestriction(0, 179.5);
  ok("C9 antimeridian: low.lng > high.lng spells the wrap", wrap.rectangle.low.longitude > wrap.rectangle.high.longitude && wrap.rectangle.high.longitude < -179, `${wrap.rectangle.low.longitude} → ${wrap.rectangle.high.longitude}`);
  ok("C10 regions are Canada + US", CAR_SEARCH_REGIONS.join(",") === "ca,us");
  ok("C11 crumb quiet window is under a keystroke pause but over a fast typist", CAR_SEARCH_CRUMB_QUIET_MS >= 500 && CAR_SEARCH_CRUMB_QUIET_MS <= 1500);
}

// D — crumb text
{
  eq("D1 quotes and whitespace", crumbText(' say  "navigate"\nhome '), "say 'navigate' home");
  ok("D2 capped", crumbText("x".repeat(100)).length === 48 && crumbText("x".repeat(100)).endsWith("…"));
  eq("D3 short untouched", crumbText("Tim Hortons"), "Tim Hortons");
}

// E — which answer the car shows (fixtures = the live 2026-09-24 receipts, ids shortened)
{
  const R = (...ids: string[]) => ids.map((placeId) => ({ placeId }));
  // "Kamloops": restricted = five local streets; biased = the city first, then two of those streets.
  const kNear = R("kam-st-van", "kam-pl-poco", "kam-ave-vic", "kam-st-nw", "kam-plaza");
  const kWide = R("kamloops-bc", "kamloops-yka", "kam-st-van", "kam-pl-poco", "kamloops-lake");
  let pick = pickCarSearchScope(kNear, kWide);
  ok("E1 Kamloops: Google's top pick is far → the biased list, city first", pick.scope === "wide" && pick.rows[0].placeId === "kamloops-bc");
  // "Tim Hortons": both lists local, same top row → the restricted list drops any far tail.
  const tNear = R("th-georgia", "th-hope", "th-no3", "th-kgb", "th-bridgeport");
  const tWide = R("th-georgia", "th-no3", "th-bellingham", "th-kgb");
  pick = pickCarSearchScope(tNear, tWide);
  ok("E2 Tim Hortons: top pick local → restricted rows, far tail gone", pick.scope === "near" && pick.rows.length === 5 && !pick.rows.some((r) => r.placeId === "th-bellingham"));
  // "navigate home" literal: restricted 0, biased = Coralville & co → biased (only the normaliser saves this one).
  pick = pickCarSearchScope([], R("coralville", "bentonville"));
  ok("E3 nothing local → the biased list as before", pick.scope === "wide" && pick.rows.length === 2);
  ok("E4 biased request failed → restricted rows", pickCarSearchScope(tNear, []).scope === "near");
  ok("E5 both empty → none", pickCarSearchScope([], []).scope === "none" && pickCarSearchScope([], []).rows.length === 0);
  const frozen = Object.freeze(R("a", "b"));
  ok("E6 returns a copy, never the input array", pickCarSearchScope(frozen, frozen).rows !== frozen);
}

console.log(fails === 0 ? "\nPASS car_search" : `\nFAIL car_search (${fails})`);
if (fails) process.exit(1);
