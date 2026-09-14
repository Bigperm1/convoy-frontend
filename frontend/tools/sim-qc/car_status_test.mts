// car_status_test.mts — gate for the car-screen "what is missing" message (build 79, 2026-09-14).
// Run: node --experimental-strip-types tools/sim-qc/car_status_test.mts
// EXITS NON-ZERO ON FAILURE — this is a gate, not a printout.
//
// Imports the REAL applied modules (all three are dependency-free on purpose, like offRouteGate.ts):
//   src/carplay/carStatusRule.ts   which condition the car reports (R*)
//   src/carplay/carStatusCopy.ts   the exact words, per platform (C*)
//   src/netHealth.ts               when "No connection" is allowed to appear (N*)
//
// The copy rules it enforces, verbatim sources in carStatusCopy.ts's header:
//   CarPlay Developer Guide p.4 guideline 2 — no iOS string may ask the driver to handle the iPhone (C2).
//   Android Auto car app quality VI-1 — the phone only in a permission ask, always with the "only when
//   it's safe" instruction (C3, C4), and that clause ENDS inside the first 48 characters so the 213x107 dp
//   AA canvas cannot truncate exactly those words (C7, review correction 4).
// What this cannot see: pixels. Layout at 213x107 / 427x240 / 470x265 / 775x291 needs a render bench.
import { decideCarStatus, isSlotStatus, isAskableStatus, type CarStatusInputs, type CarStatusCode } from "../../src/carplay/carStatusRule.ts";
import { carStatusCopy, commsCopy, ALL_COMMS_KINDS, CAR_ALLOW_LOCATION_TITLE } from "../../src/carplay/carStatusCopy.ts";
import { netDown, noteNetOk, noteNetFail, classifyAxiosError, subscribeNetHealth, __resetNetHealthForTest, NET_DOWN_AFTER_MS } from "../../src/netHealth.ts";

const fails: string[] = [];
const check = (ok: boolean, m: string) => { if (!ok) fails.push(m); };

// ── R: the rule ─────────────────────────────────────────────────────────────────────────────────
const T = 1_700_000_000_000;
const base: CarStatusInputs = {
  platform: "ios", servicesOn: true, fgGranted: true, carCanRequest: false, askPendingUntil: 0,
  deniedThisSession: false, blocked: false, token: "ok", netDown: false, hasFix: true, now: T,
};
const d = (p: Partial<CarStatusInputs>) => decideCarStatus({ ...base, ...p });
check(d({}) === "ok", "R1 all fine");
check(d({ hasFix: false }) === "finding", "R2 no fix yet");
check(d({ servicesOn: false, fgGranted: false }) === "loc-off", "R3 services off beats the 'denied' iOS reports while they are off");
check(d({ fgGranted: false }) === "loc-perm", "R4 iOS no permission");
check(d({ platform: "android", fgGranted: false }) === "loc-perm", "R5 build 78 (no requestPermissions) is never askable");
check(d({ platform: "android", fgGranted: false, carCanRequest: true }) === "loc-perm-ask", "R6");
check(d({ platform: "android", fgGranted: false, carCanRequest: true, askPendingUntil: T + 1 }) === "loc-perm-asking", "R7 ask outstanding");
check(d({ platform: "android", fgGranted: false, carCanRequest: true, askPendingUntil: T }) === "loc-perm-ask", "R8 deadline reached = expired");
check(d({ platform: "android", fgGranted: false, carCanRequest: true, deniedThisSession: true }) === "loc-perm-denied", "R9");
check(d({ fgGranted: false, carCanRequest: true, askPendingUntil: T + 1 }) === "loc-perm", "R10 iOS never asks from the car");
check(d({ token: "missing" }) === "signed-out", "R11");
check(d({ token: "unreadable" }) === "storage-locked", "R12 unreadable is not signed out");
check(d({ fgGranted: false, token: "missing" }) === "loc-perm", "R13 location outranks sign-in");
check(d({ netDown: true }) === "offline", "R14");
check(d({ token: "missing", netDown: true }) === "signed-out", "R15 sign-in outranks offline");
check(d({ netDown: true, hasFix: false }) === "offline", "R16 offline outranks finding");
check(d({ servicesOn: null, fgGranted: null }) === "ok", "R17 failed reads never invent a message");
check(!isSlotStatus("ok") && !isSlotStatus("finding") && !isSlotStatus(undefined) && isSlotStatus("offline") && isSlotStatus("loc-perm"), "R18 slot");
check(isAskableStatus("loc-perm-ask") && isAskableStatus("loc-perm-asking") && isAskableStatus("loc-perm-denied") && !isAskableStatus("loc-perm") && !isAskableStatus(undefined), "R19 askable");
check(d({ platform: "android", fgGranted: false, carCanRequest: true, blocked: true }) === "loc-perm", "R20 permanently denied = no ask (a dead button otherwise)");
check(d({ platform: "android", fgGranted: false, carCanRequest: true, blocked: true, deniedThisSession: true, askPendingUntil: T + 1 }) === "loc-perm", "R21 blocked beats pending/denied");
check(d({ platform: "android", servicesOn: false, fgGranted: false, carCanRequest: true }) === "loc-off", "R22 AA services off is not an ask");

