// Scratch harness (NOT a repo gate): runs the REAL src/garageCars.ts, src/garageStore.ts, src/carScan.ts,
// src/components/showroom/tier.ts and src/components/showroom/labels.ts with the native/network edges
// stubbed (loader.mjs).
import { readFileSync } from "node:fs";
import { register } from "node:module";
register("./garage/loader.mjs", import.meta.url);

const SRC = new URL("../../src/", import.meta.url).href;
// garageCars.ts (the 3D class car, 2026-09-23) and labels.ts reach src/vehicleAssets.ts, whose top-level tables
// require() the car PNGs the Metro way. A Metro asset require is only an id, so a stand-in `require` for the
// length of these imports is enough: every require() in vehicleAssets runs at load, none inside a function.
(globalThis as any).require = () => 0;
const gc: any = await import(SRC + "garageCars.ts");
const gs: any = await import(SRC + "garageStore.ts");
const cs: any = await import(SRC + "carScan.ts");
const tier: any = await import(SRC + "components/showroom/tier.ts");
const labels: any = await import(SRC + "components/showroom/labels.ts");
const va: any = await import(SRC + "vehicleAssets.ts");
const cm: any = await import(SRC + "classModels.ts");
delete (globalThis as any).require;
const settings: any = await import(new URL("./garage/stubs/settings.mjs", import.meta.url).href);
const apiStub: any = await import(new URL("./garage/stubs/api.mjs", import.meta.url).href);
const skinStub: any = await import(new URL("./garage/stubs/appSkin.mjs", import.meta.url).href);
const ent: any = await import(new URL("./garage/stubs/entitlements.mjs", import.meta.url).href);

let fails = 0;
const ok = (name: string, cond: boolean, detail = "") => {
  if (!cond) { fails++; console.log(`  FAIL ${name} ${detail}`); } else console.log(`  ok   ${name}`);
};
const eq = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

const MODELS = "https://pgtbjiszjglznjagolse.supabase.co/storage/v1/object/public/models";
const published = new Set<string>();
const publish = (id: string, map = true) => { published.add(`${MODELS}/scan_${id}.glb`); if (map) published.add(`${MODELS}/scan_${id}_map.glb`); };
(globalThis as any).fetch = async (url: string) => ({ ok: published.has(url) });

async function resetAll(s: Record<string, unknown> = {}, g: Record<string, unknown> = {}) {
  settings.__reset(s);
  await gs.updateGarage({
    ownerId: undefined, arrowPick: undefined, scanParked: undefined, chosenAt: undefined,
    nicknames: {}, identity: {}, scans: [], completeScanIds: [], class3dPick: undefined, ...g,
  });
  apiStub.calls.length = 0;
  skinStub.skins.length = 0;
  for (const k of Object.keys(apiStub.routes.get)) delete apiStub.routes.get[k];
}
const putsTo = (body: string) => apiStub.calls.filter((c: any) => c.m === "PUT" && JSON.stringify(c.body).includes(body));
const carPuts = () => apiStub.calls.filter((c: any) => c.m === "PUT" && c.body && ("car_make" in c.body || "car_model" in c.body || "car_color" in c.body || "car_year" in c.body));
// What the phone map / CarPlay / presence would read, per the (locked) code they run:
//   map.tsx:5068  selfScanModelUrl = status==='ready' ? carScanMapUrl : null
//   carStore.ts   selfScanMapUrl   = status==='ready' && carScanMapUrl
//   map.tsx:4655  presence scanId  = status==='ready' && carScanId
const surfaces = (s: any) => ({
  marker: s.selfMarkerType ?? "car",
  mapScan: s.carScanStatus === "ready" ? (s.carScanMapUrl ?? null) : null,
  peerScanId: s.carScanStatus === "ready" && s.carScanId ? s.carScanId : undefined,
});

console.log("A · which view");
ent.__set(null); ok("A1 no override, not enforced → ultra", gc.garageViewTier() === "ultra");
ent.__set("free"); ok("A2 dev free → free", gc.garageViewTier() === "free");
ent.__set("premium"); ok("A3 dev premium → silver", gc.garageViewTier() === "silver");
ent.__set("gold"); ok("A4 dev gold → gold", gc.garageViewTier() === "gold");
ent.__set("club_founder"); ok("A5 dev club_founder → ultra", gc.garageViewTier() === "ultra");
ent.__set(null);

console.log("B · what each view owns");
await resetAll();
const ids = (t: string) => gc.ownedCars(t, settings.getSettings(), gs.getGarage()).map((c: any) => c.id + (c.building ? "(b)" : ""));
ok("B1 free", eq(ids("free"), ["arrow"]));
ok("B2 silver", eq(ids("silver"), ["arrow", "class"]));
ok("B3 gold — rung order: Free's car, Silver's, then Gold's two (Jeff 2026-09-22)", eq(ids("gold"), ["arrow", "class", "arrow3d", "class3d"]));
ok("B4 ultra, no scans", eq(ids("ultra"), ["arrow", "class", "arrow3d", "class3d"]));
await resetAll({ carScanId: "c", carScanStatus: "submitted", carScanSubmittedAt: "2026-09-22T10:00:00Z" }, {
  scans: [
    { scanId: "b", status: "generating", createdAt: "2026-09-21T00:00:00Z" },
    { scanId: "a", status: "done", createdAt: "2026-09-01T00:00:00Z" },
    { scanId: "f", status: "failed", createdAt: "2026-09-02T00:00:00Z" },
    { scanId: "u", status: "unknown", createdAt: null },
    { scanId: "c", status: "unknown", createdAt: null },
  ],
  completeScanIds: ["a", "legacy"],
});
ok("B5 ultra: done+verified a, building b, the phone's submitted c; failed/unknown out; unlisted legacy kept",
  eq(ids("ultra"), ["arrow", "class", "arrow3d", "class3d", "scan:legacy", "scan:c(b)", "scan:a", "scan:b(b)"]),
  JSON.stringify(ids("ultra")));
ok("B6 gold never lists scans", eq(ids("gold"), ["arrow", "class", "arrow3d", "class3d"]));

console.log("C · today's car = what the phone map draws");
const act = (s: any, g: any = {}) => gc.activeCarId(s, { ...gs.getGarage(), ...g });
await resetAll();
ok("C1 unset marker, no scan → stock 3D", act({}) === "class3d");
ok("C2 ready scan with twin → the scan", act({ carScanStatus: "ready", carScanId: "a", carScanMapUrl: "x" }) === "scan:a");
ok("C3 ready but no twin (map draws stock) → stock 3D", act({ carScanStatus: "ready", carScanId: "a" }) === "class3d");
ok("C4 parked scan → stock 3D", act({ carScanStatus: "none", carScanId: "a", carScanMapUrl: "x" }) === "class3d");
ok("C5 arrow + pick arrow3d → arrow3d", act({ selfMarkerType: "arrow" }, { arrowPick: "arrow3d" }) === "arrow3d");
ok("C6 arrow, no pick → arrow", act({ selfMarkerType: "arrow" }) === "arrow");
ok("C7 class → class", act({ selfMarkerType: "class", carScanStatus: "ready", carScanId: "a", carScanMapUrl: "x" }) === "class");
ok("C8 parked 'photo' draws the car", act({ selfMarkerType: "photo", carScanStatus: "ready", carScanId: "a", carScanMapUrl: "x" }) === "scan:a");

console.log("D · Drive this today");
publish("a"); publish("b");
const A = { id: "scan:a", kind: "scan", scanId: "a" }, B = { id: "scan:b", kind: "scan", scanId: "b" };
await resetAll({
  selfMarkerType: "car", carScanId: "a", carScanStatus: "ready",
  carScanModelUrl: `${MODELS}/scan_a.glb`, carScanMapUrl: `${MODELS}/scan_a_map.glb`, carScanBackendId: "a",
  carYear: "2023", carMake: "Toyota", carModel: "GR Corolla", carColor: "Ice Cap White",
}, { completeScanIds: ["a", "b"] });
let r = await gc.driveToday({ id: "arrow", kind: "arrow" });
await new Promise((res) => setTimeout(res, 10));   // the profile clear goes out after any in-flight sync
let s = settings.getSettings();
ok("D1 scan → arrow: ok", r === "ok");
ok("D2 phone/CarPlay/peers all drop the scan", eq(surfaces(s), { marker: "arrow", mapScan: null, peerScanId: undefined }), JSON.stringify(surfaces(s)));
ok("D3 ONE settings write for the switch", settings.writes.length === 1, String(settings.writes.length));
ok("D4 parked + pick remembered", gs.getGarage().scanParked === true && gs.getGarage().arrowPick === "arrow");
ok("D5 the scan's identity remembered", eq(gs.getGarage().identity["scan:a"], { year: "2023", make: "Toyota", model: "GR Corolla", color: "Ice Cap White" }));
ok("D6 avatar_type PUT + green skin (SKIN_FOR_MARKER unchanged)", putsTo('"avatar_type":"arrow"').length === 1 && eq(skinStub.skins, ["brand"]));
ok("D7 today's car is now the arrow", gc.activeCarId(s, gs.getGarage()) === "arrow");

settings.writes.length = 0; apiStub.calls.length = 0; skinStub.skins.length = 0;
settings.__reset({ ...settings.getSettings(), carMake: "Other", carModel: "Thing" });
r = await gc.driveToday(A);
s = settings.getSettings();
ok("D8 arrow → scan a: ok", r === "ok");
ok("D9 every surface draws scan a again", eq(surfaces(s), { marker: "car", mapScan: `${MODELS}/scan_a_map.glb`, peerScanId: "a" }), JSON.stringify(surfaces(s)));
ok("D10 back on a parked scan → carScanBackendId empty, so map.tsx re-sends car_scan_id (parking cleared it on the profile)",
  s.carScanBackendId === undefined && putsTo('"car_scan_id":""').length === 0);
