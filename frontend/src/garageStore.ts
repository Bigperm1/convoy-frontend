// garageStore.ts — the Garage's OWN persisted state (the Showroom, 2026-09-22).
//
// Jeff, 2026-09-22: "go build the new garage..." — the Showroom holds every car a member owns
// (arrow, 3D arrow, class car, 3D class car, every scan). Switching cars ("Drive this today") writes
// the EXISTING settings fields — the map, CarPlay/Android Auto and presence already read those
// (map.tsx selfMarkerType/selfScanModelUrl, carStore.ts mirrorSettingsToCar, map.tsx presence scanId),
// so a switch needs no edit to any of them. See src/garageCars.ts.
//
// This file holds only what NOTHING outside the Garage needs to read — under its own AsyncStorage key,
// never a new field in src/settings.ts (🔒 nav-locked: tools/sim-qc/data/nav-lock.json):
//   • arrowPick     — the 2D and the 3D arrow are ONE map state (selfMarkerType 'arrow'); this says
//                     which of the two the member picked, so the Showroom can say which is today's car.
//   • scanParked    — the member drove a non-scan car while a finished scan existed, so the scan was
//                     taken out of 'ready'. carScan.reconcileScanState reads this and does NOT "restore"
//                     the scan behind their back (it restores a finished scan whenever status != 'ready').
//   • chosenAt      — when the member last picked a car. A scan that finishes building after a newer
//                     pick lands PARKED instead of taking over (carScan.deliverSubmittedScan).
//   • nicknames / identity — per car. Settings hold the identity (Year/Make/Model/Color) of TODAY's car
//                     only; the others' are remembered here and put back when that car is driven again.
//   • scans / completeScanIds — the last GET /scan/mine answer (instant first paint, offline) and the
//                     scans proven complete (both GLBs published; the bucket is insert-only, so once
//                     complete, always complete — no need to HEAD them again).
//   • ownerId       — the account this garage belongs to (claimGarage); every async write checks it.
//   • profileClearPending — a park's "forget car_scan_id" PUT that has not been acknowledged yet.
//
// ⛔ NO LOCAL RUNTIME IMPORTS IN THIS FILE (the tierTheme.ts rule; an `import type` is erased and fine):
// carScan.ts imports it and garageCars.ts imports carScan — a cycle would hand one side `undefined` at
// load time.

import { useEffect, useState } from "react";
import AsyncStorage from "@react-native-async-storage/async-storage";
import type { VisualTier } from "./tierTheme";   // type-only: erased at build time, so no runtime import

export type MarkerType = "car" | "arrow" | "photo" | "class";

/** Appearance -> metal. Moved unchanged from app/(app)/garage.tsx (Jeff, 2026-08-27: picking the arrow,
 *  the class or the 3D car "should also change the skin"). 'photo' is absent on purpose — it is not one
 *  of the tiered appearances, so choosing it leaves the metal alone. Lives HERE (not garageCars.ts) so
 *  carScan.ts can land a finished scan through the same rule without an import cycle. */
export const SKIN_FOR_MARKER: Partial<Record<MarkerType, VisualTier>> = {
  arrow: "brand", class: "premium", car: "ultra",
};
/** A SCANNED car is a "car" marker too, but it is Ultra's — it wears Diamond (2026-09-22: "the diamond
 *  is only for ultra"). The stock 3D car keeps SKIN_FOR_MARKER.car (gold). */
export const SKIN_FOR_SCAN: VisualTier = "diamond";

export type GarageScan = {
  scanId: string;
  /** car_scan_jobs.status as GET /scan/mine reports it: done · failed · skipped · unknown · or an
   *  in-progress worker state (queued · generating · fetching · converting_map). */
  status: string;
  createdAt?: string | null;
};

export type CarIdentity = { year?: string; make?: string; model?: string; color?: string };

export type GarageState = {
  /** The account this garage belongs to. Settings are per DEVICE, but a garage is per ACCOUNT — a second
   *  account signing in on this phone must never see the first one's scans (claimGarage). */
  ownerId?: string;
  arrowPick?: "arrow" | "arrow3d";
  scanParked?: boolean;
  chosenAt?: string;
  nicknames: Record<string, string>;
  identity: Record<string, CarIdentity>;
  scans: GarageScan[];
  completeScanIds: string[];
  /** A park asked the backend profile to forget car_scan_id and has not had it acknowledged yet (offline,
   *  cold Render) — retried on Garage focus until it is (garageCars.retryProfileClear). */
  profileClearPending?: boolean;
};

const KEY = "convoy.garage.v1";
const EMPTY: GarageState = { nicknames: {}, identity: {}, scans: [], completeScanIds: [] };

let state: GarageState = EMPTY;
let loaded = false;
const listeners = new Set<(s: GarageState) => void>();

