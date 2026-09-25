// crew_online_test.mts — the Crew pill turns green while another member is online (Jeff, 2026-09-23: "make the 1 crew
// pill turn green when members are online"). Runs the REAL src/presenceHub.ts against a fake Supabase realtime client
// (crew/stubs/supabase.mjs) whose presence state the test sets:
//   O1 nobody else connected → 0 (neutral pill)
//   O2 another member connected (live or parked) → 1 (green); self never counts; a peer with no position does not count
//   O3 the same member on two devices counts once
//   O4 the member leaves (sync without them) → back to 0, and subscribers are told
//   O5 ghost mode / no community → no topic → 0
//   O6 the count reads the CURRENT community's topic, not a club you just left
// THE PRESENCE BUDGET (2026-09-25 — Supabase shuts a channel at a client's 6th presence update inside 30 s; Jeff chose
// "Keep rule + fix drops"). Fake clock + fake timers; every track/untrack the hub makes is logged by the stub:
//   B0 NEGATIVE CONTROL — a model of the old 1.5 s throttle at 1 Hz: the window checker MUST see a 6th send inside 30 s
//   B1 60 s of 1 Hz movement: ≤ 5 sends and ≤ 4 position tracks in any rolling 30 s window; still ~every 8 s; pill green
//   B2 a live → car-spot source flip while the position budget is spent goes out AT ONCE (the reserved slot)
//   B3 a status flip on a stationary phone (one track() call, no more ticks) is flushed by the timer when a slot frees
//   B4 supabase-js auto-rejoin (SUBSCRIBED again on the SAME channel) after the budget is spent still gets its track
//   B5 two topics (a club switch) share ONE budget
//   B6 leave's untrack counts, and is skipped (not sent over the limit) when the window is full
//   B7 the crew-presence crumb: its format, ≥ 60 s apart (≤ 60/h), and no heartbeat without a topic
// THE BUDGET'S CLOCK (Codex review of 6292ade4): three clocks — the server's window (true elapsed time, stamped by the
// stub), the phone's wall clock (Date.now, corrected mid-run), the hub's elapsed clock (injected):
//   C0 NEGATIVE CONTROL — the hub on the WALL clock: a forward correction lets a 6th send into one server window
//   C1 backward wall corrections (−1 s, −60 s) with the budget spent: nothing extra goes out; the held send flushes on time
//   C2 a forward correction (+60 s) with the budget spent: still held until the SERVER's window frees
//   C3 2 min of 1 Hz movement with corrections every 10 s: never over 5 / 4 in any server window
// THE SHARE-SOURCE FLIP, END TO END (Codex review of 6292ade4) — the budget drops the last fix before a disconnect, the
// disconnect lands on that same fix, then ONLY the live fix moves (walking away) while the shared position stays pinned:
//   H1–H3 the phone: the REAL useConvoyPresence under a minimal hooks model (crew/stubs/react.mjs, React's deps rule)
//   K1–K3 the cold car service: the REAL carDataService (onStoreTick → trackPresence) with its transports stubbed
//   W1 importing convoyPresence wires the crumb writer (logEvent) into the hub
// Run: node --experimental-strip-types tools/sim-qc/crew_online_test.mts

import { register } from "node:module";
register("./crew/loader.mjs", import.meta.url);

const settings: any = await import(new URL("./crew/stubs/settings.mjs", import.meta.url).href);
const sb: any = await import(new URL("./crew/stubs/supabase.mjs", import.meta.url).href);
const hub: any = await import("../../src/presenceHub.ts");

let failed = 0;
const ok = (name: string, cond: boolean, detail = "") => {
  console.log(`  ${cond ? "ok  " : "FAIL"} ${name}${detail ? `  (${detail})` : ""}`);
  if (!cond) failed++;
};

const TOPIC_A = "convoy:community:A";
const TOPIC_B = "convoy:community:B";
settings.__reset({ activeCommunityId: "A" });
ok("O0 the crew topic is the active community's", hub.crewPresenceTopic() === TOPIC_A);

let told = 0;
const off = hub.subscribeOnlineCrew(() => { told++; });
const a = hub.joinPresence({ topic: TOPIC_A, selfId: "me", priority: 2, getPayload: () => null, onPeers: () => {} });

sb.__sync(TOPIC_A, { me: [{ lat: 49.2, lng: -123.1, status: "live" }] });
ok("O1 only me connected → 0 online (neutral)", hub.onlineCrewCount(hub.crewPresenceTopic()) === 0);