ok("D11 its identity came back (settings + profile PUT)", s.carMake === "Toyota" && s.carModel === "GR Corolla" && putsTo('"car_make":"Toyota"').length === 1);
ok("D12 unparked, diamond skin (a scan is Ultra's)", gs.getGarage().scanParked === false && eq(skinStub.skins, ["diamond"]));

settings.writes.length = 0;
r = await gc.driveToday(B);
s = settings.getSettings();
ok("D13 → a different scan: its URLs, ready, backend id cleared for map.tsx's one sync",
  s.carScanId === "b" && s.carScanStatus === "ready" && s.carScanMapUrl === `${MODELS}/scan_b_map.glb`
  && "carScanBackendId" in settings.writes[0] && s.carScanBackendId === undefined);

r = await gc.driveToday({ id: "class3d", kind: "class3d" });
s = settings.getSettings();
ok("D14 → stock 3D car: marker car, scan parked everywhere", eq(surfaces(s), { marker: "car", mapScan: null, peerScanId: undefined }) && gc.activeCarId(s, gs.getGarage()) === "class3d");
ok("D14b the stock 3D car keeps the GOLD metal — only a scan wears diamond", skinStub.skins[skinStub.skins.length - 1] === "ultra");
r = await gc.driveToday({ id: "class3d", kind: "class3d" });
ok("D15 driving today's car again is a no-op", r === "same");
r = await gc.driveToday({ id: "class", kind: "class" });
ok("D16 → class: marker class, silver skin", settings.getSettings().selfMarkerType === "class" && skinStub.skins[skinStub.skins.length - 1] === "premium");
r = await gc.driveToday({ id: "scan:b", kind: "scan", scanId: "b", building: true });
ok("D17 a building scan cannot be driven", r === "not-ready");

// A scan never proven complete: HEAD decides.
await resetAll({ selfMarkerType: "arrow" });
settings.writes.length = 0;
r = await gc.driveToday({ id: "scan:z", kind: "scan", scanId: "z" });
ok("D18 unpublished scan → not-ready, nothing written", r === "not-ready" && settings.writes.length === 0);
publish("z", false);
r = await gc.driveToday({ id: "scan:z", kind: "scan", scanId: "z" });
ok("D19 hero but no map twin → still not-ready (an invisible car otherwise)", r === "not-ready" && settings.writes.length === 0);
publish("z");
r = await gc.driveToday({ id: "scan:z", kind: "scan", scanId: "z" });
ok("D20 both GLBs → ok, and remembered complete", r === "ok" && gs.getGarage().completeScanIds.includes("z"));

// A non-scan pick while a NEW scan is building keeps its pointer.
await resetAll({ selfMarkerType: "car", carScanId: "n", carScanStatus: "submitted", carScanSubmittedAt: "2026-09-22T10:00:00Z" });
r = await gc.driveToday({ id: "arrow", kind: "arrow" });
s = settings.getSettings();
ok("D21 building scan keeps 'submitted' + its id; parked so launch-reconcile won't take over",
  s.carScanStatus === "submitted" && s.carScanId === "n" && gs.getGarage().scanParked === true);

console.log("E · a submitted scan finishes (the Garage's return leg)");
publish("n");
await resetAll({ selfMarkerType: "arrow", carScanId: "n", carScanStatus: "submitted", carScanSubmittedAt: "2026-09-22T10:00:00Z" },
  { chosenAt: "2026-09-22T09:00:00Z", scanParked: true });
let how = await cs.deliverSubmittedScan("n", { heroUrl: `${MODELS}/scan_n.glb`, mapUrl: `${MODELS}/scan_n_map.glb` });
s = settings.getSettings();
ok("E1 picked BEFORE submitting → the new car becomes today's car everywhere", how === "active"
  && eq(surfaces(s), { marker: "car", mapScan: `${MODELS}/scan_n_map.glb`, peerScanId: "n" }), JSON.stringify(surfaces(s)));
ok("E2 unparked; avatar_type + diamond skin because the marker changed; car_scan_id synced",
  gs.getGarage().scanParked === false && eq(skinStub.skins, ["diamond"]) && putsTo('"car_scan_id":"n"').length === 1);
await resetAll({ selfMarkerType: "arrow", carScanId: "n", carScanStatus: "submitted", carScanSubmittedAt: "2026-09-22T10:00:00Z" },
  { chosenAt: "2026-09-22T10:05:00Z" });
how = await cs.deliverSubmittedScan("n", { heroUrl: `${MODELS}/scan_n.glb`, mapUrl: `${MODELS}/scan_n_map.glb` });
s = settings.getSettings();
ok("E3 picked AFTER submitting → lands parked; the arrow stays on every surface", how === "parked"
  && eq(surfaces(s), { marker: "arrow", mapScan: null, peerScanId: undefined }) && gs.getGarage().completeScanIds.includes("n"));
await resetAll({ selfMarkerType: "car", carScanId: "n", carScanStatus: "submitted", carScanSubmittedAt: "2026-09-22T10:00:00Z" });
how = await cs.deliverSubmittedScan("n", { heroUrl: `${MODELS}/scan_n.glb`, mapUrl: `${MODELS}/scan_n_map.glb` });
ok("E4 never picked in the new Garage (today's flow) → active; marker already car so no avatar_type PUT, but Diamond goes on (Codex 2026-09-22: from the stock 3D car the metal was left gold)",
  how === "active" && eq(skinStub.skins, ["diamond"]) && putsTo("avatar_type").length === 0);

console.log("F · reconcileScanState guards");
publish("old"); publish("new");
const mine = (scans: any[]) => { apiStub.routes.get["/scan/mine"] = async () => ({ status: 200, data: { scans } }); };
await resetAll({});
mine([{ scanId: "old", status: "done", createdAt: "2026-09-01T00:00:00Z" }]);
ok("F1 lost pointer (reinstall) → restored (Olaf's recovery unchanged)", (await cs.reconcileScanState()) === "restored" && settings.getSettings().carScanId === "old");
await resetAll({ carScanId: "old", carScanStatus: "none", selfMarkerType: "arrow" }, { scanParked: true });
mine([{ scanId: "old", status: "done", createdAt: "2026-09-01T00:00:00Z" }]);
ok("F2 PARKED → not restored; the member's pick stands", (await cs.reconcileScanState()) === "noop" && settings.getSettings().carScanStatus === "none");
await resetAll({ carScanId: "new", carScanStatus: "submitted" });
mine([{ scanId: "new", status: "generating", createdAt: "2026-09-22T00:00:00Z" }, { scanId: "old", status: "done", createdAt: "2026-09-01T00:00:00Z" }]);
ok("F3 a scan STILL BUILDING is not overwritten by the older car", (await cs.reconcileScanState()) === "noop" && settings.getSettings().carScanId === "new" && settings.getSettings().carScanStatus === "submitted");
await resetAll({ carScanId: "new", carScanStatus: "submitted" });
mine([{ scanId: "new", status: "failed", createdAt: "2026-09-22T00:00:00Z" }, { scanId: "old", status: "done", createdAt: "2026-09-01T00:00:00Z" }]);
ok("F4 the submitted scan FAILED → the older car is restored (the 09-04 Olaf row)", (await cs.reconcileScanState()) === "restored" && settings.getSettings().carScanId === "old");
await resetAll({ carScanId: "new", carScanStatus: "submitted" }, { scanParked: true });
mine([{ scanId: "new", status: "failed", createdAt: "2026-09-22T00:00:00Z" }, { scanId: "old", status: "done", createdAt: "2026-09-01T00:00:00Z" }]);
ok("F5 failed while parked → marked failed, nothing restored", (await cs.reconcileScanState()) === "failed" && settings.getSettings().carScanStatus === "failed");
await resetAll({ carScanId: "new", carScanStatus: "submitted" });
mine([{ scanId: "new", status: "done", createdAt: "2026-09-22T00:00:00Z" }, { scanId: "old", status: "done", createdAt: "2026-09-01T00:00:00Z" }]);
ok("F6 the submitted scan is DONE → it is the one restored", (await cs.reconcileScanState()) === "restored" && settings.getSettings().carScanId === "new");
await resetAll({ carScanId: "old", carScanStatus: "ready", carScanMapUrl: "x" });
apiStub.calls.length = 0;
ok("F7 a ready phone is never touched (no request at all)", (await cs.reconcileScanState()) === "noop" && apiStub.calls.length === 0);

console.log("G · the inventory");
await resetAll({});
publish("s1");
apiStub.routes.get["/scan/mine"] = async () => ({ status: 200, data: { scans: [
  { scanId: "s1", status: "done", createdAt: "2026-09-10T00:00:00Z" },
  { scanId: "s2", status: "done", createdAt: "2026-09-11T00:00:00Z" },   // not published → not complete
  { scanId: "s3", status: "queued", createdAt: "2026-09-12T00:00:00Z" },
] } });
await gc.refreshScanList();
ok("G1 list stored; only published done scans proven complete", gs.getGarage().scans.length === 3 && eq(gs.getGarage().completeScanIds, ["s1"]));
apiStub.routes.get["/scan/mine"] = async () => ({ status: 503, data: { detail: "down" } });
await gc.refreshScanList();
ok("G2 a 503 keeps the last good list", gs.getGarage().scans.length === 3);
publish("s3");
const done = await gc.checkBuildingScans(["s3"]);
ok("G3 a building scan that published is complete and marked done", eq(done, ["s3"]) && gs.getGarage().completeScanIds.includes("s3")
  && gs.getGarage().scans.find((x: any) => x.scanId === "s3").status === "done");