function emit() {
  // One bad listener must never stop the rest (same guard as appSkin.ts's emit).
  listeners.forEach((l) => { try { l(state); } catch {} });
}

const str = (v: unknown): string | undefined => (typeof v === "string" && v ? v : undefined);

/** Stored JSON is untrusted — an older shape or a hand edit must never crash the Garage. */
function sanitize(p: any): GarageState {
  const obj = (v: unknown) => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, any>) : {});
  const nicknames: Record<string, string> = {};
  for (const [k, v] of Object.entries(obj(p?.nicknames))) if (str(v)) nicknames[k] = v as string;
  const identity: Record<string, CarIdentity> = {};
  for (const [k, v] of Object.entries(obj(p?.identity))) {
    const o = obj(v);
    identity[k] = { year: str(o.year), make: str(o.make), model: str(o.model), color: str(o.color) };
  }
  const scans: GarageScan[] = Array.isArray(p?.scans)
    ? p.scans
        .filter((x: any) => x && str(x.scanId) && typeof x.status === "string")
        .map((x: any) => ({ scanId: x.scanId, status: x.status, createdAt: str(x.createdAt) ?? null }))
    : [];
  const completeScanIds: string[] = Array.isArray(p?.completeScanIds)
    ? p.completeScanIds.filter((x: unknown) => !!str(x))
    : [];
  return {
    ownerId: str(p?.ownerId),
    arrowPick: p?.arrowPick === "arrow3d" ? "arrow3d" : p?.arrowPick === "arrow" ? "arrow" : undefined,
    scanParked: p?.scanParked === true,
    chosenAt: str(p?.chosenAt),
    nicknames,
    identity,
    scans,
    completeScanIds,
    profileClearPending: p?.profileClearPending === true,
  };
}

const loadPromise: Promise<GarageState> = (async () => {
  try {
    const raw = await AsyncStorage.getItem(KEY);
    if (raw) state = sanitize(JSON.parse(raw));
  } catch {}
  loaded = true;
  emit();
  return state;
})();

/** Resolves once the stored state has been read. Every writer awaits it first, so a write made
 *  in the first milliseconds of a launch can never be overwritten by the load landing after it. */
export function ensureGarageLoaded(): Promise<GarageState> {
  return loaded ? Promise.resolve(state) : loadPromise;
}

export function getGarage(): GarageState {
  return state;
}

/** Merge a patch (or a function of the current state) and persist. Notifies first, persists after —
 *  the same order as settings.ts updateSettings, for the same reason (a slow disk must never make a
 *  tap look dead). */
export async function updateGarage(
  patch: Partial<GarageState> | ((s: GarageState) => Partial<GarageState>),
): Promise<GarageState> {
  await ensureGarageLoaded();
  const p = typeof patch === "function" ? patch(state) : patch;
  state = { ...state, ...p };
  emit();
  AsyncStorage.setItem(KEY, JSON.stringify(state)).catch(() => {});
  return state;
}

/** Bind the garage to the signed-in account. A different account starts from an EMPTY garage — its
 *  scans come from its own GET /scan/mine — instead of inheriting the last account's cars. Returns
 *  'reset' when that happened, so the caller can drop the previous account's scan pointer from settings
 *  too (garageCars.claimGarageFor — settings are per PHONE, and logout does not clear them). */
export async function claimGarage(userId: string): Promise<"same" | "first" | "reset" | "none"> {
  if (!userId) return "none";
  await ensureGarageLoaded();
  if (state.ownerId === userId) return "same";
  if (!state.ownerId) {
    // First claim on this phone: what it already had is this account's (the garage predates the field).
    await updateGarage({ ownerId: userId });
    return "first";
  }
  await updateGarage({
    ownerId: userId, arrowPick: undefined, scanParked: undefined, chosenAt: undefined,
    nicknames: {}, identity: {}, scans: [], completeScanIds: [], profileClearPending: undefined,
  });
  return "reset";
}

export function subscribeGarage(fn: (s: GarageState) => void): () => void {
  listeners.add(fn);
  return () => { listeners.delete(fn); };
}

/** True when the member parked their scan by driving a non-scan car (see the header). Awaits the load,
 *  so carScan.reconcileScanState — which runs at app launch — never reads the default by racing it. */
export async function isScanParked(): Promise<boolean> {
  await ensureGarageLoaded();
  return state.scanParked === true;
}

/** React binding. Re-reads on mount: the state can change between a render and the subscription. */
export function useGarage(): GarageState {
  const [s, setS] = useState<GarageState>(state);
  useEffect(() => {
    let active = true;
    setS(state);
    if (!loaded) void loadPromise.then((v) => { if (active) setS(v); });
    const off = subscribeGarage(setS);
    return () => { active = false; off(); };
  }, []);
  return s;
}