sb.__sync(TOPIC_A, {
  me: [{ lat: 49.2, lng: -123.1 }],
  olaf: [{ lat: 49.3, lng: -123.0, status: "live" }],
  noPos: [{ status: "live" }],
});
ok("O2 another member with a position → 1 online (green); self and position-less peers do not count",
  hub.onlineCrewCount(TOPIC_A) === 1);
sb.__sync(TOPIC_A, { me: [{ lat: 1, lng: 1 }], olaf: [{ lat: 49.3, lng: -123.0, status: "parked" }] });
ok("O2b a PARKED member is online too (app connected)", hub.onlineCrewCount(TOPIC_A) === 1);

sb.__sync(TOPIC_A, { olaf: [{ lat: 1, lng: 1 }, { lat: 2, lng: 2 }], rodrigo: [{ lat: 3, lng: 3 }] });
ok("O3 one member on two devices counts once", hub.onlineCrewCount(TOPIC_A) === 2);

const before = told;
sb.__sync(TOPIC_A, { me: [{ lat: 1, lng: 1 }] });
ok("O4 they leave → 0, and subscribers were told", hub.onlineCrewCount(TOPIC_A) === 0 && told > before, `told ${told - before}×`);

settings.__reset({ activeCommunityId: "A", avatarMode: "ghost" });
ok("O5 ghost mode → no topic → 0", hub.crewPresenceTopic() === null && hub.onlineCrewCount(hub.crewPresenceTopic()) === 0);
settings.__reset({});
ok("O5b no community → 0", hub.onlineCrewCount(hub.crewPresenceTopic()) === 0);

// The car service can briefly stay joined to the club you just left: that club's members must not turn the pill green.
sb.__sync(TOPIC_A, { olaf: [{ lat: 1, lng: 1 }] });
const b = hub.joinPresence({ topic: TOPIC_B, selfId: "me", priority: 1, getPayload: () => null, onPeers: () => {} });
sb.__sync(TOPIC_B, { me: [{ lat: 1, lng: 1 }] });
settings.__reset({ activeCommunityId: "B" });
ok("O6 switched to club B: A's online member does not count", hub.onlineCrewCount(hub.crewPresenceTopic()) === 0);

// Codex review of 970fbf32: supabase keeps the last presence state through CHANNEL_ERROR / TIMED_OUT, so a member who
// leaves during the outage stayed green. Offline → nobody; back → only after the next sync says who is there.
settings.__reset({ activeCommunityId: "A" });
sb.__sync(TOPIC_A, { me: [{ lat: 1, lng: 1 }], olaf: [{ lat: 1, lng: 1 }] });
ok("O8 pre: olaf online on A", hub.onlineCrewCount(TOPIC_A) === 1);
const beforeErr = told;
sb.__status(TOPIC_A, "CHANNEL_ERROR");
ok("O8 channel error → 0 at once, and subscribers were told", hub.onlineCrewCount(TOPIC_A) === 0 && told > beforeErr);
sb.__status(TOPIC_A, "TIMED_OUT");
ok("O8b still down → 0", hub.onlineCrewCount(TOPIC_A) === 0);
sb.__status(TOPIC_A, "SUBSCRIBED");
ok("O9 rejoined but not synced → still 0 (the old list is not trusted)", hub.onlineCrewCount(TOPIC_A) === 0);
sb.__sync(TOPIC_A, { me: [{ lat: 1, lng: 1 }] });
ok("O9b first sync: olaf left during the outage → 0", hub.onlineCrewCount(TOPIC_A) === 0);
sb.__sync(TOPIC_A, { me: [{ lat: 1, lng: 1 }], olaf: [{ lat: 1, lng: 1 }] });
ok("O9c olaf back → 1", hub.onlineCrewCount(TOPIC_A) === 1);

const beforeLeave = told;
a.leave();
ok("O7 leaving a topic tells subscribers (the pill re-reads)", told > beforeLeave);
b.leave();
off();