console.log("H · one garage per account");
await resetAll({}, { nicknames: { arrow: "Zippy" }, completeScanIds: ["s1"] });
await gs.claimGarage("user-1");
ok("H1 first claim keeps what this phone had", gs.getGarage().ownerId === "user-1" && gs.getGarage().nicknames.arrow === "Zippy");
await gs.claimGarage("user-2");
ok("H2 another account starts empty", gs.getGarage().ownerId === "user-2" && eq(gs.getGarage().completeScanIds, []) && eq(gs.getGarage().nicknames, {}));
ok("H3 isScanParked reads the store", (await gs.isScanParked()) === false);

console.log("I · prices only from src/pricing.ts");
const c = (t: string, left = 2) => tier.upNextCopy(t, left);
ok("I1 free → Silver $4.99/mo or $39.99/yr", c("free").body.includes("$4.99/mo or $39.99/yr") && c("free").cta === "See Silver");
ok("I2 silver → Gold $9.99/mo or $79.99/yr", c("silver").body.includes("$9.99/mo or $79.99/yr") && c("silver").cta === "See Gold");
ok("I3 gold → Add Ultra $84.99/yr, 3 a year", c("gold").body.includes("$84.99/yr") && c("gold").body.includes("3 a year") && c("gold").label === "ADD ULTRA · YEARLY");
ok("I4 ultra → scans left, carry over, $2.99", c("ultra").body === "2 scans left this year — unused ones carry over. After that, $2.99 a scan.", c("ultra").body);
ok("I5 ultra, 1 left / 0 left wording", c("ultra", 1).body.startsWith("1 scan left") && c("ultra", 0).body.startsWith("No included scans left"));
ok("I6 one metal lookup: free green, silver silver, gold gold, ultra diamond",
  eq(["free", "silver", "gold", "ultra"].map(tier.garageMetal), ["brand", "premium", "ultra", "diamond"]));
ok("I7 next rung + the paywall feature it opens",
  eq(["free", "silver", "gold", "ultra"].map((t) => tier.nextRung(t)?.feature ?? null), ["class_marker", "car_3d", "car_scan", null]));

// ── J · the Codex review findings (2026-09-22), each as a regression case ──────────────────────────────
console.log("J · Codex findings");
publish("w"); publish("old2");
// J1 (finding 1): an arrow driver submits a scan, leaves the Garage; LAUNCH reconcile lands it —
// through the delivery path, so the marker follows (no 'ready' behind an arrow).
await resetAll({ selfMarkerType: "arrow", carScanId: "w", carScanStatus: "submitted", carScanSubmittedAt: "2026-09-22T10:00:00Z" },
  { chosenAt: "2026-09-22T09:00:00Z" });
mine([{ scanId: "w", status: "done", createdAt: "2026-09-22T10:00:00Z" }]);
let rr = await cs.reconcileScanState();
let ss = settings.getSettings();
ok("J1 launch lands the waiting scan as today's car (marker car) — never ready behind an arrow",
  rr === "restored" && eq(surfaces(ss), { marker: "car", mapScan: `${MODELS}/scan_w_map.glb`, peerScanId: "w" }), JSON.stringify(surfaces(ss)));
// J1b: same, but the member picked the arrow AFTER submitting → it lands parked, arrow everywhere.
await resetAll({ selfMarkerType: "arrow", carScanId: "w", carScanStatus: "submitted", carScanSubmittedAt: "2026-09-22T10:00:00Z" },
  { chosenAt: "2026-09-22T10:05:00Z", scanParked: true });
mine([{ scanId: "w", status: "done", createdAt: "2026-09-22T10:00:00Z" }]);
rr = await cs.reconcileScanState();
ss = settings.getSettings();
ok("J1b picked after submitting → launch lands it parked; the arrow stays on every surface",
  eq(surfaces(ss), { marker: "arrow", mapScan: null, peerScanId: undefined }) && gs.getGarage().completeScanIds.includes("w"), JSON.stringify(surfaces(ss)));
// J1c: a LOST scan restored while today's pick is the arrow lands parked, not ready.
await resetAll({ selfMarkerType: "arrow" });
mine([{ scanId: "old2", status: "done", createdAt: "2026-09-01T00:00:00Z" }]);
rr = await cs.reconcileScanState();
ss = settings.getSettings();
ok("J1c lost scan restored behind an arrow → parked (back in the Garage, not on the road)",
  rr === "restored" && eq(surfaces(ss), { marker: "arrow", mapScan: null, peerScanId: undefined }) && gs.getGarage().scanParked === true);
// J2 (finding 2): a delivery that lost the race to a newer pick must not touch settings.
await resetAll({ selfMarkerType: "car", carScanId: "a", carScanStatus: "ready", carScanModelUrl: `${MODELS}/scan_a.glb`, carScanMapUrl: `${MODELS}/scan_a_map.glb`, carScanSubmittedAt: "2026-09-22T10:00:00Z" });
how = await cs.deliverSubmittedScan("w", { heroUrl: `${MODELS}/scan_w.glb`, mapUrl: `${MODELS}/scan_w_map.glb` });
ss = settings.getSettings();
ok("J2 stale delivery (pointer moved to a) → only added to the Garage; a stays today's car",
  how === "stale" && ss.carScanId === "a" && ss.carScanStatus === "ready" && ss.carScanMapUrl === `${MODELS}/scan_a_map.glb` && gs.getGarage().completeScanIds.includes("w"));
// J3 (finding 3): reconcile's slow HEAD races a "Drive this today" → the pick wins.
await resetAll({ selfMarkerType: "car" }, { completeScanIds: [] });
mine([{ scanId: "old2", status: "done", createdAt: "2026-09-01T00:00:00Z" }]);
let release: () => void = () => {};
const gate = new Promise<void>((r) => { release = r; });
(globalThis as any).fetch = async (url: string) => { await gate; return { ok: published.has(url) }; };
const pending = cs.reconcileScanState();
await new Promise((r) => setTimeout(r, 10));
await gc.driveToday({ id: "arrow", kind: "arrow" });          // the member picks the arrow mid-flight
release();
rr = await pending;
(globalThis as any).fetch = async (url: string) => ({ ok: published.has(url) });
ss = settings.getSettings();
ok("J3 a pick made while reconcile waited on the network is not overwritten",
  rr === "noop" && ss.selfMarkerType === "arrow" && ss.carScanStatus !== "ready", `rr=${rr} ${JSON.stringify(surfaces(ss))}`);
// J4 (finding 4): another account claims the garage → the last account's scan pointer is dropped.
await resetAll({ selfMarkerType: "car", carScanId: "a", carScanStatus: "ready", carScanMapUrl: `${MODELS}/scan_a_map.glb`, carScanModelUrl: `${MODELS}/scan_a.glb` },
  { ownerId: "user-A", completeScanIds: ["a"] });
await gc.claimGarageFor("user-B");
ss = settings.getSettings();
ok("J4 account B does not inherit A's scan (pointer cleared, garage empty)",
  ss.carScanId === undefined && ss.carScanStatus === undefined && gs.getGarage().completeScanIds.length === 0 && gs.getGarage().ownerId === "user-B");
await gc.claimGarageFor("user-B");
ok("J4b the same account claiming again changes nothing", gs.getGarage().ownerId === "user-B");
// J4c: a /scan/mine answer that lands after the account changed is discarded.
await resetAll({}, { ownerId: "user-A" });
let releaseList: () => void = () => {};
const listGate = new Promise<void>((r) => { releaseList = r; });
apiStub.routes.get["/scan/mine"] = async () => { await listGate; return { status: 200, data: { scans: [{ scanId: "a", status: "done", createdAt: null }] } }; };
const listing = gc.refreshScanList();
await new Promise((r) => setTimeout(r, 10));
await gc.claimGarageFor("user-B");
releaseList();
await listing;
ok("J4c the previous account's list is not written into the new account's garage", gs.getGarage().scans.length === 0 && gs.getGarage().completeScanIds.length === 0);
// J5 (finding 5): scan → scan keeps a legacy outgoing scan that /scan/mine never lists.
await resetAll({ selfMarkerType: "car", carScanId: "legacy", carScanStatus: "ready", carScanModelUrl: `${MODELS}/scan_legacy.glb`, carScanMapUrl: `${MODELS}/scan_legacy_map.glb` },
  { completeScanIds: ["b"] });
await gc.driveToday(B);
ok("J5 the outgoing legacy scan stays a car in the Garage", gs.getGarage().completeScanIds.includes("legacy")
  && gc.scanCars(settings.getSettings(), gs.getGarage()).some((c: any) => c.id === "scan:legacy"));
await resetAll({ selfMarkerType: "car", carScanId: "legacy2", carScanStatus: "ready", carScanMapUrl: "x", carScanModelUrl: "y" });
await gc.adoptActiveScan();
ok("J5b adoptActiveScan puts today's scan in the list before a new capture can move the pointer", gs.getGarage().completeScanIds.includes("legacy2"));
// J6 (finding 6): parking clears the synced id locally and on the profile.
await resetAll({ selfMarkerType: "car", carScanId: "a", carScanStatus: "ready", carScanMapUrl: `${MODELS}/scan_a_map.glb`, carScanModelUrl: `${MODELS}/scan_a.glb`, carScanBackendId: "a" });
await gc.driveToday({ id: "class3d", kind: "class3d" });
await new Promise((res) => setTimeout(res, 10));
ok("J6 park → PUT car_scan_id \"\" and carScanBackendId cleared (re-sent when driven again)",
  putsTo('"car_scan_id":""').length === 1 && settings.getSettings().carScanBackendId === undefined);
