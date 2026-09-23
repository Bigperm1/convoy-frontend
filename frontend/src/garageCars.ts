// garageCars.ts — the Showroom's car model: which cars a member owns, which one is today's car, and
// what "Drive this today" writes (2026-09-22, Jeff: "go build the new garage...").
//
// ── ONE CAR ON THE MAP, MANY IN THE GARAGE ──────────────────────────────────────────────────────────
// Every surface that draws the driver reads the SAME settings fields, and none of them is edited here:
//   phone map   map.tsx → ConvoyMapbox: selfMarkerType, and the scan only while carScanStatus==='ready'
//               (selfScanModelUrl = carScanMapUrl), else the stock GR Corolla by carColor (ConvoyMapbox
//               selfHasScan / selfModelUrl, inside NAV-LOCK region mbx-self-marker-kind-nav)
//   CarPlay/AA  carStore.ts mirrorSettingsToCar → the same four fields, same 'ready' gate
//   peers       map.tsx presence: marker/cls/clsPri/clsSec/arrPri/arrSec, and scanId ONLY while 'ready'
// So a switch is a settings write and nothing else. The inventory — every scan the account made, from
// GET /scan/mine (convoy-backend server.py my_scans; read, never changed) — lives in src/garageStore.ts.
//
// ── WHAT EACH CAR WRITES (and why the scan gets PARKED) ──────────────────────────────────────────────
//   arrow / arrow3d  selfMarkerType 'arrow'. ONE map state: the arrow GLB, flat in the 2D map view and
//                    tilted in the 3D one — 2D/3D is the map's view toggle (src/mapViewMode.ts), not a car.
//   class            selfMarkerType 'class' (+ the saved vehicleClass / classPaint it already has).
//   class3d          selfMarkerType 'car' + the member's 3D CLASS car (class3dChoice): carColor = the bake's paint
//                    ("Pearl Blue", which resolves to exactly that bake — class3dColor) and carMake/carModel = that
//                    class's car, so the map (getVehicleMapModelUrl(carColor)), CarPlay/AA and peers (presence
//                    activeColor = toGRCSlug → "grc_lfa_pearl_blue", which resolveGRCKey reads back) all draw the
//                    same car. carYear is never touched. The member's OWN identity is kept aside meanwhile
//                    (garageStore ownIdentity) and put back when the class car leaves the road.
//   scan:<id>        selfMarkerType 'car' + carScanId/ModelUrl/MapUrl + carScanStatus 'ready'.
// A 'ready' scan BEATS the stock car on every surface and is broadcast to peers whatever the marker
// (map.tsx presence sends scanId whenever 'ready'), so driving ANY non-scan car takes the scan out of
// 'ready' ('none' = parked). That is what makes "Drive this today" true for the people you drive with,
// too — before this, a scanned driver who picked the arrow still showed up to everyone as their scan.
// carScan.reconcileScanState honours the parked flag instead of "restoring" it (see there).
// Skins follow the pick exactly as the old appearance tiles did (SKIN_FOR_MARKER, unchanged values).

import { api } from "./api";
import { getSettings, updateSettings, getSelfMarkerType, getVehicleClass, type Settings, type VehicleClass } from "./settings";
import { CLASS_MODEL_3D, type ClassPaletteEntry } from "./classModels";
import { getVehicleModelKey, resolveGRCKey, type GRCColorKey } from "./vehicleAssets";
import { checkScanReady, scanHeroUrl, scanMapUrl, scanSyncSettled } from "./carScan";
import { setSkinChoice } from "./appSkin";
import { ENTITLEMENTS_ENFORCED, getDevTier, getTier, type Tier } from "./entitlements";
import { logEvent, logEventReliable } from "./crashBreadcrumb";
import {
  claimGarage,
  ensureGarageLoaded,
  getGarage,
  ownIdentityBack,
  updateGarage,
  SKIN_FOR_MARKER,
  SKIN_FOR_SCAN,
  type CarIdentity,
  type GarageScan,
  type GarageState,
  type MarkerType,
} from "./garageStore";

// Appearance -> metal (unchanged values) and the marker type live in garageStore.ts so carScan.ts can land
// a finished scan through the same rule without an import cycle. A finished scan is landed by
// carScan.deliverSubmittedScan — the Garage's return leg and launch-time reconcile share that one path.
export { SKIN_FOR_MARKER };
export type { MarkerType };

// ── Tiers ───────────────────────────────────────────────────────────────────────────────────────────
// Ultra is not a rung on the ladder — it is Gold-yearly's add-on ("Gold + Ultra", src/pricing.ts ULTRA),
// stored as tier "ultra" (src/entitlements.ts, rank 3). The Showroom still draws it as its own view.
export type GarageTier = "free" | "silver" | "gold" | "ultra";

export function garageTierOf(t: Tier): GarageTier {
  switch (t) {
    case "free": return "free";
    case "premium": return "silver";   // "premium" is the Silver rung's storage key (pricing.ts PaidRung)
    case "gold": return "gold";
    default: return "ultra";           // ultra · club_founder · beta_og (rank 99 = all access)
  }
}