// ═══ THE PRESENCE BUDGET ═══════════════════════════════════════════════════════════════════════════════════════════
const WIN = 30_000;   // Supabase's window — what the checks hold the hub to (the hub keeps a 1 s margin on top)
let NOW = Date.now() + 3_600_000;   // TRUE elapsed time: an hour past anything stamped with the real clock above
let WALL = 0;                        // the phone's wall-clock error — Date.now() = NOW + WALL; C-cases correct it mid-run
Date.now = () => NOW + WALL;
hub.setPresenceClock(() => NOW);     // the hub's elapsed clock (performance.now() in the app) tracks true time
sb.__setClock(() => NOW);            // the server stamps every send on true time
type Timer = { at: number; fn: () => void; id: number };
let timers: Timer[] = [];
let timerId = 0;
(globalThis as any).setTimeout = (fn: () => void, ms = 0) => { const t = { at: NOW + Math.max(0, ms), fn, id: ++timerId }; timers.push(t); return t.id; };
(globalThis as any).clearTimeout = (id: number) => { timers = timers.filter((t) => t.id !== id); };
function advanceTo(target: number): void {
  for (;;) {
    timers.sort((x, y) => x.at - y.at);
    const t = timers[0];
    if (!t || t.at > target) break;
    timers.shift();
    NOW = t.at;
    t.fn();
  }
  NOW = target;
}

type Send = { t: number; topic: string; kind: "track" | "untrack"; payload?: any; chan: any; pos?: boolean };
const identity = (p: any) => JSON.stringify(Object.keys(p ?? {}).filter((k) => !["lat", "lng", "heading", "topSpeed", "online_at"].includes(k)).sort().map((k) => [k, p[k]]));
const resub = new Map<string, number>();   // topic → when the test last re-SUBSCRIBED its channel
/** Position track = same topic, same channel, same identity as the previous track, and no (re)SUBSCRIBE since it. */
function classify(list: Send[]): Send[] {
  const prev = new Map<string, Send>();
  return list.map((x) => {
    if (x.kind !== "track") return { ...x, pos: false };
    const p = prev.get(x.topic);
    const pos = !!p && p.chan === x.chan && identity(p.payload) === identity(x.payload) && !((resub.get(x.topic) ?? -Infinity) > p.t);
    prev.set(x.topic, x);
    return { ...x, pos };
  });
}
/** The worst rolling window: most sends, and most position tracks, inside any [t, t + WIN). */
function worst(list: Send[]): { all: number; pos: number; sixthAfterMs: number | null } {
  let all = 0, pos = 0, sixthAfterMs: number | null = null;
  for (let i = 0; i < list.length; i++) {
    const w = list.filter((x) => x.t >= list[i].t && x.t < list[i].t + WIN);
    all = Math.max(all, w.length);
    pos = Math.max(pos, w.filter((x) => x.pos).length);
    if (sixthAfterMs === null && w.length > 5) sixthAfterMs = w[5].t - list[i].t;
  }
  return { all, pos, sixthAfterMs };
}
const mark = () => sb.sends.length;
/** Sends the hub's own 31 s window holds at true time `now` — to prove a case's precondition ("the budget is spent"). */
const inHubWindow = (now: number) => sb.sends.filter((x: Send) => x.t > now - 31_000 && x.t <= now).length;
const since = (m: number): Send[] => classify(sb.sends.slice(m));

// B0 NEGATIVE CONTROL — the throttle that shipped until today (TRACK_MIN_MS = 1500) modelled at 1 Hz: the checker below
// must flag it, or it could not flag anything. (The real old hub, measured under node by the investigation: 6th at +10.0 s.)
{
  const model: Send[] = [];
  let last = -Infinity;
  for (let t = 0; t < 60_000; t += 1000) if (t - last >= 1500) { model.push({ t, topic: "m", kind: "track", chan: 1, pos: model.length > 0 }); last = t; }
  const w = worst(model);
  ok("B0 NEGATIVE CONTROL: the old 1.5 s throttle puts a 6th send inside 30 s (at +10 s)", w.all > 5 && w.sixthAfterMs === 10_000,
    `worst window ${w.all} sends, 6th at +${w.sixthAfterMs} ms`);
}