// Heal: the old Garage's arrow-over-a-ready-scan state.
await resetAll({ selfMarkerType: "arrow", carScanId: "a", carScanStatus: "ready", carScanMapUrl: `${MODELS}/scan_a_map.glb`, carScanModelUrl: `${MODELS}/scan_a.glb` });
ok("J7 before: the phone draws the arrow, peers the scan (the old-Garage leak)", eq(surfaces(settings.getSettings()), { marker: "arrow", mapScan: `${MODELS}/scan_a_map.glb`, peerScanId: "a" }));
const healed = await gc.parkStrayScan();
ok("J7 parkStrayScan → the arrow on every surface, the scan kept in the Garage",
  healed && eq(surfaces(settings.getSettings()), { marker: "arrow", mapScan: null, peerScanId: undefined }) && gs.getGarage().completeScanIds.includes("a"));
await resetAll({ selfMarkerType: "class", carScanId: "a", carScanStatus: "ready", carScanMapUrl: `${MODELS}/scan_a_map.glb`, carScanModelUrl: `${MODELS}/scan_a.glb` });
ok("J7b the heal leaves a CLASS driver's scan alone (CarPlay cannot draw the class car)",
  (await gc.parkStrayScan()) === false && settings.getSettings().carScanStatus === "ready");
await resetAll({ selfMarkerType: "arrow", carScanId: "a", carScanStatus: "ready", carScanMapUrl: `${MODELS}/scan_a_map.glb`, carScanModelUrl: `${MODELS}/scan_a.glb` });
rr = await gc.driveToday({ id: "arrow", kind: "arrow" });
ok("J8 'Drive this today' on today's arrow repairs the same state instead of answering 'same'",
  rr === "ok" && settings.getSettings().carScanStatus === "none");

// J9: a FRESH store (never claimed) claimed first, then listed — the list is kept (the order garage.tsx
// uses on every focus; fetching before the claim landed discarded it — sim render 2026-09-22).
await resetAll({}, { ownerId: undefined });
apiStub.routes.get["/scan/mine"] = async () => ({ status: 200, data: { scans: [{ scanId: "s1", status: "done", createdAt: "2026-09-02T19:38:51Z" }] } });
await gc.claimGarageFor("user-1");
await gc.refreshScanList();
ok("J9 claim, then list → the first visit keeps the server list (and its dates)",
  gs.getGarage().scans.length === 1 && gs.getGarage().scans[0].createdAt === "2026-09-02T19:38:51Z");

// ── K · Codex pass 2 (2026-09-22) ─────────────────────────────────────────────────────────────────────
console.log("K · Codex pass 2");
// K1: a building check in flight while ANOTHER account claims the garage → nothing lands in B's garage.
await resetAll({}, { ownerId: "user-A", scans: [{ scanId: "bb", status: "generating", createdAt: null }] });
publish("bb");
let rel1: () => void = () => {};
const g1 = new Promise<void>((r) => { rel1 = r; });
(globalThis as any).fetch = async (url: string) => { await g1; return { ok: published.has(url) }; };
const chk = gc.checkBuildingScans(["bb"]);
await new Promise((r) => setTimeout(r, 10));
await gc.claimGarageFor("user-B");
rel1();
const got = await chk;
(globalThis as any).fetch = async (url: string) => ({ ok: published.has(url) });
ok("K1 A's building check finishing after B claimed → discarded", got.length === 0 && !gs.getGarage().completeScanIds.includes("bb"));
// K2: a delivery whose owner changed writes nothing at all — not even the inventory.
await resetAll({ carScanId: "w", carScanStatus: "submitted", carScanSubmittedAt: "2026-09-22T10:00:00Z" }, { ownerId: "user-B" });
how = await cs.deliverSubmittedScan("w", { heroUrl: `${MODELS}/scan_w.glb`, mapUrl: `${MODELS}/scan_w_map.glb` }, "user-A");
ok("K2 delivery started for A, landing after B claimed → stale, no settings or inventory write",
  how === "stale" && settings.getSettings().carScanStatus === "submitted" && !gs.getGarage().completeScanIds.includes("w"));
// K3: reconcile superseded by an account change during its HEAD.
await resetAll({ selfMarkerType: "car" }, { ownerId: "user-A" });
mine([{ scanId: "old2", status: "done", createdAt: "2026-09-01T00:00:00Z" }]);
let rel3: () => void = () => {};
const g3 = new Promise<void>((r) => { rel3 = r; });
(globalThis as any).fetch = async (url: string) => { await g3; return { ok: published.has(url) }; };
const rec = cs.reconcileScanState();
await new Promise((r) => setTimeout(r, 10));
await gs.claimGarage("user-B");
rel3();
rr = await rec;
(globalThis as any).fetch = async (url: string) => ({ ok: published.has(url) });
ok("K3 reconcile does not restore A's scan into B's phone after B claimed", rr === "noop" && settings.getSettings().carScanId === undefined);
// K4: A's inventory request still in flight does not stand in for B's.
await resetAll({}, { ownerId: "user-A" });
let rel4: () => void = () => {};
const g4 = new Promise<void>((r) => { rel4 = r; });
let calls4 = 0;
apiStub.routes.get["/scan/mine"] = async () => { calls4++; if (calls4 === 1) { await g4; return { status: 200, data: { scans: [{ scanId: "A1", status: "done", createdAt: null }] } }; } return { status: 200, data: { scans: [{ scanId: "B1", status: "queued", createdAt: "2026-09-22T00:00:00Z" }] } }; };
const aList = gc.refreshScanList();
await new Promise((r) => setTimeout(r, 10));
await gc.claimGarageFor("user-B");
const bList = gc.refreshScanList();
await bList;
rel4();
await aList;
// ≥ 2 requests since 84dccea4's review fix: besides A's list and B's list, claimGarageFor now starts a scan restore for
// the account signing in (and earlier tests' claims leave theirs in flight), so the count is no longer exact — the
// property is the answer: B's own list, A's late one discarded.
ok("K4 B gets its own /scan/mine answer; A's late answer is discarded",
  calls4 >= 2 && gs.getGarage().scans.length === 1 && gs.getGarage().scans[0].scanId === "B1",
  `calls=${calls4} scans=${JSON.stringify(gs.getGarage().scans.map((x: any) => x.scanId))}`);
// K5: a park made offline stays pending and is retried until acknowledged.
await resetAll({ selfMarkerType: "car", carScanId: "a", carScanStatus: "ready", carScanMapUrl: `${MODELS}/scan_a_map.glb`, carScanModelUrl: `${MODELS}/scan_a.glb`, carScanBackendId: "a" });
const realPut = apiStub.api.put;
apiStub.api.put = async (url: string, body: any) => { apiStub.calls.push({ m: "PUT", url, body }); if (body && "car_scan_id" in body) throw new Error("offline"); return { status: 200, data: body }; };
await gc.driveToday({ id: "arrow", kind: "arrow" });
await new Promise((r) => setTimeout(r, 10));
ok("K5 offline park → the clear stays pending", gs.getGarage().profileClearPending === true);
apiStub.api.put = async (url: string, body: any) => { apiStub.calls.push({ m: "PUT", url, body }); return { status: 200, data: { ...body, car_scan_id: null } }; };
await gc.retryProfileClear();
ok("K5b back online → retried and acknowledged", gs.getGarage().profileClearPending === false);
// K6: re-driving the scan cancels a pending clear (and the synced id is re-sent by map.tsx).
apiStub.api.put = async (url: string, body: any) => { apiStub.calls.push({ m: "PUT", url, body }); if (body && "car_scan_id" in body) throw new Error("offline"); return { status: 200, data: body }; };
await resetAll({ selfMarkerType: "car", carScanId: "a", carScanStatus: "ready", carScanMapUrl: `${MODELS}/scan_a_map.glb`, carScanModelUrl: `${MODELS}/scan_a.glb`, carScanBackendId: "a" }, { completeScanIds: ["a"] });
await gc.driveToday({ id: "arrow", kind: "arrow" });
await new Promise((r) => setTimeout(r, 10));
await gc.driveToday(A);
ok("K6 driving the scan again cancels the pending clear; no retry while it is on the road",
  gs.getGarage().profileClearPending === false && settings.getSettings().carScanStatus === "ready");
apiStub.api.put = realPut;

// ── L · Codex pass 3 (2026-09-22) ─────────────────────────────────────────────────────────────────────
console.log("L · Codex pass 3");
// L1: a scan-id "set" still on its way when the member parks → the clear goes out AFTER it, and the late
// set does not mark the (now parked) scan as synced.
await resetAll({ selfMarkerType: "car", carScanId: "a", carScanStatus: "ready", carScanMapUrl: `${MODELS}/scan_a_map.glb`, carScanModelUrl: `${MODELS}/scan_a.glb` }, { completeScanIds: ["a"] });
let relSync: () => void = () => {};
const gSync = new Promise<void>((r) => { relSync = r; });
const order: string[] = [];
apiStub.api.put = async (url: string, body: any) => {
  if (body && body.car_scan_id === "a") { await gSync; order.push("set"); return { status: 200, data: { car_scan_id: "a" } }; }
  if (body && body.car_scan_id === "") { order.push("clear"); return { status: 200, data: { car_scan_id: null } }; }
  return { status: 200, data: body };
};
const syncing = cs.syncScanIdToBackend("a");
await new Promise((r) => setTimeout(r, 10));
await gc.driveToday({ id: "arrow", kind: "arrow" });     // park while the set is in flight
await new Promise((r) => setTimeout(r, 10));
ok("L1 the clear waits while the older set is in flight", order.length === 0);
relSync();
await syncing;
await new Promise((r) => setTimeout(r, 20));
ok("L1b order on the wire: set, then clear", eq(order, ["set", "clear"]), JSON.stringify(order));
ok("L1c the late set did not mark the parked scan as synced; the clear is acknowledged",
  settings.getSettings().carScanBackendId === undefined && gs.getGarage().profileClearPending === false);