/** Which tier's Showroom the Garage draws. A QA override wins (entitlements DEV_KEY via getDevTier);
 *  otherwise the member's real tier when entitlements are enforced, and the TOP view while they are
 *  not — ENTITLEMENTS_ENFORCED is false today, so every gate answers "unlocked" and every tester owns
 *  every car. Re-read it through useEntitlementVersion(): the override hydrates asynchronously. */
export function garageViewTier(): GarageTier {
  const dev = getDevTier();
  if (dev) return garageTierOf(dev);
  return ENTITLEMENTS_ENFORCED ? garageTierOf(getTier()) : "ultra";
}

/** Gold monthly cannot add Ultra — Gold + Ultra is ONE yearly plan (pricing.ts header). The tier value
 *  carries no billing period yet, so this assumes yearly.
 *  TODO(build 80): read the period from the RevenueCat entitlement and return false for Gold monthly. */
export function goldIsYearly(): boolean {
  return true;
}

// ── Cars ────────────────────────────────────────────────────────────────────────────────────────────
export type CarKind = "arrow" | "arrow3d" | "class" | "class3d" | "scan";

export type GarageCar = {
  /** 'arrow' | 'arrow3d' | 'class' | 'class3d' | 'scan:<scanId>' */
  id: string;
  kind: CarKind;
  scanId?: string;
  /** Scans only: the pipeline is still rendering it — shown with the clock, not drivable yet. */
  building?: boolean;
  /** Scans only: ISO time the scan was created (server) or submitted (this phone). */
  createdAt?: string | null;
};

/** What each view owns before scans. Each rung includes everything below it (pricing.ts ladder), and the
 *  stage runs in RUNG ORDER — Free's car, then Silver's, then Gold's two — so swiping right climbs the ladder
 *  (Jeff, 2026-09-22: "move [the 3D arrow] to slot 3 (gold) and the … class car … in 2nd slot (silver) then
 *  this makes sense"): the 2D arrow · the 2D class car · the 3D arrow · the 3D car of your class. */
const BASE_CARS: Record<GarageTier, CarKind[]> = {
  free: ["arrow"],
  silver: ["arrow", "class"],
  gold: ["arrow", "class", "arrow3d", "class3d"],
  ultra: ["arrow", "class", "arrow3d", "class3d"],
};

export const scanCarId = (scanId: string): string => `scan:${scanId}`;

/** Worker states that are finished one way or another. 'unknown' = a slot with no job row; it only
 *  counts as building when it is the scan this phone just submitted. */
const SETTLED = new Set(["done", "failed", "skipped", "unknown"]);

function isComplete(id: string, s: Settings, g: GarageState): boolean {
  return g.completeScanIds.includes(id)
    // The live pointer passed checkScanReady (both GLBs) when it was set to 'ready'.
    || (s.carScanId === id && s.carScanStatus === "ready" && !!s.carScanMapUrl);
}

/** Every scan the member owns, oldest first (the newest sits next to "+ Scan a car"). Complete scans
 *  are drivable; building ones show the clock; failed / skipped ones are not cars and are left out. */
export function scanCars(s: Settings, g: GarageState): GarageCar[] {
  const out: GarageCar[] = [];
  const seen = new Set<string>();
  const listed = [...g.scans].sort((a, b) => (a.createdAt ?? "").localeCompare(b.createdAt ?? ""));
  for (const sc of listed) {
    const pending = s.carScanStatus === "submitted" && s.carScanId === sc.scanId;
    if (isComplete(sc.scanId, s, g)) {
      out.push({ id: scanCarId(sc.scanId), kind: "scan", scanId: sc.scanId, createdAt: sc.createdAt });
    } else if (pending || !SETTLED.has(sc.status)) {
      out.push({
        id: scanCarId(sc.scanId), kind: "scan", scanId: sc.scanId, building: true,
        createdAt: sc.createdAt ?? (pending ? s.carScanSubmittedAt : null),
      });
    } else {
      continue;
    }
    seen.add(sc.scanId);
  }
  // Complete scans this phone has proven that the list does not carry — the scans hand-delivered before
  // server-issued slots (2026-09-02) have no user_id in car_scan_jobs, so /scan/mine may never list them
  // (server.py my_scans ownership rule). Once a car is in this garage it stays in it.
  const unlisted = g.completeScanIds.filter((cid) => !seen.has(cid));
  for (const cid of unlisted) {
    out.unshift({ id: scanCarId(cid), kind: "scan", scanId: cid, createdAt: null });
    seen.add(cid);
  }
  // The phone's own pointer when the server list does not have it yet (offline, a 503, first launch).
  const id = s.carScanId;
  if (id && !seen.has(id)) {
    if (isComplete(id, s, g)) {
      out.push({ id: scanCarId(id), kind: "scan", scanId: id, createdAt: s.carScanSubmittedAt ?? null });
    } else if (s.carScanStatus === "submitted") {
      out.push({ id: scanCarId(id), kind: "scan", scanId: id, building: true, createdAt: s.carScanSubmittedAt ?? null });
    }
  }
  return out;
}

