// skin_unlock_test.mts — Diamond is unlocked by the first 3D scan, and the unlock arrives as a wave (2026-09-23).
//
// Jeff: "lets gate the diamond to when someone actually scans their car it unlocks diamond not on the purchase" and
// "can we have a animation for each unlock tier? … all the buttons etc.. on the screen turning to the next tier skin
// color in real time". Runs the REAL src/appSkin.ts, src/garageStore.ts and src/skinWave.ts (skin/loader.mjs stubs
// settings, entitlements, tierTheme, motion and AsyncStorage):
//   G  the gate — no scan, no Diamond (a stored pick shows Gold, setSkinChoice refuses it); a finished scan unlocks it,
//      "auto" wears it; a 'ready' scan counts; a store owned by ANOTHER account unlocks nothing; the tier ceilings with
//      entitlements on.
//   H  the unlock hold — the old metal stays on every surface until the wave releases it; stale holds and holds that
//      change nothing are not shown; an account claim drops it; repaints fire only when the metal actually changes.
//   W  the wave engine — cannot play → applied at once; plays → run, apply, settle, done, in that order; never two at once.
// Run: node --experimental-strip-types tools/sim-qc/skin_unlock_test.mts

import { register } from "node:module";
register("./skin/loader.mjs", import.meta.url);

const settings: any = await import(new URL("./skin/stubs/settings.mjs", import.meta.url).href);
const ent: any = await import(new URL("./skin/stubs/entitlements.mjs", import.meta.url).href);
const gs: any = await import("../../src/garageStore.ts");
const as: any = await import("../../src/appSkin.ts");
const wv: any = await import("../../src/skinWave.ts");

let failed = 0;
const ok = (name: string, cond: boolean, detail = "") => {
  console.log(`  ${cond ? "ok  " : "FAIL"} ${name}${detail ? `  (${detail})` : ""}`);
  if (!cond) failed++;
};
const eq = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

async function reset(s: Record<string, unknown> = {}, g: Record<string, unknown> = {}, enforced = false, tier = "free") {
  settings.__reset(s);
  ent.__set(enforced, tier);
  as.setSkinAccount(undefined);
  await gs.updateGarage({
    ownerId: undefined, scans: [], completeScanIds: [], skinHold: undefined, identity: {}, nicknames: {}, ...g,
  });
}
const worn = () => as.appSkinNow();

console.log("G · Diamond waits for the first 3D scan");
await reset();
ok("G1 testers, no scan: the top metal is Gold, Diamond is not offered", as.entitledSkin() === "ultra" && !as.allowedSkins().includes("diamond"));
ok("G2 …Automatic wears Gold", worn() === "ultra" && as.autoSkin() === "ultra");
await reset({ appSkin: "diamond" });
ok("G3 a tester who picked Diamond before the gate now wears Gold — the pick is kept, not overwritten",
  worn() === "ultra" && settings.getSettings().appSkin === "diamond");
const refused = await as.setSkinChoice("diamond");
ok("G4 setSkinChoice('diamond') is refused without a scan", refused === "ultra" && worn() === "ultra");
await reset({}, { completeScanIds: ["s1"] });
ok("G5 one finished scan unlocks Diamond; Automatic wears it", as.diamondUnlocked() && worn() === "diamond" && as.allowedSkins().includes("diamond"));
await reset({ appSkin: "diamond" }, { completeScanIds: ["s1"] });
ok("G6 …and the kept Diamond pick comes back", worn() === "diamond");
await reset({ carScanStatus: "ready", carScanId: "r1" });
ok("G7 a 'ready' scan in settings counts before the list is filled (incl. the pre-fix latch: no carScanMapUrl)", as.diamondUnlocked());
await reset({ carScanStatus: "submitted", carScanId: "b1" });
ok("G8 a scan still BUILDING unlocks nothing", !as.diamondUnlocked() && worn() === "ultra");
await reset({}, { ownerId: "userA", completeScanIds: ["s1"] });
as.setSkinAccount("userB");
const other = as.diamondUnlocked();
as.setSkinAccount("userA");
const mine = as.diamondUnlocked();
as.setSkinAccount(undefined);
const unknown = as.diamondUnlocked();
ok("G9 another account's garage unlocks nothing; the owner's does; an unknown account (car-first launch) trusts the store",
  !other && mine && unknown, `other=${other} mine=${mine} unknown=${unknown}`);
await reset({}, { completeScanIds: ["s1"] }, true, "gold");
const goldScanned = worn();
await reset({}, {}, true, "ultra");
const ultraNoScan = worn();
await reset({}, { completeScanIds: ["s1"] }, true, "ultra");
const ultraScanned = worn();
await reset({}, { completeScanIds: ["s1"] }, true, "club_founder");
const founderScanned = worn();
await reset({}, {}, true, "premium");
const premium = worn();
ok("G10 entitlements ON: Gold+scan → gold · Ultra, no scan → gold · Ultra+scan → Diamond · founder+scan → Diamond · Silver → silver",
  goldScanned === "ultra" && ultraNoScan === "ultra" && ultraScanned === "diamond" && founderScanned === "diamond" && premium === "premium",
  [goldScanned, ultraNoScan, ultraScanned, founderScanned, premium].join(","));