// B1 — a driver moving at 1 Hz for 60 s, another member online.
settings.__reset({ activeCommunityId: "A" });
const logs: string[] = [];
hub.setPresenceLogger((m: string) => { logs.push(`${NOW} ${m}`); });
const pay: any = { user_id: "me", handle: "jeff", status: "live", marker: "arrow", src: "live", lat: 49.2, lng: -123.1, heading: 90 };
const m1 = mark();
const t0 = NOW;
const drv = hub.joinPresence({ topic: TOPIC_A, selfId: "me", priority: 2, getPayload: () => ({ ...pay }), onPeers: () => {} });
sb.__sync(TOPIC_A, { me: [{ lat: 1, lng: 1 }], olaf: [{ lat: 49.3, lng: -123.0, status: "live" }] });
let greenAll = true;
for (let i = 1; i <= 60; i++) {
  advanceTo(t0 + i * 1000);
  pay.lat += 0.0003;
  drv.track();
  if (hub.onlineCrewCount(hub.crewPresenceTopic()) !== 1) greenAll = false;
}
{
  const s1 = since(m1);
  const w = worst(s1);
  const posT = s1.filter((x) => x.pos).map((x) => x.t);
  const gaps = posT.slice(1).map((t, i) => t - posT[i]);
  ok("B1 60 s at 1 Hz: no 30 s window holds more than 5 sends or 4 position tracks", w.all <= 5 && w.pos <= 4, `worst ${w.all} sends / ${w.pos} position`);
  ok("B1b positions still flow — one every ~8 s, never a burst", s1.length >= 7 && gaps.every((g) => g >= 7_500 && g <= 9_000),
    `${s1.length} sends, gaps ${gaps.join("/")} ms`);
  ok("B1c the pill held green the whole minute (another member online, channel never shut)", greenAll);
  ok("B1d the post-SUBSCRIBE track went out first", s1[0]?.t === t0 && s1[0]?.pos === false);
}

// B2 — CarPlay unplugged at t0+60: the gate now shares the parked car spot (src 'spot'). The position budget is spent.
ok("B2 pre: shareSrc — published == live fix → 'live'; the gate's car spot (≠ live) or no live fix → 'spot'",
  hub.shareSrc({ lat: 1, lng: 2 }, { lat: 1, lng: 2 }) === "live" && hub.shareSrc({ lat: 1, lng: 2 }, { lat: 1, lng: 2.0001 }) === "spot"
  && hub.shareSrc({ lat: 1, lng: 2 }, null) === "spot");
{
  const m2 = mark();
  const fourIn = inHubWindow(NOW) === 4;
  pay.lat += 0.0003;
  drv.track();
  const spent = fourIn && sb.sends.length === m2;
  pay.src = "spot"; pay.lat = 49.21; pay.lng = -123.11;
  drv.track();
  const s2 = sb.sends.slice(m2);
  ok("B2 position budget spent (4 in the window): a plain position tick is dropped", spent);
  ok("B2b the live → spot flip reaches the channel AT ONCE, in the reserved slot (not ~30 s later)",
    s2.length === 1 && s2[0].t === NOW && s2[0].payload?.src === "spot" && s2[0].payload?.lat === 49.21, `${s2.length} send(s)`);
}

// B3 — standing still, 90 s later the status flips to parked: ONE track() call (the caller's effect), then no ticks.
{
  const tFlip = NOW;
  const m3 = mark();
  pay.status = "parked";
  drv.track();
  const heldAtOnce = inHubWindow(NOW) === 5 && sb.sends.length === m3;
  advanceTo(tFlip + 2_000);
  const heldStill = sb.sends.length === m3;
  advanceTo(tFlip + 5_000);
  const s3 = sb.sends.slice(m3);
  ok("B3 window full (5): the status flip is held, not sent over the limit", heldAtOnce && heldStill);
  ok("B3b …and the flush timer sends it when the oldest send leaves the window, with no further tick",
    s3.length === 1 && s3[0].payload?.status === "parked", `${s3.length} send(s) at +${s3[0] ? s3[0].t - tFlip : "-"} ms`);
}