/** The cars this view owns, in Showroom order. Scans are the Ultra garage, so only Ultra lists them. */
export function ownedCars(tier: GarageTier, s: Settings, g: GarageState): GarageCar[] {
  const base: GarageCar[] = BASE_CARS[tier].map((kind) => ({ id: kind, kind }));
  return tier === "ultra" ? [...base, ...scanCars(s, g)] : base;
}

/** Today's car, derived from exactly what the phone map draws (ConvoyMapbox self marker) — so the
 *  Garage can never claim a car the map is not showing. The one thing the map cannot say is WHICH arrow;
 *  the store remembers that. */
export function activeCarId(s: Settings, g: GarageState): string {
  const m = getSelfMarkerType(s);
  if (m === "arrow") return g.arrowPick === "arrow3d" ? "arrow3d" : "arrow";
  if (m === "class") return "class";
  // 'car' — and the parked 'photo', which every surface draws as the car.
  if (s.carScanStatus === "ready" && s.carScanId && s.carScanMapUrl) return scanCarId(s.carScanId);
  return "class3d";
}

// ── Identity (Year / Make / Model / Color) ──────────────────────────────────────────────────────────
// Settings hold today's car only. Peers and /users/nearby read the backend profile copy, which is why
// every write is mirrored (the old garage save(), unchanged): a peer's car used to revert to the default
// paint the moment they moved because the backend never knew it.
export const identityOfSettings = (s: Settings): CarIdentity => ({
  year: s.carYear, make: s.carMake, model: s.carModel, color: s.carColor,
});

/** Which cars carry an identity (the fields the old screen showed in 3D mode only). */
export const carHasIdentity = (car: Pick<GarageCar, "kind">): boolean =>
  car.kind === "class3d" || car.kind === "scan";

/** The identity to show for a car. The 3D class car's is its class choice (class3dIdentity). Otherwise today's
 *  car reads settings and any other its remembered copy; a scan with nothing remembered shows none — another
 *  car's make and model on it would be a lie. */
export function identityFor(carId: string, s: Settings, g: GarageState): CarIdentity {
  if (carId === "class3d") return class3dIdentity(s, g);
  if (carId === activeCarId(s, g)) return identityOfSettings(s);
  return g.identity[carId] ?? {};
}

// ── The 3D class car (Gold's 4th spot) ──────────────────────────────────────────────────────────────
// Jeff, 2026-09-23: "the exotic 3d class needs to have the exotic 3d car spinning not the 3d scanned car. and in
// that section in customize it should have the 3d class car picker with colour options" · "only add the hot
// hatch/exotic/supercar model for now ill 3d scan each class when i get a chance but put the classes in there for
// now". Until then this spot drew the stock GR Corolla for every class.
//
// Three classes have a real model today — src/classModels.ts CLASS_MODEL_3D, and only its rows WITH a modelKey
// (each one an authored per-colour GLB). Muscle's row is a generated tint-base model (64,831 verts in one
// primitive) that was never proven on the map, so it is listed with the rest as "Coming soon".
export type Class3dKey = "hatchback" | "supercar" | "exotic";

/** The 3D classes with a model, in picker order, and the car each one IS — the make/model the backend profile
 *  (peers' label) and the Garage carry for it. */
export const CLASS_3D_CARS: Record<Class3dKey, { make: string; model: string }> = {
  hatchback: { make: "Toyota", model: "GR Corolla" },
  supercar: { make: "Porsche", model: "911 GT3 RS" },
  exotic: { make: "Lexus", model: "LFA" },
};
export const CLASS_3D_KEYS: Class3dKey[] = ["hatchback", "supercar", "exotic"];
/** Listed in the 3D class picker, never selectable, until Jeff scans them. */
export const CLASS_3D_SOON: VehicleClass[] = ["muscle", "sedan", "truck", "electric", "jeep"];

export const isClass3dKey = (cls: unknown): cls is Class3dKey =>
  typeof cls === "string" && (CLASS_3D_KEYS as string[]).includes(cls);

export type Class3dBake = ClassPaletteEntry & { modelKey: GRCColorKey };

/** A 3D class's colours: its REAL bakes only (palette rows with a modelKey) — never a hex-only swatch, which
 *  has no GLB and would put the default bake on the map under another colour's name. */
export function class3dPalette(cls: Class3dKey): Class3dBake[] {
  return (CLASS_MODEL_3D[cls]?.palette ?? []).filter((e): e is Class3dBake => !!e.modelKey);
}

export type Class3dChoice = {
  cls: Class3dKey;
  modelKey: GRCColorKey;
  /** The bake's real paint name ("Pearl Blue") and swatch hex. */
  paint: string;
  hex: string;
  make: string;
  model: string;
};