console.log("H · the unlock waits to be shown");
await reset();
await as.holdSkinForUnlock("first-scan");
await gs.updateGarage({ completeScanIds: ["s1"] });
ok("H1 held: every surface still wears Gold after the scan lands", worn() === "ultra" && as.appSkinUnheld() === "diamond");
ok("H2 the pending unlock is Gold → Diamond", eq(as.pendingUnlock(), { key: "first-scan", from: "ultra", to: "diamond" }));
await as.releaseSkinHold();
ok("H3 released: Diamond is worn, nothing pending", worn() === "diamond" && as.pendingUnlock() === null);
await reset({}, { completeScanIds: ["s1"], skinHold: { key: "first-scan", from: "ultra", at: new Date(Date.now() - 25 * 3600e3).toISOString() } });
ok("H4 a hold older than 24 h is not honoured — the metal is never held back indefinitely", worn() === "diamond" && as.pendingUnlock() === null);
await reset({ appSkin: "brand" }, { completeScanIds: ["s1"], skinHold: { key: "first-scan", from: "brand", at: new Date().toISOString() } });
ok("H5 a member wearing green by choice: the unlock changes nothing, so there is nothing to show", worn() === "brand" && as.pendingUnlock() === null);
await reset({}, { ownerId: "userA", completeScanIds: ["s1"], skinHold: { key: "first-scan", from: "ultra", at: new Date().toISOString() } });
await gs.claimGarage("userB");
ok("H6 an account switch drops the hold and the scans with it", gs.getGarage().skinHold === undefined && worn() === "ultra");
await reset();
await as.holdSkinForUnlock("first-scan");
const firstAt = gs.getGarage().skinHold?.at;
await new Promise((r) => setTimeout(r, 5));
await as.holdSkinForUnlock("first-scan");
ok("H7 a second hold keeps the first (its `from` is what the member last saw)", gs.getGarage().skinHold?.at === firstAt);
// Repaints: the garage and settings stores notify on every write; the skin must only repaint when the metal changes.
await reset();
let paints = 0;
const off = as.subscribeAppSkin(() => { paints++; });
await gs.updateGarage({ nicknames: { x: "Daily" } });
await settings.updateSettings({ speedUnit: "kmh" });
const idle = paints;
await gs.updateGarage({ completeScanIds: ["s1"] });
const afterUnlock = paints;
off();
ok("H8 repaint only when the metal changes: unrelated writes 0, the unlock 1", idle === 0 && afterUnlock === 1, `idle=${idle} unlock=${afterUnlock}`);

console.log("W · the wave");
ok("W1 the band reaches the top at 0 and the bottom at the full sweep; Reduce Motion is all at once",
  wv.waveReachMs(0, false) === 0 && wv.waveReachMs(1, false) === wv.WAVE.sweep && wv.waveReachMs(0.5, true) === 0 && wv.waveReachMs(2, false) === wv.WAVE.sweep);
ok("W2 the whole wave is about a second — UI motion stays short (DESIGN.md §11)", wv.waveRunMs(false) + wv.WAVE.settle <= 1400, `${wv.waveRunMs(false) + wv.WAVE.settle} ms`);
{
  let applied = 0;
  const how = await wv.playSkinWave({ from: "ultra", to: "diamond", reduce: false, canPlay: false, apply: () => { applied++; } });
  ok("W3 cannot be seen (app in background, a drive on) → applied at once, nothing published", how === "applied" && applied === 1 && wv.getSkinWave() === null);
}
{
  let applied = 0;
  const how = await wv.playSkinWave({ from: "ultra", to: "ultra", reduce: false, canPlay: true, apply: () => { applied++; } });
  ok("W4 nothing changes → applied, no wave", how === "applied" && applied === 1 && wv.getSkinWave() === null);
}
{
  const seen: string[] = [];
  const off2 = wv.subscribeSkinWave((w: any) => seen.push(w ? w.phase : "done"));
  let appliedAt = -1;
  const t0 = Date.now();
  const p = wv.playSkinWave({
    from: "ultra", to: "diamond", reduce: false, canPlay: true, badge: { title: "DIAMOND UNLOCKED" },
    apply: () => { appliedAt = Date.now() - t0; seen.push("apply"); },
  });
  const during = wv.getSkinWave();
  let second = 0;
  const how2 = await wv.playSkinWave({ from: "ultra", to: "premium", reduce: false, canPlay: true, apply: () => { second++; } });
  const how = await p;
  off2();
  ok("W5 plays: run → apply → settle → done, in that order", how === "played" && eq(seen, ["run", "apply", "settle", "done"]), seen.join(","));
  ok("W6 the skin is changed only after the band and the last reveal", appliedAt >= wv.waveRunMs(false) - 5, `apply at ${appliedAt} ms`);
  ok("W7 the running wave carries from, to and the badge", during?.from === "ultra" && during?.to === "diamond" && during?.badge?.title === "DIAMOND UNLOCKED");
  ok("W8 a second wave while one runs is applied at once, never stacked", how2 === "applied" && second === 1);
}

console.log(failed ? `\nFAIL skin_unlock (${failed})` : "\nPASS skin_unlock");
process.exit(failed ? 1 : 0);