// L2: an OLD account's clear answering late must not acknowledge the new account's pending clear.
await resetAll({ selfMarkerType: "car", carScanId: "a", carScanStatus: "ready", carScanMapUrl: `${MODELS}/scan_a_map.glb`, carScanModelUrl: `${MODELS}/scan_a.glb` }, { ownerId: "user-A", completeScanIds: ["a"] });
let relA: () => void = () => {};
const gA = new Promise<void>((r) => { relA = r; });
let clearCalls = 0;
apiStub.api.put = async (url: string, body: any) => {
  if (body && body.car_scan_id === "") {
    clearCalls++;
    if (clearCalls === 1) { await gA; return { status: 200, data: { car_scan_id: null } }; }   // A's clear: slow, then OK
    throw new Error("offline");                                                               // B's clear: offline
  }
  return { status: 200, data: body };
};
await gc.driveToday({ id: "arrow", kind: "arrow" });                 // A parks; clear #1 in flight
await new Promise((r) => setTimeout(r, 10));
await gc.claimGarageFor("user-B");
settings.__reset({ selfMarkerType: "car", carScanId: "b", carScanStatus: "ready", carScanMapUrl: `${MODELS}/scan_b_map.glb`, carScanModelUrl: `${MODELS}/scan_b.glb` });
await gc.driveToday({ id: "arrow", kind: "arrow" });                 // B parks offline; clear #2 fails
await new Promise((r) => setTimeout(r, 10));
relA();
await new Promise((r) => setTimeout(r, 20));
ok("L2 A's late acknowledgement does not settle B's pending clear", gs.getGarage().ownerId === "user-B" && gs.getGarage().profileClearPending === true);
apiStub.api.put = realPut;

// M · Codex pass 4: a clear deferred behind A's sync must not go out once B has signed in.
console.log("M · Codex pass 4");
await resetAll({ selfMarkerType: "car", carScanId: "a", carScanStatus: "ready", carScanMapUrl: `${MODELS}/scan_a_map.glb`, carScanModelUrl: `${MODELS}/scan_a.glb` }, { ownerId: "user-A", completeScanIds: ["a"] });
let relS: () => void = () => {};
const gS = new Promise<void>((r) => { relS = r; });
const sent: string[] = [];
apiStub.api.put = async (url: string, body: any) => {
  if (body && body.car_scan_id === "a") { await gS; sent.push("set-a"); return { status: 200, data: { car_scan_id: "a" } }; }
  if (body && body.car_scan_id === "") { sent.push("clear"); return { status: 200, data: { car_scan_id: null } }; }
  return { status: 200, data: body };
};
const aSync = cs.syncScanIdToBackend("a");
await new Promise((r) => setTimeout(r, 10));
await gc.driveToday({ id: "arrow", kind: "arrow" });   // A parks; its clear waits behind the sync
await new Promise((r) => setTimeout(r, 10));
await gc.claimGarageFor("user-B");                     // B signs in before A's sync finishes
relS();
await aSync;
await new Promise((r) => setTimeout(r, 20));
ok("M1 A's deferred clear is dropped — it never goes out under B's session", eq(sent, ["set-a"]), JSON.stringify(sent));
apiStub.api.put = realPut;

console.log("N · review fixes (2026-09-22 reviews)");
{
  publish("old"); publish("new");
  const mine2 = (scans: any[]) => { apiStub.routes.get["/scan/mine"] = async () => ({ status: 200, data: { scans } }); };
  // N1 regressions#1: a CLASS driver's lost scan comes back 'ready' (CarPlay/AA + peers keep it), not parked.
  await resetAll({ selfMarkerType: "class", carScanId: "new", carScanStatus: "failed" });
  mine2([{ scanId: "new", status: "failed", createdAt: "2026-09-22T00:00:00Z" }, { scanId: "old", status: "done", createdAt: "2026-09-01T00:00:00Z" }]);
  let r = await cs.reconcileScanState(); let s = settings.getSettings();
  ok("N1 class driver: restored READY, CarPlay selfScanMapUrl set, not parked", r === "restored" && s.carScanId === "old"
    && s.carScanStatus === "ready" && eq(surfaces(s), { marker: "class", mapScan: `${MODELS}/scan_old_map.glb`, peerScanId: "old" })
    && gs.getGarage().scanParked !== true, JSON.stringify({ r, st: s.carScanStatus, p: gs.getGarage().scanParked }));
  // N2 the ARROW driver's still lands parked (the Showroom rule kept).
  await resetAll({ selfMarkerType: "arrow", carScanId: "new", carScanStatus: "failed" });
  mine2([{ scanId: "new", status: "failed", createdAt: "2026-09-22T00:00:00Z" }, { scanId: "old", status: "done", createdAt: "2026-09-01T00:00:00Z" }]);
  r = await cs.reconcileScanState(); s = settings.getSettings();
  ok("N2 arrow driver: restored PARKED", r === "restored" && s.carScanStatus === "none" && gs.getGarage().scanParked === true
    && eq(surfaces(s), { marker: "arrow", mapScan: null, peerScanId: undefined }));
  // N3 the 3D-car driver: ready (unchanged).
  await resetAll({ selfMarkerType: "car", carScanId: "new", carScanStatus: "failed" });
  mine2([{ scanId: "new", status: "failed", createdAt: "2026-09-22T00:00:00Z" }, { scanId: "old", status: "done", createdAt: "2026-09-01T00:00:00Z" }]);
  r = await cs.reconcileScanState(); s = settings.getSettings();
  ok("N3 car driver: restored READY", r === "restored" && s.carScanStatus === "ready" && gs.getGarage().scanParked !== true);
  // N4-N6 regressions#2: 'unknown' (slot, no job row) blocks the restore only for 2 h after submit.
  const recent = new Date(Date.now() - 10 * 60 * 1000).toISOString();
  const stale = new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString();
  await resetAll({ carScanId: "new", carScanStatus: "submitted", carScanSubmittedAt: recent });
  mine2([{ scanId: "new", status: "unknown", createdAt: null }, { scanId: "old", status: "done", createdAt: "2026-09-01T00:00:00Z" }]);
  r = await cs.reconcileScanState(); s = settings.getSettings();
  ok("N4 'unknown' 10 min after submit → still building, nothing restored", r === "noop" && s.carScanId === "new" && s.carScanStatus === "submitted");
  await resetAll({ carScanId: "new", carScanStatus: "submitted", carScanSubmittedAt: stale });
  mine2([{ scanId: "new", status: "unknown", createdAt: null }, { scanId: "old", status: "done", createdAt: "2026-09-01T00:00:00Z" }]);
  r = await cs.reconcileScanState(); s = settings.getSettings();
  ok("N5 'unknown' 3 h after submit → the older car is restored", r === "restored" && s.carScanId === "old" && s.carScanStatus === "ready");
  await resetAll({ carScanId: "new", carScanStatus: "submitted", carScanSubmittedAt: stale });
  mine2([{ scanId: "new", status: "generating", createdAt: "2026-09-22T00:00:00Z" }, { scanId: "old", status: "done", createdAt: "2026-09-01T00:00:00Z" }]);
  r = await cs.reconcileScanState(); s = settings.getSettings();
  ok("N6 a real job row still 'generating' 3 h on → still building (window is for 'unknown' only)", r === "noop" && s.carScanId === "new");
  // N7 surfaces#2: parking a ready scan with NO carScanMapUrl does not mark it complete (driving it again HEADs).
  await resetAll({ selfMarkerType: "car", carScanId: "nomap", carScanStatus: "ready", carScanMapUrl: undefined });
  r = await gc.driveToday({ id: "arrow", kind: "arrow" }); s = settings.getSettings();
  ok("N7 park without map twin → not in completeScanIds, still parked", r === "ok" && s.carScanStatus === "none"
    && !gs.getGarage().completeScanIds.includes("nomap"), JSON.stringify(gs.getGarage().completeScanIds));
  await resetAll({ selfMarkerType: "car", carScanId: "old", carScanStatus: "ready", carScanMapUrl: `${MODELS}/scan_old_map.glb` });
  r = await gc.driveToday({ id: "arrow", kind: "arrow" });
  ok("N8 park WITH map twin → remembered complete (unchanged)", r === "ok" && gs.getGarage().completeScanIds.includes("old"));
}