const choiceOf = (cls: Class3dKey, e: Class3dBake): Class3dChoice =>
  ({ cls, modelKey: e.modelKey, paint: e.name, hex: e.hex, ...CLASS_3D_CARS[cls] });

/** No choice stored: the member's Silver class when it is one of the three (else Hot Hatch), in today's colour
 *  when that colour is one of the class's bakes (else the class's first bake). */
export function defaultClass3d(s: Settings): Class3dChoice {
  const c = getVehicleClass(s);
  const cls: Class3dKey = isClass3dKey(c) ? c : "hatchback";
  const pal = class3dPalette(cls);
  const key = resolveGRCKey(s.carColor);
  return choiceOf(cls, pal.find((e) => e.modelKey === key) ?? pal[0]);
}

/** The member's 3D class car: the stored pick when it is still a selectable class and one of its bakes, else the
 *  default. Everything that draws, names or drives the 3D class car reads this. */
export function class3dChoice(s: Settings, g: GarageState): Class3dChoice {
  const p = g.class3dPick;
  if (p && isClass3dKey(p.cls)) {
    const e = class3dPalette(p.cls).find((x) => x.modelKey === p.modelKey);
    if (e) return choiceOf(p.cls, e);
  }
  return defaultClass3d(s);
}

/** The colour the 3D class car writes as carColor: the bake's real paint name ("Pearl Blue") — what a person reads
 *  on the profile (Club member list, carImages) — whenever the map resolves that name to exactly this bake
 *  (resolveGRCKey; every bake of the three classes does today, garage_cars_test P31), else the bake key itself. */
export function class3dColor(c: Pick<Class3dChoice, "modelKey" | "paint">): string {
  return resolveGRCKey(c.paint) === c.modelKey ? c.paint : c.modelKey;
}

/** The identity the 3D class car carries: its class's make and model and the bake's colour (class3dColor). No
 *  year — the class car never changes carYear, so the member's own year stays where it is. */
export function class3dIdentity(s: Settings, g: GarageState): CarIdentity {
  const c = class3dChoice(s, g);
  return { make: c.make, model: c.model, color: class3dColor(c) };
}

/** What putting the 3D class car on the road writes to settings (and the profile): make, model, colour — never
 *  the year. */
function class3dPatch(c: Class3dChoice): { carMake: string; carModel: string; carColor: string } {
  return { carMake: c.make, carModel: c.model, carColor: class3dColor(c) };
}

/** Settings hold a 3D class car's identity: one of the three classes' make/model, in one of that class's bakes. */
function settingsCarryClass3d(s: Settings): boolean {
  const key = resolveGRCKey(s.carColor);
  return CLASS_3D_KEYS.some((cls) => s.carMake === CLASS_3D_CARS[cls].make && s.carModel === CLASS_3D_CARS[cls].model
    && class3dPalette(cls).some((e) => e.modelKey === key));
}

/** The member's own identity to keep aside while the class car's is in settings (garageStore ownIdentity): the one
 *  already kept when settings still hold the class car's, else what settings hold now — the member's own. */
function ownToKeep(s: Settings, g: GarageState): CarIdentity {
  return g.ownIdentity && settingsCarryClass3d(s) ? g.ownIdentity : identityOfSettings(s);
}

/** The member's OWN car — what a new scan is filed under (garage-capture's manifest and its factory-paint row): the
 *  identity set aside while the 3D class car is on the road, else today's settings. Never the class car's. */
export function ownCarIdentity(s: Settings, g: GarageState): CarIdentity {
  return g.ownIdentity ?? identityOfSettings(s);
}

/** True when the map is drawing exactly the member's 3D class car: the stock 3D car is today's car AND its
 *  colour resolves to the chosen bake (the map loads getVehicleMapModelUrl(carColor) — ConvoyMapbox). False for
 *  an install whose 3D car is still the colour it had before the choice existed: the Garage shows the choice
 *  there, so it must offer "Drive this today" rather than claim it is on the road. */
export function class3dOnMap(s: Settings, g: GarageState): boolean {
  return activeCarId(s, g) === "class3d" && getVehicleModelKey(s.carColor) === class3dChoice(s, g).modelKey;
}

/** Store the 3D class choice (Customize). A class with no model yet, or a colour that is not one of that class's
 *  bakes, is refused and nothing is written. */
export async function setClass3dPick(cls: string, modelKey: string): Promise<boolean> {
  if (!isClass3dKey(cls) || !class3dPalette(cls).some((e) => e.modelKey === modelKey)) return false;
  await updateGarage({ class3dPick: { cls, modelKey } });
  return true;
}

/** With no choice stored, the 3D spot follows the Silver class — so an install already driving the 3D car in a
 *  bake of the default would see the spot move off the car the map draws the moment the class changed. Pin the
 *  default while it IS what the map draws: before Customize writes a new vehicleClass, and on Garage focus. */