// B4 — supabase-js auto-rejoins the SAME channel object (CHANNEL_ERROR → SUBSCRIBED) while the window is full.
{
  const chanBefore = sb.channels.get(TOPIC_A);
  // Spend the WHOLE budget: 1 Hz ticks take the four position slots, then an appearance change takes the fifth.
  const tStart = NOW;
  for (let i = 1; i <= 40; i++) { advanceTo(tStart + i * 1000); pay.lng += 0.0003; drv.track(); }
  pay.marker = "class";
  drv.track();
  const full = inHubWindow(NOW) === 5;
  const m4 = mark();
  const tErr = NOW;
  sb.__status(TOPIC_A, "CHANNEL_ERROR");
  const pillOff = hub.onlineCrewCount(TOPIC_A) === 0;
  sb.__status(TOPIC_A, "SUBSCRIBED");
  resub.set(TOPIC_A, NOW);
  const heldAtOnce = sb.sends.length === m4;
  const sameChan = sb.channels.get(TOPIC_A) === chanBefore;
  // Stopped at a light: NO ticks — only the flush timer can deliver it (a moving phone's next tick would too).
  const oldest = sb.sends.filter((x: Send) => x.t > tErr - 31_000)[0].t;
  let sentAt: number | null = null;
  for (let i = 1; i <= 35 && sentAt === null; i++) {
    advanceTo(tErr + i * 1000);
    if (sb.sends.length > m4) sentAt = sb.sends[m4].t;
  }
  const w = worst(since(m4 - 5));
  sb.__sync(TOPIC_A, { me: [{ lat: 1, lng: 1 }], olaf: [{ lat: 49.3, lng: -123.0 }] });
  ok("B4 pre: budget spent (5 in the window); the rejoin is the same channel object; the pill went grey while down",
    full && sameChan && pillOff);
  ok("B4b the rejoin's owed track is held while the window is full, NOT lost: it goes out when a slot frees, never over 5",
    heldAtOnce && sentAt !== null && sentAt > tErr && sentAt - (oldest + 31_000) <= 10 && w.all <= 5,
    `sent at +${sentAt === null ? "never" : sentAt - tErr} ms (the oldest send left the window at +${oldest + 31_000 - tErr}), worst ${w.all}`);
  ok("B4c after the next sync the pill is green again", hub.onlineCrewCount(TOPIC_A) === 1);
}

// B5 — club switch: the car service (priority 1) joins club B while the map still holds club A. ONE budget.
let carSvc: any;
{
  settings.__reset({ activeCommunityId: "B" });
  const m5 = mark();
  const t5 = NOW;
  const pay2: any = { user_id: "me", handle: "jeff", status: "live", src: "live", lat: 49.2, lng: -123.1 };
  carSvc = hub.joinPresence({ topic: TOPIC_B, selfId: "me", priority: 1, getPayload: () => ({ ...pay2 }), onPeers: () => {} });
  pay.status = "live"; pay.src = "live";
  for (let i = 1; i <= 60; i++) {
    advanceTo(t5 + i * 1000);
    pay.lat += 0.0003; pay2.lat += 0.0003;
    drv.track(); carSvc.track();
  }
  const s5 = since(m5);
  const w = worst(since(Math.max(0, m5 - 5)));
  const topics = new Set(s5.map((x) => x.topic));
  ok("B5 two topics share one budget: ≤ 5 sends and ≤ 4 position tracks in any 30 s, across both", w.all <= 5 && w.pos <= 4,
    `worst ${w.all}/${w.pos}; topics sent: ${[...topics].join(", ")}`);
  ok("B5b both topics still get sends", topics.has(TOPIC_A) && topics.has(TOPIC_B));
}

// B6 — untrack counts. Leave B with the window full → no untrack over the limit; after it drains, leaving A untracks.
{
  // Fill the window to 5 with priority sends on A (identity flips), 1 s apart.
  const t6 = NOW;
  for (let i = 1; i <= 5; i++) { advanceTo(t6 + i * 1000); pay.marker = i % 2 ? "class" : "arrow"; drv.track(); }
  const fullAtLeave = inHubWindow(NOW) === 5;
  const m6 = mark();
  carSvc.leave();
  const s6 = sb.sends.slice(m6);
  advanceTo(NOW + 35_000);
  const m6b = mark();
  drv.leave();
  const s6b = sb.sends.slice(m6b);
  const all = since(m1);
  const w = worst(all);
  ok("B6 leaving with the window full (5) sends NO untrack over the limit", fullAtLeave && s6.length === 0, `${s6.length} send(s)`);
  ok("B6b leaving with room sends the untrack", s6b.length === 1 && s6b[0].kind === "untrack");
  ok("B6c the WHOLE run (B1–B6, tracks + untracks, all topics): never more than 5 sends in any 30 s window", w.all <= 5 && w.pos <= 4,
    `${all.length} sends, worst ${w.all}/${w.pos}`);
}

