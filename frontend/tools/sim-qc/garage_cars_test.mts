// Scratch harness (NOT a repo gate): runs the REAL src/garageCars.ts, src/garageStore.ts, src/carScan.ts
// and src/components/showroom/tier.ts with the native/network edges stubbed (loader.mjs).
import { register } from "node:module";
register("./garage/loader.mjs", import.meta.url);

const SRC = new URL("../../src/", import.meta.url).href;
const gc: any = await import(SRC + "garageCars.ts");
const gs: any = await import(SRC + "garageStore.ts");
const cs: any = await import(SRC + "carScan.ts");
const tier: any = await import(SRC + "components/showroom/tier.ts");
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
    nicknames: {}, identity: {}, scans: [], completeScanIds: [], ...g,
  });
  apiStub.calls.length = 0;
  skinStub.skins.length = 0;
  for (const k of Object.keys(apiStub.routes.get)) delete apiStub.routes.get[k];
}
const putsTo = (body: string) => apiStub.calls.filter((c: any) => c.m === "PUT" && JSON.stringify(c.body).includes(body));
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
ok("B3 gold", eq(ids("gold"), ["arrow", "arrow3d", "class", "class3d"]));
ok("B4 ultra, no scans", eq(ids("ultra"), ["arrow", "arrow3d", "class", "class3d"]));
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
  eq(ids("ultra"), ["arrow", "arrow3d", "class", "class3d", "scan:legacy", "scan:c(b)", "scan:a", "scan:b(b)"]),
  JSON.stringify(ids("ultra")));
ok("B6 gold never lists scans", eq(ids("gold"), ["arrow", "arrow3d", "class", "class3d"]));

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
ok("D12 unparked, gold skin", gs.getGarage().scanParked === false && eq(skinStub.skins, ["ultra"]));

settings.writes.length = 0;
r = await gc.driveToday(B);
s = settings.getSettings();
ok("D13 → a different scan: its URLs, ready, backend id cleared for map.tsx's one sync",
  s.carScanId === "b" && s.carScanStatus === "ready" && s.carScanMapUrl === `${MODELS}/scan_b_map.glb`
  && "carScanBackendId" in settings.writes[0] && s.carScanBackendId === undefined);

r = await gc.driveToday({ id: "class3d", kind: "class3d" });
s = settings.getSettings();
ok("D14 → stock 3D car: marker car, scan parked everywhere", eq(surfaces(s), { marker: "car", mapScan: null, peerScanId: undefined }) && gc.activeCarId(s, gs.getGarage()) === "class3d");
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
ok("E2 unparked; avatar_type + gold skin because the marker changed; car_scan_id synced",
  gs.getGarage().scanParked === false && eq(skinStub.skins, ["ultra"]) && putsTo('"car_scan_id":"n"').length === 1);
await resetAll({ selfMarkerType: "arrow", carScanId: "n", carScanStatus: "submitted", carScanSubmittedAt: "2026-09-22T10:00:00Z" },
  { chosenAt: "2026-09-22T10:05:00Z" });
how = await cs.deliverSubmittedScan("n", { heroUrl: `${MODELS}/scan_n.glb`, mapUrl: `${MODELS}/scan_n_map.glb` });
s = settings.getSettings();
ok("E3 picked AFTER submitting → lands parked; the arrow stays on every surface", how === "parked"
  && eq(surfaces(s), { marker: "arrow", mapScan: null, peerScanId: undefined }) && gs.getGarage().completeScanIds.includes("n"));
await resetAll({ selfMarkerType: "car", carScanId: "n", carScanStatus: "submitted", carScanSubmittedAt: "2026-09-22T10:00:00Z" });
how = await cs.deliverSubmittedScan("n", { heroUrl: `${MODELS}/scan_n.glb`, mapUrl: `${MODELS}/scan_n_map.glb` });
ok("E4 never picked in the new Garage (today's flow) → active, no avatar/skin writes (marker already car)",
  how === "active" && skinStub.skins.length === 0 && putsTo("avatar_type").length === 0);

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
ok("I6 one metal lookup: free green, silver silver, gold gold, ultra gold until diamond",
  eq(["free", "silver", "gold", "ultra"].map(tier.garageMetal), ["brand", "premium", "ultra", "ultra"]));
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
ok("K4 B gets its own /scan/mine answer; A's late answer is discarded",
  calls4 === 2 && gs.getGarage().scans.length === 1 && gs.getGarage().scans[0].scanId === "B1");
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

console.log(fails ? `\nFAIL garage_logic (${fails})` : "\nPASS garage_logic");
process.exit(fails ? 1 : 0);