export async function pinClass3dIfOnMap(): Promise<void> {
  await ensureGarageLoaded();
  const s = getSettings();
  const g = getGarage();
  if (g.class3dPick || !class3dOnMap(s, g)) return;
  const c = class3dChoice(s, g);
  await updateGarage({ class3dPick: { cls: c.cls, modelKey: c.modelKey } });
}

/** Customize saved a 3D class choice while the 3D class car is ON the road (class3dOnMap was true when the sheet
 *  opened — the caller's isToday): put the new choice on the map. Writes only when the map draws another bake, so
 *  a save that changed nothing leaves settings alone; keeps the member's own identity aside first. Returns true when
 *  it wrote. The caller's PUT /auth/profile (the whole identity, from settings) carries it to peers. */
export async function applyClass3dToday(): Promise<boolean> {
  await ensureGarageLoaded();
  const s = getSettings();
  const g = getGarage();
  if (activeCarId(s, g) !== "class3d") return false;
  const c = class3dChoice(s, g);
  if (getVehicleModelKey(s.carColor) === c.modelKey) return false;
  await updateGarage({ ownIdentity: ownToKeep(s, g) });
  await updateSettings(class3dPatch(c));
  try { logEvent(`garage-class3d cls=${c.cls} key=${c.modelKey}`); } catch {}
  return true;
}

/** The backend half of the old garage save() — unchanged: year parsed to an int and skipped if NaN. */
export function mirrorIdentityToProfile(updates: Partial<Pick<Settings, "carYear" | "carMake" | "carModel" | "carColor">>) {
  const profile: Record<string, any> = {};
  if ("carMake" in updates) profile.car_make = updates.carMake;
  if ("carModel" in updates) profile.car_model = updates.carModel;
  if ("carColor" in updates) profile.car_color = updates.carColor;
  if ("carYear" in updates) { const y = parseInt(String(updates.carYear ?? ""), 10); if (y) profile.car_year = y; }
  if (Object.keys(profile).length > 0) {
    api.put("/auth/profile", profile).catch(() => {});
  }
}

/** The old garage save(): local settings AND the backend profile, so peers see the same car. */
export function saveIdentity(updates: Partial<Pick<Settings, "carYear" | "carMake" | "carModel" | "carColor">>) {
  void updateSettings(updates);
  mirrorIdentityToProfile(updates);
}

function identityPatch(id: CarIdentity): Pick<Settings, "carYear" | "carMake" | "carModel" | "carColor"> {
  return { carYear: id.year, carMake: id.make, carModel: id.model, carColor: id.color };
}

// ── The switch ──────────────────────────────────────────────────────────────────────────────────────
/** The rest of the old applyMarkerType, after the settings write: the profile's avatar_type (the
 *  backend ignores the field today — CarUpdate has no avatar_type — kept exactly as it was) and the
 *  skin that follows the pick. setSkinChoice clamps to what the account is entitled to. */
function afterMarkerWrite(type: MarkerType, scan: boolean) {
  api.put("/auth/profile", { avatar_type: type }).catch(() => {});
  const metal = scan ? SKIN_FOR_SCAN : SKIN_FOR_MARKER[type];
  if (metal) void setSkinChoice(metal);
}

const add = (xs: string[], x: string) => (xs.includes(x) ? xs : [...xs, x]);

export type DriveResult = "ok" | "same" | "not-ready";

/** "Drive this today". Writes the minimum each surface reads (see the header) in ONE settings update,
 *  so the phone map, CarPlay/AA and presence switch in the same notify — never a frame of a half-switched
 *  car in between. */