// ── O · what the stage calls each car (Jeff, 2026-09-23: menu reorganization) ──────────────────────────
console.log("O · stage labels");
{
  await resetAll({ vehicleClass: "supercar" });
  const slot = (n: number) => gc.ownedCars("gold", settings.getSettings(), gs.getGarage())[n - 1];
  const name = (n: number) => labels.carName(slot(n), settings.getSettings(), gs.getGarage());
  const sub = (n: number) => labels.carSub(slot(n), settings.getSettings(), gs.getGarage());
  ok("O1 a Supercar member's slot 4 reads \"Supercar · 3D\"", slot(4).kind === "class3d" && name(4) === "Supercar · 3D", name(4));
  ok("O2 with nothing chosen, slot 4 follows Silver's class", name(2) === "Supercar" && name(4) === `${name(2)} · 3D`);
  ok("O3 slot 4's sub names the real car and paint (2026-09-23): the GT3 RS's first bake", sub(4) === "Porsche 911 GT3 RS · Guards Red · 3D map", sub(4));
  await resetAll({ carColor: "Ice Cap White" });
  ok("O4 no class picked → the hatchback default, \"Hot Hatch · 3D\"", name(4) === "Hot Hatch · 3D", name(4));
  ok("O5 today's GR Corolla paint is the default bake and reads in slot 4's sub", sub(4) === "Toyota GR Corolla · Icecap White · 3D map", sub(4));
  await resetAll({ vehicleClass: "supercar" }, { nicknames: { class3d: "Weekend car" } });
  ok("O6 a nickname still beats the class headline", name(4) === "Weekend car", name(4));
}

