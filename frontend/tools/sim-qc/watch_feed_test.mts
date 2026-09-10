// tools/sim-qc/watch_feed_test.mts — the payload the phone pushes to the wrist: shape,
// on-change throttle (≤ 2 Hz, but nav on/off and a step change go through immediately),
// and the stale rule the watch applies ("Waiting for phone" after 30 s).
import { buildWatchPayload, shouldSendWatch, isWatchStale, WATCH_SEND_MIN_GAP_MS, WATCH_STALE_MS } from "../../src/watchFeed.ts";

let fails = 0;
const ok = (name: string, cond: boolean, detail = "") => {
  if (!cond) { fails++; console.log(`  FAIL ${name} ${detail}`); } else console.log(`  ok   ${name} ${detail}`);
};
const base = { navigating: true, maneuverIcon: "↰", instruction: "Turn left onto King Rd", distanceToTurnM: 212.4, maneuverKey: "turn|left", etaSeconds: 840, stepIdx: 4, peersLive: 3 };

const p = buildWatchPayload(base, 1000);
ok("A1 shape", p.v === 1 && p.nav.on && p.nav.glyph === "↰" && p.nav.street === "Turn left onto King Rd" && p.nav.side === "left" && p.nav.stepIdx === 4 && p.crew.live === 3 && p.at === 1000, JSON.stringify(p));
ok("A2 distance rounded to whole metres", p.nav.distM === 212);
ok("A3 eta integer seconds", p.nav.etaS === 840);
const off = buildWatchPayload({ ...base, navigating: false }, 2000);
ok("A4 nav off → empty card fields", !off.nav.on && off.nav.street === "" && off.nav.distM === 0 && off.nav.side === "generic");
ok("A5 missing eta/glyph tolerated", buildWatchPayload({ ...base, etaSeconds: undefined, maneuverIcon: undefined }, 0).nav.glyph === "" );

// throttle
ok("B1 first send always", shouldSendWatch(null, p, -Infinity));
const p2 = buildWatchPayload({ ...base, distanceToTurnM: 205 }, 1200);
ok("B2 same step, 200 ms later → held", !shouldSendWatch(p, p2, 1000));
const p3 = buildWatchPayload({ ...base, distanceToTurnM: 190 }, 1600);
ok("B3 same step, 600 ms later → sent", shouldSendWatch(p, p3, 1000));
const p4 = buildWatchPayload({ ...base, stepIdx: 5, distanceToTurnM: 900 }, 1100);
ok("B4 step change → sent immediately", shouldSendWatch(p, p4, 1000));
const p5 = buildWatchPayload({ ...base, navigating: false }, 1100);
ok("B5 nav off → sent immediately", shouldSendWatch(p, p5, 1000));
const p6 = buildWatchPayload(base, 5000);
ok("B6 nothing changed but time → held (no heartbeat spam)", !shouldSendWatch(p, p6, 1000));
const p7 = buildWatchPayload({ ...base, peersLive: 4 }, 1100);
ok("B7 crew count change → sent (complication)", shouldSendWatch(p, p7, 1000));

// stale
ok("C1 fresh", !isWatchStale(10_000, 10_000 + WATCH_STALE_MS - 1));
ok("C2 stale at 30 s", isWatchStale(10_000, 10_000 + WATCH_STALE_MS));
ok("C3 at=0 is stale", isWatchStale(0, 5));
ok("gap constant is 500 ms", WATCH_SEND_MIN_GAP_MS === 500);
console.log(fails === 0 ? "\nPASS watch_feed" : `\nFAIL watch_feed (${fails})`);
if (fails) process.exit(1);