export async function driveToday(car: GarageCar): Promise<DriveResult> {
  await ensureGarageLoaded();
  const s = getSettings();
  const g = getGarage();
  const outgoing = activeCarId(s, g);
  // Already today's car — unless it is a non-scan car with a scan still 'ready' underneath (a state the
  // old Garage could leave: the phone drew the arrow, peers the scan). Driving it again repairs that. The 3D
  // class car is only "the same" when the map draws the member's chosen bake (class3dOnMap).
  const strayScan = car.kind !== "scan" && s.carScanStatus === "ready";
  const staleClass3d = car.kind === "class3d" && !class3dOnMap(s, g);
  if (car.id === outgoing && !strayScan && !staleClass3d) return "same";
  const now = new Date().toISOString();
  // Leaving a SCAN: remember its identity, so coming back puts it back. The 3D class car's identity is not
  // remembered — it is its class choice, derived every time (class3dIdentity).
  const leaving: Record<string, CarIdentity> = outgoing.startsWith("scan:")
    ? { [outgoing]: identityOfSettings(s) }
    : {};
  // The 3D class car's identity is its class choice — the class's make/model and the bake's colour — so the map,
  // CarPlay/AA and peers load that exact car (Jeff, 2026-09-23). The member's OWN identity is kept aside first
  // (garageStore ownIdentity) and goes back the moment the class car leaves the road: to the arrow or the class car
  // as it is, to a scan when that scan has none of its own.
  const pick3d = car.kind === "class3d" ? class3dChoice(s, g) : undefined;
  // (Only while settings still hold the class car's identity — a copy they no longer match is stale, and is
  // dropped rather than written over whatever is there now.)
  const ownBack = !pick3d && g.ownIdentity && settingsCarryClass3d(s) ? ownIdentityBack(g.ownIdentity) : undefined;
  const remembered = car.kind === "scan" ? g.identity[car.id] : undefined;
  const incoming: Partial<Pick<Settings, "carYear" | "carMake" | "carModel" | "carColor">> | undefined = pick3d
    ? class3dPatch(pick3d)
    : remembered ? identityPatch(remembered) : ownBack?.settings;
  // Kept aside BEFORE the class car's identity overwrites it, so no crash between two writes can lose it.
  if (pick3d) await updateGarage({ ownIdentity: ownToKeep(s, g) });
  // Today's car when it is a scan the map is drawing (both GLBs checked when it became 'ready').
  const outgoingScan = s.carScanStatus === "ready" && s.carScanMapUrl ? s.carScanId : undefined;

  if (car.kind === "scan") {
    const id = car.scanId;
    if (!id || car.building) return "not-ready";
    // Both GLBs must exist — a 404'd model is an INVISIBLE car on every surface (<Models> has no error
    // path). A scan proven complete once stays complete (insert-only bucket), so no HEAD for those.
    const urls = g.completeScanIds.includes(id)
      ? { heroUrl: scanHeroUrl(id), mapUrl: scanMapUrl(id) }
      : await checkScanReady(id);
    if (!urls) return "not-ready";
    await updateSettings({
      selfMarkerType: "car",
      carScanId: id,
      carScanModelUrl: urls.heroUrl,
      carScanMapUrl: urls.mapUrl,
      carScanStatus: "ready",
      // A different scan: clear the synced id so map.tsx's sync effect PUTs car_scan_id once (roster /
      // Crew tiles) — the same trick reconcileScanState uses after a restore.
      ...(s.carScanId === id ? {} : { carScanBackendId: undefined }),
      ...(incoming ?? {}),
    });
    await updateGarage((cur) => ({
      scanParked: false,
      chosenAt: now,
      profileClearPending: false,   // a scan is on the road again — map.tsx re-sends its id
      identity: { ...cur.identity, ...leaving },
      ownIdentity: undefined,       // the class car (if it was on the road) is not any more
      // The OUTGOING scan stays in the Garage even when /scan/mine never lists it (the hand-delivered
      // scans before server slots have no user_id) — once the pointer moves, this list is all that
      // remembers it (Codex review 2026-09-22).
      completeScanIds: add(outgoingScan ? add(cur.completeScanIds, outgoingScan) : cur.completeScanIds, id),
    }));
  } else {
    const marker: MarkerType = car.kind === "class" ? "class" : car.kind === "class3d" ? "car" : "arrow";
    // PARK a ready scan (see the header). A scan still BUILDING keeps its pointer — it lands parked
    // when it finishes, because this pick is newer than it (deliverSubmittedScan).
    const parkId = s.carScanStatus === "ready" ? s.carScanId : undefined;
    // Remembered as COMPLETE (no HEAD next time it is driven) only when its map twin is known — the same
    // guard as outgoingScan above. A ready scan with no carScanMapUrl is the pre-fix latch the Garage's
    // HEAL exists for; it is re-checked by checkScanReady when driven again (review 2026-09-22).
    const parkComplete = parkId && s.carScanMapUrl ? parkId : undefined;
    await updateSettings({
      selfMarkerType: marker,
      // Parked: also forget which id the backend profile has, so driving the scan again re-sends it
      // (map.tsx's sync effect PUTs car_scan_id whenever a ready scan's id differs from this).
      ...(s.carScanStatus === "ready" ? { carScanStatus: "none" as const, carScanBackendId: undefined } : {}),
      ...(incoming ?? {}),
    });
    // …and clear it on the profile, so the Crew / friend tiles stop showing the parked scan's hero shot
    // (map.tsx falls back to the roster's car_scan_id whenever presence carries no scanId).
    if (parkId) void clearProfileScan();
    const ownsScan = !!s.carScanId || g.completeScanIds.length > 0;
    await updateGarage((cur) => ({
      chosenAt: now,
      scanParked: ownsScan ? true : cur.scanParked,
      arrowPick: car.kind === "arrow" || car.kind === "arrow3d" ? car.kind : cur.arrowPick,
      identity: { ...cur.identity, ...leaving },
      completeScanIds: parkComplete ? add(cur.completeScanIds, parkComplete) : cur.completeScanIds,
      // The car now on the road is pinned as the choice, so a later change of Silver class cannot silently
      // re-point the 3D spot away from what the map draws.
      class3dPick: pick3d ? { cls: pick3d.cls, modelKey: pick3d.modelKey } : cur.class3dPick,
      // Set aside above while the class car is on the road; given back (incoming) when anything else is.
      ownIdentity: pick3d ? cur.ownIdentity : undefined,
    }));
  }
  if (ownBack && !remembered) {
    // The member's own car goes back on the profile — EMPTY fields too, so the class car's make/model/paint
    // never outlive it there (garageStore ownIdentityBack).
    api.put("/auth/profile", ownBack.profile).catch(() => {});
  } else if (incoming) {
    mirrorIdentityToProfile(incoming);
  }
  const markerNow: MarkerType = car.kind === "class" ? "class" : car.kind === "arrow" || car.kind === "arrow3d" ? "arrow" : "car";
  afterMarkerWrite(markerNow, car.kind === "scan");
  try { logEventReliable(`garage-drive car=${car.id} from=${outgoing} parked=${getGarage().scanParked ? 1 : 0}`); } catch {}
  return "ok";
}