// ── P · the 3D class car (Jeff, 2026-09-23: "the exotic 3d class needs to have the exotic 3d car …") ──────────
console.log("P · the 3D class car");
{
  const S = () => settings.getSettings();
  const G = () => gs.getGarage();
  const pick = () => gc.class3dChoice(S(), G());
  const C3 = { id: "class3d", kind: "class3d" };
  // P1–P6 the default (nothing stored)
  await resetAll({ carColor: "Blue Flame" });
  ok("P1 no class, GRC colour → Hot Hatch in that bake", pick().cls === "hatchback" && pick().modelKey === "blue_flame", JSON.stringify(pick()));
  await resetAll({ vehicleClass: "exotic", carColor: "Ice Cap White" });
  ok("P2 Exotic member, colour not an LFA bake → Exotic, the LFA's first bake", pick().cls === "exotic" && pick().modelKey === "lfa_whitest_white" && pick().paint === "Whitest White", JSON.stringify(pick()));
  await resetAll({ vehicleClass: "supercar", carColor: "gt3rs_miami_blue" });
  ok("P3 Supercar member in a GT3 RS bake → that bake", pick().cls === "supercar" && pick().modelKey === "gt3rs_miami_blue");
  await resetAll({ vehicleClass: "muscle", carColor: "Supersonic Red" });
  ok("P4 a Silver class with no 3D model (Muscle) → Hot Hatch, in today's GRC bake", pick().cls === "hatchback" && pick().modelKey === "supersonic_red");
  await resetAll({ vehicleClass: "sedan", carColor: "Pearl Blue" });
  ok("P5 Sedan member in an LFA colour → Hot Hatch's first bake (the colour is not a hatch bake)", pick().cls === "hatchback" && pick().modelKey === "supersonic_red");
  await resetAll({ vehicleClass: "exotic" });
  ok("P6 no colour at all → the class's first bake", pick().modelKey === "lfa_whitest_white");
  // P7–P9 the stored choice
  await resetAll({ vehicleClass: "supercar", carColor: "Blue Flame" }, { class3dPick: { cls: "exotic", modelKey: "lfa_pearl_blue" } });
  ok("P7 a stored choice beats the default", pick().cls === "exotic" && pick().modelKey === "lfa_pearl_blue" && pick().make === "Lexus" && pick().model === "LFA");
  await resetAll({ vehicleClass: "supercar" }, { class3dPick: { cls: "muscle", modelKey: "heavy_metal" } });
  ok("P8 a stored 'Coming soon' class is never the car (read-time validation) → the default", pick().cls === "supercar", JSON.stringify(pick()));
  await resetAll({ vehicleClass: "supercar" }, { class3dPick: { cls: "exotic", modelKey: "gt3rs_miami_blue" } });
  ok("P9 a stored bake from another class → the default", pick().cls === "supercar" && pick().modelKey === "gt3rs_guards_red");
  // P10–P12 storing it
  await resetAll({});
  let stored = true;
  for (const cls of gc.CLASS_3D_SOON) stored = stored && !(await gc.setClass3dPick(cls, "heavy_metal"));
  ok("P10 every 'Coming soon' class is refused and nothing is stored", stored && G().class3dPick === undefined, JSON.stringify(G().class3dPick));
  ok("P11 a bake from another class, or a hex-only swatch, is refused",
    !(await gc.setClass3dPick("exotic", "gt3rs_miami_blue")) && !(await gc.setClass3dPick("exotic", "Rosso Corsa")) && G().class3dPick === undefined);
  ok("P12 a real bake of a selectable class is stored", (await gc.setClass3dPick("exotic", "lfa_pearl_blue")) && eq(G().class3dPick, { cls: "exotic", modelKey: "lfa_pearl_blue" }));
  // P13 the picker lists 3 + 5, only the three selectable
  ok("P13 the picker: Hot Hatch · Supercar · Exotic selectable, then Muscle · Sedan · Truck · Electric · Jeep coming soon",
    eq(labels.CLASS_3D_PICKER.map((c: any) => `${c.label}${c.soon ? "*" : ""}`), ["Hot Hatch", "Supercar", "Exotic", "Muscle*", "Sedan*", "Truck*", "Electric*", "Jeep*"]),
    JSON.stringify(labels.CLASS_3D_PICKER.map((c: any) => c.label)));
  // P14 palettes = the classModels rows WITH a modelKey, no more
  ok("P14 colours are the real authored bakes only (5 · 7 · 5), never the hex-only swatches or the scan-built heavy_metal",
    gc.class3dPalette("hatchback").length === 5 && gc.class3dPalette("supercar").length === 7 && gc.class3dPalette("exotic").length === 5
    && ["hatchback", "supercar", "exotic"].every((c) => gc.class3dPalette(c).length
      === cm.CLASS_MODEL_3D[c].palette.filter((e: any) => e.modelKey && e.modelKey !== "heavy_metal").length));
  // P15 every selectable bake round-trips through what the map reads
  const bad: string[] = [];
  for (const c of gc.CLASS_3D_KEYS) for (const e of gc.class3dPalette(c)) {
    if (va.resolveGRCKey(e.modelKey) !== e.modelKey || va.getVehicleModelKey(e.modelKey) !== e.modelKey || !va.VEHICLE_MODEL_URL[e.modelKey]) bad.push(e.modelKey);
  }
  ok("P15 every bake key resolves to itself on the map (resolveGRCKey / getVehicleModelKey / a model URL)", bad.length === 0, bad.join(","));
  // P16 names and subs per class
  const lab = async (p: any) => {
    await resetAll({ selfMarkerType: "arrow" }, { class3dPick: p });
    return [labels.carName(C3, S(), G()), labels.carSub(C3, S(), G())];
  };
  ok("P16 Hot Hatch", eq(await lab({ cls: "hatchback", modelKey: "blue_flame" }), ["Hot Hatch · 3D", "Toyota GR Corolla · Blue Flame · 3D map"]));
  ok("P17 Supercar", eq(await lab({ cls: "supercar", modelKey: "gt3rs_miami_blue" }), ["Supercar · 3D", "Porsche 911 GT3 RS · Miami Blue · 3D map"]));
  ok("P18 Exotic", eq(await lab({ cls: "exotic", modelKey: "lfa_pearl_blue" }), ["Exotic · 3D", "Lexus LFA · Pearl Blue · 3D map"]));
  // P19–P22 Drive this today
  await resetAll({ selfMarkerType: "arrow", carYear: "2023", carMake: "Toyota", carModel: "GR Corolla", carColor: "Ice Cap White" },
    { class3dPick: { cls: "exotic", modelKey: "lfa_pearl_blue" } });
  let r = await gc.driveToday(C3);
  ok("P19 drive the Exotic: one settings write — marker car, carColor = the bake's paint, Lexus LFA, the year untouched",
    r === "ok" && settings.writes.length === 1 && S().selfMarkerType === "car" && S().carColor === "Pearl Blue" && S().carMake === "Lexus" && S().carModel === "LFA"
    && S().carYear === "2023" && !("carYear" in settings.writes[0]),
    JSON.stringify(S()));
  ok("P20 the map loads that bake — and the profile is NOT touched: it keeps the member's real car (Codex review of 8bcecd77)",
    carPuts().length === 0
    && va.getVehicleMapModelUrl(S().carColor).endsWith("/out_lfa_pearl_blue2.glb") && gc.class3dOnMap(S(), G()),
    JSON.stringify(carPuts()));
  await resetAll({ selfMarkerType: "car", vehicleClass: "exotic", carMake: "Toyota", carModel: "GR Corolla", carColor: "Heavy Metal" });
  ok("P21 an install whose 3D car predates the choice (GRC on the map, Exotic chosen by default) is NOT on the map",
    gc.activeCarId(S(), G()) === "class3d" && !gc.class3dOnMap(S(), G()) && pick().cls === "exotic");
  r = await gc.driveToday(C3);
  ok("P22 so driving it is not 'same' — it puts the LFA on the map and pins the choice",
    r === "ok" && S().carColor === "Whitest White" && S().carMake === "Lexus" && eq(G().class3dPick, { cls: "exotic", modelKey: "lfa_whitest_white" }));
  ok("P23 …and driving it again is a no-op", (await gc.driveToday(C3)) === "same");
  // P24 a 'Coming soon' class stored by hand never reaches settings
  await resetAll({ selfMarkerType: "arrow", vehicleClass: "hatchback", carColor: "Blue Flame" }, { class3dPick: { cls: "truck", modelKey: "heavy_metal" } });
  await gc.driveToday(C3);
  ok("P24 a hand-stored Truck pick drives the default instead, and the pin is a real class", S().carColor === "Blue Flame" && eq(G().class3dPick, { cls: "hatchback", modelKey: "blue_flame" }));
  // P25 claimGarage for another account forgets the choice
  await resetAll({}, { ownerId: "u1", class3dPick: { cls: "exotic", modelKey: "lfa_pearl_blue" } });
  await gs.claimGarage("u2");
  ok("P25 another account starts with no 3D class choice", G().class3dPick === undefined);

  // P26–P31 the member's OWN car is never lost to the class car (review 2026-09-23)
  const OWN = { year: "2019", make: "Honda", model: "Civic Type R", color: "Championship White" };
  const ownSettings = { carYear: OWN.year, carMake: OWN.make, carModel: OWN.model, carColor: OWN.color };
  await resetAll({ selfMarkerType: "arrow", vehicleClass: "exotic", ...ownSettings });
  await gc.driveToday(C3);
  ok("P26 driving the class car keeps the member's own car aside; carYear untouched",
    eq(G().ownIdentity, OWN) && S().carMake === "Lexus" && S().carColor === "Whitest White" && S().carYear === "2019", JSON.stringify(G().ownIdentity));
  ok("P27 …so a new scan is filed under the member's own car, not the LFA (garage-capture reads ownCarIdentity)",
    eq(gc.ownCarIdentity(S(), G()), OWN));
  await gc.setClass3dPick("supercar", "gt3rs_miami_blue");
  ok("P28 a new pick while it is on the road goes on the map (Customize), and the own car stays aside — not the LFA",
    (await gc.applyClass3dToday()) && S().carMake === "Porsche" && S().carColor === "Miami Blue" && eq(G().ownIdentity, OWN)
    && !(await gc.applyClass3dToday()));
  apiStub.calls.length = 0;
  await gc.driveToday({ id: "arrow", kind: "arrow" });
  ok("P29 leaving it puts the member's own car back in settings and forgets the copy — no profile write (it never changed)",
    eq(gc.identityOfSettings(S()), OWN) && G().ownIdentity === undefined && carPuts().length === 0, JSON.stringify(S()));
  await resetAll({ selfMarkerType: "arrow" });
  await gc.driveToday(C3);
  apiStub.calls.length = 0;
  await gc.driveToday({ id: "class", kind: "class" });
  ok("P30 an EMPTY own car goes back empty in settings, so the LFA does not outlive it — and no profile write",
    S().carMake === undefined && S().carColor === undefined && carPuts().length === 0);
  // A scan that finishes while the class car is on the road lands under the member's own car.
  publish("own1");
  await resetAll({ selfMarkerType: "arrow", vehicleClass: "exotic", ...ownSettings });
  await gc.driveToday(C3);
  await settings.updateSettings({ carScanId: "own1", carScanStatus: "submitted", carScanSubmittedAt: new Date(Date.now() + 60_000).toISOString() });
  apiStub.calls.length = 0;
  const landed = await cs.deliverSubmittedScan("own1", { heroUrl: `${MODELS}/scan_own1.glb`, mapUrl: `${MODELS}/scan_own1_map.glb` });
  ok("P31 a scan delivered over the class car takes the member's own identity back into settings, not the LFA's — and writes no car to the profile",
    landed === "active" && eq(gc.identityOfSettings(S()), OWN) && G().ownIdentity === undefined
    && gc.activeCarId(S(), G()) === "scan:own1" && carPuts().length === 0
    && !labels.carSub({ id: "scan:own1", kind: "scan", scanId: "own1" }, S(), G()).includes("LFA"),
    JSON.stringify(gc.identityOfSettings(S())));
  // Leaving the class car for a scan with no identity of its own gives the scan the member's own car.
  await resetAll({ selfMarkerType: "arrow", ...ownSettings }, { completeScanIds: ["own1"] });
  await gc.driveToday(C3);
  await gc.driveToday({ id: "scan:own1", kind: "scan", scanId: "own1" });
  ok("P32 class car → a scan with nothing remembered: the member's own car, not the LFA",
    eq(gc.identityOfSettings(S()), OWN) && G().ownIdentity === undefined);

  // P33 an unstored choice that IS what the map draws is pinned, so a new Silver class cannot move the 3D spot
  await resetAll({ selfMarkerType: "car", vehicleClass: "hatchback", carColor: "Blue Flame" });
  await gc.pinClass3dIfOnMap();
  await settings.updateSettings({ vehicleClass: "exotic" });
  ok("P33 pinned while on the map: after the class changes the 3D spot is still the car the map draws",
    eq(G().class3dPick, { cls: "hatchback", modelKey: "blue_flame" }) && gc.class3dOnMap(S(), G()) && pick().cls === "hatchback");
  await resetAll({ selfMarkerType: "car", vehicleClass: "exotic", carColor: "Heavy Metal" });
  await gc.pinClass3dIfOnMap();
  ok("P34 …and never pinned when the map draws something else (the stale install keeps its Drive this today)",
    G().class3dPick === undefined && !gc.class3dOnMap(S(), G()));

  // P35–P36 peers draw the same car: the presence slug of every bake reads back as that bake, and every bake's paint
  // name (what carColor carries) resolves to exactly that bake
  const slugBad: string[] = [];
  const nameBad: string[] = [];
  for (const c of gc.CLASS_3D_KEYS) for (const e of gc.class3dPalette(c)) {
    if (va.resolveGRCKey(va.toGRCSlug(e.modelKey)) !== e.modelKey || va.resolveGRCKey(va.toGRCSlug(e.name)) !== e.modelKey) slugBad.push(e.modelKey);
    if (va.resolveGRCKey(gc.class3dColor({ modelKey: e.modelKey, paint: e.name })) !== e.modelKey || gc.class3dColor({ modelKey: e.modelKey, paint: e.name }) !== e.name) nameBad.push(e.modelKey);
  }
  ok("P35 every bake's presence slug (activeColor) resolves back to that bake on a peer", slugBad.length === 0, slugBad.join(","));
  ok("P36 every bake is written as its paint name, which resolves to exactly that bake", nameBad.length === 0, nameBad.join(","));
  ok("P37 the GR Corolla slugs are unchanged", va.resolveGRCKey("grc_supersonic_red") === "supersonic_red" && va.resolveGRCKey("grc_heavymetal") === "heavy_metal"
    && va.resolveGRCKey("grc_pearl_blue") === null);
  // P38 the scan-built heavy_metal row (GRC2.glb, Jeff's own scan) is never the 3D class car — "not the 3d scanned
  // car" (Jeff, 2026-09-23); the sim showed it as a white car named "Heavy Metal"
  await resetAll({ vehicleClass: "hatchback", carColor: "Heavy Metal" });
  const hmDefault = pick().modelKey;
  await resetAll({ vehicleClass: "hatchback" }, { class3dPick: { cls: "hatchback", modelKey: "heavy_metal" } });
  const hmStored = pick().modelKey;
  ok("P38 heavy_metal is no 3D class colour: not listed, not the default for a Heavy Metal member, a stored pick falls back, and it cannot be stored",
    gc.CLASS_3D_KEYS.every((c: string) => !gc.class3dPalette(c).some((e: any) => e.modelKey === "heavy_metal"))
    && hmDefault !== "heavy_metal" && hmStored !== "heavy_metal" && !(await gc.setClass3dPick("hatchback", "heavy_metal")),
    `default=${hmDefault} stored=${hmStored}`);
  // P39 Codex's cross-account repro (review of 8bcecd77): A drives the class car (A's Honda kept aside), B signs in on the
  // same phone and the map's launch reconcile restores B's finished scan BEFORE the Garage claims the store for B.
  // Nothing may be written to the profile — it is B's, and the kept identity is A's.
  publish("bscan");
  await resetAll({ selfMarkerType: "car", ...ownSettings }, { ownerId: "userA" });
  await gc.driveToday(C3);
  apiStub.calls.length = 0;
  apiStub.routes.get["/scan/mine"] = async () => ({ status: 200, data: { scans: [{ scanId: "bscan", status: "done" }] } });
  const how39 = await cs.reconcileScanState();
  ok("P39 a scan restored at launch over the class car writes NO car to the profile (another account's kept identity must not land there)",
    how39 === "restored" && carPuts().length === 0, `how=${how39} puts=${JSON.stringify(carPuts())}`);
  // P40 an install that drove the Heavy Metal hatch before SCAN_BAKES (8bcecd77, sim only) is still recognised as carrying
  // the class car, so leaving it gives the member's own identity back instead of dropping it (Codex review of 83da6282)
  await resetAll({ selfMarkerType: "car", carYear: OWN.year, carMake: "Toyota", carModel: "GR Corolla", carColor: "Heavy Metal" },
    { class3dPick: { cls: "hatchback", modelKey: "heavy_metal" }, ownIdentity: OWN });
  const legacyCarried = gc.settingsHoldClassCar(S(), G());
  await gc.driveToday({ id: "arrow", kind: "arrow" });
  ok("P40 a legacy Heavy Metal class car is recognised, and leaving it puts the member's own car back",
    legacyCarried && eq(gc.identityOfSettings(S()), OWN) && G().ownIdentity === undefined && carPuts().length === 0,
    `carried=${legacyCarried} own=${JSON.stringify(G().ownIdentity)} puts=${JSON.stringify(carPuts())}`);
  // P41 the Garage mount's one-time identity sync and the Customize save both skip the car fields while settings hold the
  // class car this Garage put there, or while the garage store is still another account's (read from the source: both
  // are React screens this harness cannot mount)
  {
    const gsrc = readFileSync(new URL("../../app/(app)/garage.tsx", import.meta.url), "utf8");
    const csrc = readFileSync(new URL("../../src/components/showroom/CustomizeSheet.tsx", import.meta.url), "utf8");
    const mountGuard = /ensureGarageLoaded\(\)\.then\(\(g\) => \{[\s\S]{0,300}?if \(settingsHoldClassCar\(s, g\) \|\| !garageIsFor\(g, user\?\.id\)\) return;\s*api\.put\('\/auth\/profile'/;
    const saveGuard = /: settingsHoldClassCar\(s, g\) \|\| !garageIsFor\(g, user\?\.id\)\s*\? undefined/;
    const claimPassesProfile = /claimGarageFor\(userId, userRef\.current \?\? undefined\)/;
    ok("P41 Garage mount sync and Customize save gate the profile's car fields on settingsHoldClassCar + garageIsFor; the claim gets the profile",
      mountGuard.test(gsrc) && saveGuard.test(csrc) && /\.\.\.\(ident \? \{/.test(csrc) && claimPassesProfile.test(gsrc));
  }
  // P42 a REAL GR Corolla owner whose own car matches a Hot Hatch bake is not "holding the class car" — their car keeps
  // syncing to the profile (Codex review of 6cdcc831); the same identity put there by driving the class car is
  for (const color of ["Heavy Metal", "Supersonic Red"]) {
    await resetAll({ selfMarkerType: "arrow", carYear: "2023", carMake: "Toyota", carModel: "GR Corolla", carColor: color });
    const realOwner = gc.settingsHoldClassCar(S(), G());
    ok(`P42 a real GR Corolla owner in ${color} (no class car driven) is NOT treated as the class car`, realOwner === false);
  }
  await resetAll({ selfMarkerType: "arrow", ...ownSettings }, { class3dPick: { cls: "hatchback", modelKey: "supersonic_red" } });
  await gc.driveToday(C3);
  ok("P42b …and the Hot Hatch the Garage put on the road IS (so its identity stays off the profile)",
    gc.settingsHoldClassCar(S(), G()) && S().carModel === "GR Corolla" && S().carColor === "Supersonic Red");
  // P43 Codex's account-switch repro (review of 296b9530): A drives the class car, B signs in on the same phone and opens
  // the Garage. The claim must take A's car out of settings and put B's own in, so nothing B saves can send A's car.
  await resetAll({ selfMarkerType: "arrow", ...ownSettings }, { ownerId: "userA" });
  await gc.driveToday(C3);
  const aHeld = gc.settingsHoldClassCar(S(), G()) && S().carMake !== "Honda";
  await gc.claimGarageFor("userB", { car_make: "Subaru", car_model: "WRX", car_color: "WR Blue Pearl", car_year: 2022 });
  ok("P43 account switch: A's class car leaves settings and B's profile car comes in (none of A's identity stays)",
    aHeld && eq(gc.identityOfSettings(S()), { year: "2022", make: "Subaru", model: "WRX", color: "WR Blue Pearl" })
    && G().ownerId === "userB" && G().ownIdentity === undefined && !gc.settingsHoldClassCar(S(), G()) && carPuts().length === 0,
    JSON.stringify(gc.identityOfSettings(S())));
  await resetAll({ selfMarkerType: "arrow", ...ownSettings }, { ownerId: "userA" });
  await gc.driveToday(C3);
  await gc.claimGarageFor("userB", {});
  ok("P43b …and a B with no car on its profile starts with an EMPTY identity, not A's",
    S().carMake === undefined && S().carModel === undefined && S().carColor === undefined && S().carYear === undefined);
  await resetAll({ ...ownSettings }, { ownerId: "userA" });
  ok("P43c garageIsFor: the owner's store yes, another account's no, an owner-less store yes (the first claim adopts it)",
    gc.garageIsFor(G(), "userA") && !gc.garageIsFor(G(), "userB") && !gc.garageIsFor(G(), undefined)
    && gc.garageIsFor({ ...G(), ownerId: undefined }, "userB"));
  await resetAll({ ...ownSettings }, { ownerId: "userA" });
  await gc.claimGarageFor("userA", { car_make: "Subaru" });
  ok("P43d the SAME account re-claiming changes nothing in settings", eq(gc.identityOfSettings(S()), OWN));
  // P44 the account's FIRST finished scan holds the metal worn (appSkin.holdSkinForUnlock) before it records the scan, so
  // Diamond arrives as the unlock wave (src/skinWave.ts); a second scan unlocks nothing new and holds nothing
  publish("h1"); publish("h2");
  await resetAll({ selfMarkerType: "arrow", carScanId: "h1", carScanStatus: "submitted", carScanSubmittedAt: new Date().toISOString() });
  skinStub.holds.length = 0;
  const firstHow = await cs.deliverSubmittedScan("h1", { heroUrl: `${MODELS}/scan_h1.glb`, mapUrl: `${MODELS}/scan_h1_map.glb` });
  const heldFirst = [...skinStub.holds];
  await settings.updateSettings({ carScanId: "h2", carScanStatus: "submitted", carScanSubmittedAt: new Date(Date.now() + 1000).toISOString() });
  await cs.deliverSubmittedScan("h2", { heroUrl: `${MODELS}/scan_h2.glb`, mapUrl: `${MODELS}/scan_h2_map.glb` });
  ok("P44 the 1st finished scan holds the metal for the unlock wave; the 2nd does not",
    firstHow === "active" && eq(heldFirst, ["first-scan"]) && eq(skinStub.holds, ["first-scan"]),
    `first=${firstHow} holds=${JSON.stringify(skinStub.holds)}`);
  // P45 Codex's repro on 84dccea4: A has a finished scan, B signs in (claim → B), then A signs back in and stays on the
  // Map. The shell's claim must bring A's own scan back without the Garage, so A's Diamond (owner A + completeScanIds)
  // returns — it used to wait for Garage focus, with A's restored scan filed under B.
  publish("a1");
  await resetAll({ selfMarkerType: "car" }, { ownerId: "userA", completeScanIds: ["a1"] });
  apiStub.routes.get["/scan/mine"] = async () => ({ status: 200, data: { scans: [] } });
  await gc.claimGarageFor("userB", {});
  await new Promise((r) => setTimeout(r, 30));
  apiStub.routes.get["/scan/mine"] = async () => ({ status: 200, data: { scans: [{ scanId: "a1", status: "done", createdAt: "2026-09-02T00:00:00Z" }] } });
  await gc.claimGarageFor("userA", {});
  for (let k = 0; k < 50 && !G().completeScanIds.includes("a1"); k++) await new Promise((r) => setTimeout(r, 10));
  ok("P45 A back after B: the sign-in claim restores A's own finished scan under A (its Diamond comes back on the Map)",
    G().ownerId === "userA" && G().completeScanIds.includes("a1"), JSON.stringify({ owner: G().ownerId, ids: G().completeScanIds }));
  // P46–P48 review of 84dccea4
  // P46 the Garage's list refresh can record the phone's SUBMITTED scan before the return leg delivers it (they race on
  // focus): it must hold too, or Diamond flips with no wave (reproduced ~50% of focus trials)
  publish("L1");
  await resetAll({ selfMarkerType: "car", carScanId: "L1", carScanStatus: "submitted", carScanSubmittedAt: new Date().toISOString() }, { ownerId: "u1" });
  skinStub.holds.length = 0;
  apiStub.routes.get["/scan/mine"] = async () => ({ status: 200, data: { scans: [{ scanId: "L1", status: "done", createdAt: null }] } });
  await gc.refreshScanList();
  ok("P46 the list refresh recording the phone's submitted scan first holds the metal for the unlock wave",
    eq(skinStub.holds, ["first-scan"]) && G().completeScanIds.includes("L1"), JSON.stringify(skinStub.holds));
  // P47 …but a finished scan that merely reappears (reinstall: nothing on this phone was waiting for it) unlocks silently
  publish("R1");
  await resetAll({ selfMarkerType: "arrow" }, { ownerId: "u1" });
  skinStub.holds.length = 0;
  apiStub.routes.get["/scan/mine"] = async () => ({ status: 200, data: { scans: [{ scanId: "R1", status: "done", createdAt: null }] } });
  await gc.refreshScanList();
  ok("P47 a finished scan coming back after a reinstall is recorded with NO hold — no 'Your 1st 3D scan' replay",
    skinStub.holds.length === 0 && G().completeScanIds.includes("R1"), JSON.stringify(skinStub.holds));
  // P48 a Garage pick while the unlock waits: the choice first, then the hold released (the pick shows at once); driving
  // the scan (Diamond) keeps the hold — that is the unlock
  await resetAll({ selfMarkerType: "car" }, { ownerId: "u1" });
  skinStub.skins.length = 0; skinStub.releases.length = 0;
  await gc.driveToday({ id: "arrow", kind: "arrow" });
  await new Promise((r) => setTimeout(r, 20));
  const arrowRel = [...skinStub.releases];
  publish("D1");
  await resetAll({ selfMarkerType: "arrow" }, { ownerId: "u1", completeScanIds: ["D1"] });
  skinStub.skins.length = 0; skinStub.releases.length = 0;
  await gc.driveToday({ id: "scan:D1", kind: "scan", scanId: "D1" });
  await new Promise((r) => setTimeout(r, 20));
  ok("P48 a Garage pick releases a pending unlock hold AFTER setting its choice; driving the scan keeps it",
    eq(arrowRel, [1]) && skinStub.releases.length === 0 && eq(skinStub.skins, ["diamond"]),
    `arrow=${JSON.stringify(arrowRel)} scan=${JSON.stringify(skinStub.releases)}`);
}

console.log(fails ? `\nFAIL garage_logic (${fails})` : "\nPASS garage_logic");
process.exit(fails ? 1 : 0);