// ── C: the copy ─────────────────────────────────────────────────────────────────────────────────
const ALL: CarStatusCode[] = ["ok", "finding", "loc-off", "loc-perm", "loc-perm-ask", "loc-perm-asking", "loc-perm-denied", "signed-out", "storage-locked", "offline"];
const BANNED_IOS = /\b(i?phone|unlock|settings|open (hairpin|convoy)|pick (it |one )?up)\b/i;
const SAFE = /when (it'?s )?safe/i;
// Word-bounded: "Microphone" is not the phone (the first run of this gate flagged it).
const PHONE = /\bphone\b/i;
// C7: the safety clause must END inside the first 48 characters.
const safeEarly = (s: string) => { const m = SAFE.exec(s); return !!m && m.index + m[0].length <= 48; };
const androidPhoneStrings: string[] = [];
for (const c of ALL) {
  const ios = carStatusCopy(c, "ios");
  const aa = carStatusCopy(c, "android");
  if (c === "ok") { check(ios === null && aa === null, "C0 ok says nothing"); continue; }
  check(!!ios && !!aa, `C1 ${c} has copy on both platforms`);
  for (const s of [ios?.title, ios?.detail, ios?.pill]) if (s) check(!BANNED_IOS.test(s), `C2 guideline 2, iOS ${c}: "${s}"`);
  for (const s of [aa?.title, aa?.detail, aa?.pill]) if (s && PHONE.test(s)) {
    androidPhoneStrings.push(s);
    check(SAFE.test(s), `C3 VI-1, AA ${c}: "${s}"`);
    check(isAskableStatus(c), `C4 AA ${c} mentions the phone outside a permission ask: "${s}"`);
  }
  for (const s of [ios?.pill, aa?.pill]) if (s) check(s.length <= 40, `C5 ${c} pill <= 40 chars: "${s}"`);
}
check(carStatusCopy(undefined, "ios") === null && carStatusCopy(undefined, "android") === null, "C6 undefined says nothing");
// The ask copy names the button the driver must find — it must be the button's real title.
check((carStatusCopy("loc-perm-ask", "android")?.detail ?? "").includes(CAR_ALLOW_LOCATION_TITLE), "C8 ask copy names the real action title");
// iOS maps every ask state to the plain condition (a bug upstream must not leak "check your phone").
for (const c of ["loc-perm-ask", "loc-perm-asking", "loc-perm-denied"] as CarStatusCode[]) {
  check(JSON.stringify(carStatusCopy(c, "ios")) === JSON.stringify(carStatusCopy("loc-perm", "ios")), `C9 iOS ${c} == loc-perm`);
}
// Comms (the car push-to-talk button).
for (const k of ALL_COMMS_KINDS) {
  const ios = commsCopy(k, "ios");
  const aa = commsCopy(k, "android");
  check(!!ios && !!aa, `C10 comms ${k} has copy`);
  check(!BANNED_IOS.test(ios), `C2 guideline 2, iOS comms ${k}: "${ios}"`);
  if (PHONE.test(aa)) {
    androidPhoneStrings.push(aa);
    check(SAFE.test(aa), `C3 VI-1, AA comms ${k}: "${aa}"`);
    check(k === "mic-asking", `C4 AA comms ${k} mentions the phone outside a permission ask: "${aa}"`);
  }
}
check(commsCopy("mic-needed", "ios") !== commsCopy("mic-off", "ios"), "C11 never-asked is not 'off' (review correction 3)");
for (const s of androidPhoneStrings) check(safeEarly(s), `C7 safety clause must end within 48 chars: "${s}"`);
check(androidPhoneStrings.length >= 3, `C12 the VI-1 checks actually ran (${androidPhoneStrings.length} AA phone strings)`);

// ── N: netHealth ────────────────────────────────────────────────────────────────────────────────
__resetNetHealthForTest();
const flips: boolean[] = [];
const off = subscribeNetHealth((x) => { flips.push(x); });
check(!netDown(T), "N1 fresh = up");
noteNetFail(T);
check(!netDown(T + NET_DOWN_AFTER_MS + 1), "N2 one failure is never offline");
noteNetFail(T + 5_000);
check(!netDown(T + 10_000), "N3 two failures inside the window are not offline yet");
check(netDown(T + NET_DOWN_AFTER_MS), "N4 two failures spanning the window = offline");
noteNetFail(T + NET_DOWN_AFTER_MS + 1_000);
check(flips.length === 1 && flips[0] === true, `N5 one flip to down (${JSON.stringify(flips)})`);
noteNetOk(T + 30_000);
check(!netDown(T + 30_000), "N6 a success clears it");
check(flips.length === 2 && flips[1] === false, `N7 one flip back up (${JSON.stringify(flips)})`);
off();
noteNetFail(T + 40_000); noteNetFail(T + 60_000);
check(flips.length === 2, "N8 unsubscribed listener hears nothing");
check(classifyAxiosError({ response: { status: 500 } }) === "reached", "N9 a 500 is not offline");
check(classifyAxiosError({ code: "ECONNABORTED", message: "timeout of 60000ms exceeded" }) === "timeout", "N10 Render cold start is not offline");
check(classifyAxiosError({ code: "ERR_NETWORK", message: "Network Error" }) === "network", "N11");
check(classifyAxiosError({ code: "ERR_CANCELED" }) === "other", "N12 a cancel is not offline");
check(classifyAxiosError(null) === "other", "N13 null error");

if (fails.length) {
  console.error(`car_status_test: ${fails.length} FAIL\n - ${fails.join("\n - ")}`);
  process.exit(1);
}
console.log("car_status_test: all pass");