// ── The inventory ───────────────────────────────────────────────────────────────────────────────────
let listBusy: { owner: string | undefined; p: Promise<void>; token: object } | null = null;

/** GET /scan/mine → the store. Done scans are HEAD-checked once (both GLBs) and remembered as complete.
 *  Offline / 503 keeps the last good list — the Garage never empties itself because the server blinked. */
export function refreshScanList(): Promise<void> {
  // One request per ACCOUNT at a time: a previous account's request still in flight is not this one's
  // answer (it is discarded on arrival), so it must not stand in for it (Codex review 2026-09-22).
  if (listBusy && listBusy.owner === getGarage().ownerId) return listBusy.p;
  const owner = getGarage().ownerId;
  const token = {};
  const run = (async () => {
    const t0 = Date.now();
    await ensureGarageLoaded();
    try {
      const r = await api.get("/scan/mine", { validateStatus: () => true });
      const raw = r?.data?.scans;
      if (r.status !== 200 || !Array.isArray(raw)) {
        try { logEvent(`garage-scans ok=0 http=${r.status} ms=${Date.now() - t0}`); } catch {}
        return;
      }
      const scans: GarageScan[] = raw
        .filter((x: any) => x && typeof x.scanId === "string" && x.scanId && typeof x.status === "string")
        .map((x: any) => ({ scanId: x.scanId, status: x.status, createdAt: typeof x.createdAt === "string" ? x.createdAt : null }));
      const known = new Set(getGarage().completeScanIds);
      const fresh: string[] = [];
      for (const sc of scans) {
        if (sc.status !== "done" || known.has(sc.scanId)) continue;
        if (await checkScanReady(sc.scanId)) fresh.push(sc.scanId);
      }
      // Another account signed in while this was in flight: the answer is not this garage's.
      if (getGarage().ownerId !== owner) return;
      await updateGarage((cur) => ({
        scans,
        completeScanIds: fresh.reduce(add, cur.completeScanIds),
      }));
      try { logEvent(`garage-scans n=${scans.length} verified=${fresh.length} ms=${Date.now() - t0}`); } catch {}
    } catch (e: any) {
      try { logEvent(`garage-scans ok=0 err=${String(e?.message ?? e).slice(0, 80)}`); } catch {}
    } finally {
      if (listBusy?.token === token) listBusy = null;
    }
  })();
  listBusy = { owner, p: run, token };
  return run;
}

/** HEAD-poll scans the Garage shows as building (other than the one this phone submitted, which the
 *  return leg handles). Returns the ids that finished. Cheap: a HEAD against the public bucket, and a
 *  miss is never CDN-cached (the old return-leg note). */
export async function checkBuildingScans(ids: string[]): Promise<string[]> {
  await ensureGarageLoaded();
  const owner = getGarage().ownerId;
  const done: string[] = [];
  for (const id of ids) {
    if (await checkScanReady(id)) done.push(id);
  }
  // Another account claimed the garage while the checks ran: these are not its cars.
  if (getGarage().ownerId !== owner) return [];
  if (done.length) {
    await updateGarage((cur) => ({
      completeScanIds: done.reduce(add, cur.completeScanIds),
      scans: cur.scans.map((sc) => (done.includes(sc.scanId) ? { ...sc, status: "done" } : sc)),
    }));
  }
  return done;
}

/** HEAL a state the old Garage could leave: the ARROW was picked while a scan stayed 'ready' — the phone
 *  and CarPlay/AA drew the arrow, but peers (presence scanId) still drew the scan. Park the scan exactly
 *  as "Drive this today" would, so every surface shows the arrow the member picked. Runs on Garage focus
 *  only (never at launch), so it happens where the member can see the result.
 *  The CLASS car is deliberately left alone: CarPlay/AA cannot draw a class car (CarMapView isArrow /
 *  carHasScan — locked), so parking would silently swap the scan for the stock GR Corolla there. A class
 *  driver parks the scan only by choosing to ("Drive this today"). */