// B7 — the crumb. One simulated hour driving on A with olaf online: ≤ 60 rows, ≥ 60 s apart, the documented format.
{
  settings.__reset({ activeCommunityId: "A" });
  logs.length = 0;
  const t7 = NOW;
  const d2 = hub.joinPresence({ topic: TOPIC_A, selfId: "me", priority: 2, getPayload: () => ({ ...pay }), onPeers: () => {} });
  sb.__sync(TOPIC_A, { me: [{ lat: 1, lng: 1 }], olaf: [{ lat: 49.3, lng: -123.0 }] });
  for (let i = 1; i <= 3600; i++) { advanceTo(t7 + i * 1000); pay.lat += 0.00001; d2.track(); }
  const at = logs.map((l) => Number(l.split(" ")[0]));
  const spacingOk = at.slice(1).every((t, i) => t - at[i] >= 60_000);
  const re = /^crew-presence live=[01] greyMs=\d+ drops=\d+ maxN=\d+ topic=[01] ghost=[01] sent=\d+ dropped=\d+$/;
  const fmtOk = logs.every((l) => re.test(l.slice(l.indexOf(" ") + 1)));
  const last = logs[logs.length - 1] ?? "";
  ok("B7 an hour of driving: ≤ 60 crumbs, each ≥ 60 s after the last", logs.length >= 55 && logs.length <= 60 && spacingOk, `${logs.length} crumbs`);
  ok("B7b the format is exactly crew-presence live= greyMs= drops= maxN= topic= ghost= sent= dropped=", fmtOk, last.slice(last.indexOf(" ") + 1));
  ok("B7c a steady drive reads live=1 greyMs=0 drops=0 maxN=1 topic=1 and ~8 sends a minute",
    /live=1 greyMs=0 drops=0 maxN=1 topic=1 ghost=0 sent=[78] /.test(last), last.slice(last.indexOf(" ") + 1));
  d2.leave();
  // No club, nothing moving: after one row that records the change, the heartbeat stops.
  settings.__reset({});
  logs.length = 0;
  const idle = hub.joinPresence({ topic: "convoy:community:Z", selfId: "me", priority: 1, getPayload: () => null, onPeers: () => {} });
  const t8 = NOW;
  for (let i = 1; i <= 5; i++) { advanceTo(t8 + i * 61_000); sb.__sync("convoy:community:Z", { me: [{ lat: 1, lng: 1 }] }); }
  ok("B7d no crew topic and nothing changing: at most one crumb (the change), then no heartbeat", logs.length <= 1, `${logs.length} crumb(s): ${logs.join(" | ")}`);
  idle.leave();
}

// ═══ THE BUDGET'S CLOCK ═════════════════════════════════════════════════════════════════════════════════════════════
const drain = () => advanceTo(NOW + 40_000);   // everything leaves every window (hub 31 s, server 30 s)
/** A presence join on its own topic whose next send is an IDENTITY change (a priority send) on demand. */
function priorityDriver(topic: string) {
  const p: any = { user_id: "me", handle: "jeff", status: "live", marker: "arrow", src: "live", lat: 49.2, lng: -123.1 };
  const h = hub.joinPresence({ topic, selfId: "me", priority: 2, getPayload: () => ({ ...p }), onPeers: () => {} });
  let flip = 0;
  return {
    h, p,
    // A NEW appearance every call (A→B→A would net to "no change", which the hub rightly does not send).
    identity() { p.cls = `cls${++flip}`; h.track(); },
    move() { p.lat += 0.0003; h.track(); },
  };
}
/** Five priority sends 1 s apart → the window is full (true time). */
function fillFive(d: ReturnType<typeof priorityDriver>, from: number): void {
  for (let i = 1; i <= 5; i++) { advanceTo(from + i * 1000); d.identity(); }
}

// C0 NEGATIVE CONTROL — the budget on the phone's WALL clock (what 6292ade4 did): a +60 s correction expires the window
// early and a 6th send lands inside one server window. The checker must see it.
{
  drain();
  hub.setPresenceClock(() => Date.now());
  const d = priorityDriver("convoy:community:C0");
  drain();
  const m = mark();
  const t = NOW;
  fillFive(d, t);
  WALL += 60_000;
  d.identity();
  const w = worst(since(m));
  ok("C0 NEGATIVE CONTROL: on the wall clock, a +60 s correction lets a 6th send into one 30 s server window", w.all > 5, `worst ${w.all}`);
  d.h.leave();
  WALL = 0;
  drain();
  hub.setPresenceClock(() => NOW);
  drain();
}