export async function parkStrayScan(): Promise<boolean> {
  await ensureGarageLoaded();
  const s = getSettings();
  const m = getSelfMarkerType(s);
  const id = s.carScanId;
  if (s.carScanStatus !== "ready" || !id || m !== "arrow") return false;
  await updateSettings({ carScanStatus: "none", carScanBackendId: undefined });
  void clearProfileScan();
  await updateGarage((cur) => ({
    scanParked: true,
    completeScanIds: s.carScanMapUrl ? add(cur.completeScanIds, id) : cur.completeScanIds,
  }));
  try { logEventReliable(`garage-heal parked=${id} marker=${m}`); } catch {}
  return true;
}

/** Ask the backend profile to forget car_scan_id (a park). PUT /auth/profile keeps "" (it drops only None)
 *  and every reader maps it back to None (convoy-backend server.py update_profile + `u.get("car_scan_id")
 *  or None`) — read from the backend code 2026-09-22, not run against it. DURABLE: marked pending until the
 *  response shows the id gone, and retried on every Garage focus (retryProfileClear) — a park made offline
 *  must not leave the parked scan on the Crew / friend tiles forever (Codex review 2026-09-22). */
let clearGen = 0;
async function clearProfileScan(): Promise<void> {
  await ensureGarageLoaded();
  const owner = getGarage().ownerId;
  const gen = ++clearGen;
  await updateGarage({ profileClearPending: true });
  // Behind any car_scan_id "set" already on its way (carScan.syncScanIdToBackend), so an older set can
  // never land after this clear.
  await scanSyncSettled();
  // Still this account's latest clear? The PUT goes out with whoever is signed in NOW — after an account
  // change it would erase the NEW account's car_scan_id (Codex review 2026-09-22, pass 4).
  if (gen !== clearGen || getGarage().ownerId !== owner) return;
  let acked = false;
  try {
    const r = await api.put("/auth/profile", { car_scan_id: "" });
    const d: any = r?.data;
    acked = !!(d && typeof d === "object" && !d.car_scan_id);
  } catch {}
  // Only the LATEST clear of the SAME account may settle anything (Codex review 2026-09-22: an older
  // clear's answer, or another account's, used to acknowledge a newer pending one).
  if (gen !== clearGen || getGarage().ownerId !== owner) return;
  if (acked) await updateGarage({ profileClearPending: false });
  // Ordering: a scan went back on the road while this was in flight — the clear may have landed AFTER
  // map.tsx sent that scan's id, so forget the synced id and let map.tsx send it again.
  if (getSettings().carScanStatus === "ready") {
    await updateSettings({ carScanBackendId: undefined });
    await updateGarage({ profileClearPending: false });
  }
}

/** Retry a park's profile clear that has not been acknowledged yet (Garage focus). */
export async function retryProfileClear(): Promise<void> {
  await ensureGarageLoaded();
  if (getGarage().profileClearPending && getSettings().carScanStatus !== "ready") await clearProfileScan();
}

/** Today's scan (ready, both GLBs) is always in the Garage's own list — before the pointer can move
 *  (a new capture overwrites carScanId) and whether or not /scan/mine lists it. */
export async function adoptActiveScan(): Promise<void> {
  await ensureGarageLoaded();
  const s = getSettings();
  const id = s.carScanStatus === "ready" && s.carScanMapUrl ? s.carScanId : undefined;
  if (id && !getGarage().completeScanIds.includes(id)) {
    await updateGarage((cur) => ({ completeScanIds: add(cur.completeScanIds, id) }));
  }
}

/** Bind the garage to the signed-in account. Settings belong to the PHONE and logout does not clear
 *  them (src/auth.tsx logout), so when a DIFFERENT account claims this garage the previous account's
 *  scan pointer is dropped too — otherwise the new account would drive, broadcast and list the last
 *  one's car (Codex review 2026-09-22). reconcileScanState then restores the new account's own newest
 *  finished scan, if it has one. */
export async function claimGarageFor(userId: string): Promise<void> {
  const how = await claimGarage(userId);
  if (how !== "reset") return;
  await updateSettings({
    carScanId: undefined, carScanModelUrl: undefined, carScanMapUrl: undefined, carScanStatus: undefined,
    carScanBackendId: undefined, carScanHeroShotId: undefined, carScanSubmittedAt: undefined,
  });
  try { logEventReliable("garage-owner-changed scan-pointer=cleared"); } catch {}
}

// ── Nicknames ───────────────────────────────────────────────────────────────────────────────────────
export async function setNickname(carId: string, name: string) {
  const v = name.trim();
  await updateGarage((cur) => {
    const next = { ...cur.nicknames };
    if (v) next[carId] = v; else delete next[carId];
    return { nicknames: next };
  });
}

/** Remember a car's identity while it is NOT today's car (today's car writes settings via saveIdentity). */
export async function rememberIdentity(carId: string, id: CarIdentity) {
  await updateGarage((cur) => ({ identity: { ...cur.identity, [carId]: id } }));
}