// C1 — backward corrections with the budget spent.
{
  drain();
  const d = priorityDriver("convoy:community:C1");
  drain();
  const m = mark();
  const t = NOW;
  fillFive(d, t);
  const full = inHubWindow(NOW) === 5;
  WALL -= 1_000;
  d.identity();
  const heldA = sb.sends.length === m + 5;
  advanceTo(NOW + 500);
  WALL -= 60_000;
  d.identity();
  d.move();
  const heldB = sb.sends.length === m + 5;
  // Stationary from here: only the flush timer can send the held change.
  const freeAt = sb.sends[m].t + 31_000;
  advanceTo(freeAt + 1_000);
  const s = since(m);
  const w = worst(s);
  ok("C1 budget spent, wall clock stepped back 1 s then 60 s: nothing extra goes out", full && heldA && heldB);
  ok("C1b the held change is flushed when the oldest send leaves the window on TRUE time, never over 5",
    s.length === 6 && Math.abs(s[5].t - freeAt) <= 10 && w.all <= 5, `${s.length} sends, 6th at ${s[5] ? s[5].t - freeAt : "-"} ms from the true free time, worst ${w.all}`);
  d.h.leave();
  WALL = 0;
}

// C2 — a forward correction with the budget spent.
{
  drain();
  const d = priorityDriver("convoy:community:C2");
  drain();
  const m = mark();
  const t = NOW;
  fillFive(d, t);
  WALL += 60_000;
  d.identity();
  d.move();
  const held = sb.sends.length === m + 5;
  const freeAt = sb.sends[m].t + 31_000;
  advanceTo(freeAt - 1_000);
  const stillHeld = sb.sends.length === m + 5;
  advanceTo(freeAt + 1_000);
  const s = since(m);
  const w = worst(s);
  ok("C2 wall clock jumped +60 s with the budget spent: held until the SERVER's window frees, never over 5",
    held && stillHeld && s.length === 6 && w.all <= 5, `${s.length} sends, worst ${w.all}`);
  d.h.leave();
  WALL = 0;
}

// C3 — two minutes of 1 Hz movement while the wall clock is corrected every 10 s.
{
  drain();
  const d = priorityDriver("convoy:community:C3");
  const m = mark();
  const t = NOW;
  const steps = [-1_000, +60_000, -60_000, +1_000, -30_000, +90_000];
  for (let i = 1; i <= 120; i++) {
    advanceTo(t + i * 1000);
    if (i % 10 === 0) WALL += steps[(i / 10) % steps.length];
    if (i % 25 === 0) d.identity(); else d.move();
  }
  const s = since(m);
  const w = worst(s);
  ok("C3 2 min at 1 Hz with wall corrections every 10 s: never over 5 sends / 4 position tracks per server window, still ~8 s cadence",
    w.all <= 5 && w.pos <= 4 && s.length >= 14, `${s.length} sends, worst ${w.all}/${w.pos}`);
  d.h.leave();
  WALL = 0;
}

// ═══ THE SHARE-SOURCE FLIP, END TO END ══════════════════════════════════════════════════════════════════════════════
const R: any = await import(new URL("./crew/stubs/react.mjs", import.meta.url).href);
const bc: any = await import(new URL("./crew/stubs/crashBreadcrumb.mjs", import.meta.url).href);
const cp: any = await import("../../src/convoyPresence.ts");

// H — the phone map's hook. Drive 20 s at 1 Hz, the budget drops the last fix; CarPlay unplugs ON that fix (the gate now
// shares the car spot, which IS that fix); then the driver walks away: only the live fix moves.
{
  drain();
  settings.__reset({ activeCommunityId: "H" });
  const TOPIC_H = "convoy:community:H";
  const me = { user_id: "me", handle: "jeff", status: "live", marker: "arrow" };
  const inst = R.__mount((ch: string, m: any, c: any, l: any) => cp.useConvoyPresence(ch, m, c, l));
  let P = { lat: 49.2, lng: -123.1, heading: 90 };
  const mH = mark();
  const tH = NOW;
  R.__render(inst, TOPIC_H, me, P, { lat: P.lat, lng: P.lng });
  sb.__sync(TOPIC_H, { me: [{ lat: 1, lng: 1 }], olaf: [{ lat: 49.3, lng: -123.0 }] });
  for (let i = 1; i <= 20; i++) {
    advanceTo(tH + i * 1000);
    P = { ...P, lat: P.lat + 0.0003 };
    R.__render(inst, TOPIC_H, me, P, { lat: P.lat, lng: P.lng });
  }
  const last = { ...P };
  const drove = sb.sends.slice(mH);
  const finalDropped = drove.length > 0 && drove[drove.length - 1].payload?.lat !== last.lat;
  // Unplugged at t+21, standing on the last fix: the gate's spot == the live fix, published unchanged.
  advanceTo(tH + 21_000);
  R.__render(inst, TOPIC_H, me, last, { lat: last.lat, lng: last.lng });
  const mW = mark();
  // Walking away: the published position stays pinned on the spot; only the live fix moves.
  for (let k = 1; k <= 9; k++) {
    advanceTo(tH + 21_000 + k * 1000);
    R.__render(inst, TOPIC_H, me, last, { lat: last.lat + k * 0.00002, lng: last.lng });
  }
  const walk = sb.sends.slice(mW);
  ok("H1 pre: the budget dropped the final driving fix (the crew hold an older position)", finalDropped,
    `last sent lat ${drove[drove.length - 1]?.payload?.lat} vs final ${last.lat}`);
  ok("H2 the first walking fix alone (shared position pinned) sends the car spot at once — src 'spot', the reserved slot",
    walk.length >= 1 && walk[0].t === tH + 22_000 && walk[0].payload?.src === "spot" && walk[0].payload?.lat === last.lat,
    walk.length ? `sent +${walk[0].t - tH} ms src=${walk[0].payload?.src} lat=${walk[0].payload?.lat}` : "nothing sent while walking");
  ok("H3 …and only once: the rest of the walk sends nothing (the pinned spot does not re-send)", walk.length === 1, `${walk.length} send(s)`);
  R.__unmount(inst);
}

// W1 — the phone's import of convoyPresence wired logEvent as the hub's crumb writer.
{
  const before = bc.rows.length;
  const d = priorityDriver("convoy:community:W");
  settings.__reset({ activeCommunityId: "W" });
  for (let i = 1; i <= 70; i++) { advanceTo(NOW + 1000); d.move(); }
  const got = bc.rows.slice(before).filter((r: string) => r.startsWith("crew-presence "));
  ok("W1 importing convoyPresence wires crashBreadcrumb.logEvent: crew-presence rows reach it", got.length >= 1, got[0] ?? "none");
  d.h.leave();
}

// K — the cold car service (no phone map): same drive, same unplug on the dropped fix, same walk. Its trigger is the
// LIVE fix in carStore (onStoreTick), not the published position — so the walk reaches trackPresence.
{
  drain();
  settings.__reset({ activeCommunityId: "K" });
  const cs: any = await import(new URL("./crew/stubs/carStore.mjs", import.meta.url).href);
  const lp: any = await import(new URL("./crew/stubs/locationPrivacy.mjs", import.meta.url).href);
  const cds: any = await import("../../src/carplay/carDataService.ts");
  const settle = async () => { for (let i = 0; i < 10; i++) await new Promise((r) => setImmediate(r)); };
  lp.__set({ mode: "live", status: "live", spot: null });
  let lat = 49.4;
  const lng = -123.3;
  cs.__set({ selfLat: lat, selfLng: lng, speedMs: 20 });
  const mK = mark();
  const tK = NOW;
  cds.startCarDataService();
  await settle();
  const joined = sb.sends.length > mK && sb.sends[mK].topic === "convoy:community:K";
  for (let i = 1; i <= 20; i++) {
    advanceTo(tK + i * 1000);
    lat += 0.0003;
    cs.__set({ selfLat: lat });
  }
  const drove = sb.sends.slice(mK);
  const finalDropped = drove[drove.length - 1]?.payload?.lat !== lat;
  advanceTo(tK + 21_000);
  lp.__set({ mode: "spot", spot: { lat, lng } });   // unplugged ON the last fix: no store write, no tick
  const mW = mark();
  for (let k = 1; k <= 9; k++) {
    advanceTo(tK + 21_000 + k * 1000);
    cs.__set({ selfLat: lat + k * 0.00002 });
  }
  const walk = sb.sends.slice(mW);
  ok("K1 pre: the cold service joined and broadcast; the budget dropped its final driving fix", joined && finalDropped,
    `last sent lat ${drove[drove.length - 1]?.payload?.lat} vs final ${lat}`);
  ok("K2 the first walking fix (live only) sends the car spot at once — src 'spot'",
    walk.length >= 1 && walk[0].t === tK + 22_000 && walk[0].payload?.src === "spot" && walk[0].payload?.lat === lat,
    walk.length ? `sent +${walk[0].t - tK} ms src=${walk[0].payload?.src} lat=${walk[0].payload?.lat}` : "nothing sent while walking");
  ok("K3 …and only once", walk.length === 1, `${walk.length} send(s)`);
  cds.stopCarDataService();
}

console.log(failed ? `\nFAIL crew_online (${failed})` : "\nPASS crew_online");
process.exit(failed ? 1 : 0);
