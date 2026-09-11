// crew_widget_test — the crew ring row of the iOS 27 full-page widget.
//
// Gates src/crewWidgetRule.ts: the order the five ring slots read in, what counts as
// "live" in the header pill, when a republish is worth waking WidgetKit for, and when
// the expensive Mapbox snapshot may run. The widget itself is compile-gated behind an
// iOS 27 SDK (see targets/widget/index.swift), so these are the ONLY assertions that
// can run today — none of this can be checked on a device until an Xcode 27 EAS image
// exists. Keep them honest.
import {
  crewPayload, shouldPublishCrew, shouldSnapshotMap, crewIsFresh, leaveByIsShowable,
  haversineKm, CREW_MAX, CREW_MIN_MS, MAP_MIN_MS, CREW_STALE_MS, LEAVE_GRACE_MS,
  type CrewPeer,
} from "../../src/crewWidgetRule.ts";

let fails = 0;
const ok = (name: string, cond: boolean, detail = "") => {
  if (!cond) { fails++; console.log(`  FAIL ${name} ${detail}`); } else console.log(`  ok   ${name} ${detail}`);
};

const ME = { lat: 49.0475, lng: -122.2925 };           // Abbotsford, where Jeff drives
/** A peer `km` north of ME. */
const at = (handle: string, km: number, extra: Partial<CrewPeer> = {}): CrewPeer => ({
  handle, status: "live", lat: ME.lat + km / 111.32, lng: ME.lng, ...extra,
});

// ── A · ordering ──────────────────────────────────────────────────────────────
{
  const p = crewPayload([
    at("far-live", 40),
    at("parked-near", 1, { status: "parked" }),
    at("driving-far", 30, { navigating: true }),
    at("near-live", 2),
  ], ME);
  ok("A1 driving sorts first", p.members[0].h === "driving-far");
  ok("A2 then live, nearest first", p.members[1].h === "near-live" && p.members[2].h === "far-live");
  ok("A3 parked sorts last even when nearest", p.members[3].h === "parked-near");
  ok("A4 statuses map through", p.members.map(m => m.s).join(",") === "driving,live,live,parked");
}
{
  // Equal inputs must never reorder between ticks or the row flickers.
  const peers = [at("bravo", 5), at("alpha", 5), at("charlie", 5)];
  const a = crewPayload(peers, ME).sig;
  const b = crewPayload([...peers].reverse(), ME).sig;
  ok("A5 ties break on handle, so the order is stable", a === b, a);
}

// ── B · shaping ───────────────────────────────────────────────────────────────
{
  const many = Array.from({ length: 9 }, (_, i) => at(`crew${i}`, i + 1));
  const p = crewPayload(many, ME);
  ok(`B1 capped at ${CREW_MAX} ring slots`, p.members.length === CREW_MAX, `got ${p.members.length}`);
  ok("B2 the nearest five survive the cap", p.members[0].h === "crew0" && p.members[4].h === "crew4");
}
{
  const p = crewPayload([at("x", 3), { handle: "  ", status: "live" }, { status: "live" } as CrewPeer], ME);
  ok("B3 handle-less peers are dropped", p.members.length === 1 && p.members[0].h === "x");
}
{
  const p = crewPayload([at("verylonghandlename", 3)], ME);
  ok("B4 handles are clamped to 12 chars", p.members[0].h.length === 12, p.members[0].h);
}
{
  const p = crewPayload([at("a", 2.34)], ME);
  ok("B5 distance rounds to 0.1 km", p.members[0].km === 2.3, String(p.members[0].km));
  const noMe = crewPayload([at("a", 2.34)], null);
  ok("B6 no self position -> no km, not a wrong km", noMe.members[0].km === undefined);
  const noCoords = crewPayload([{ handle: "a", status: "live" }], ME);
  ok("B7 a peer with no position -> no km", noCoords.members[0].km === undefined);
}
{
  const p = crewPayload([at("g", 1, { tier: "gold" }), at("s", 2, { tier: "silver" }), at("n", 3, { tier: null })], ME);
  ok("B8 tiers pass through for the outer ring",
     p.members[0].tier === "gold" && p.members[1].tier === "silver" && p.members[2].tier === undefined);
  const bogus = crewPayload([at("b", 1, { tier: "bronze" as any })], ME);
  ok("B9 an unknown tier is dropped, never forwarded", bogus.members[0].tier === undefined);
}

// ── C · the LIVE pill ─────────────────────────────────────────────────────────
{
  const p = crewPayload([at("a", 1), at("b", 2, { status: "parked" }), at("c", 3, { navigating: true })], ME);
  ok("C1 the pill counts everyone NOT parked", p.live === 2, `live=${p.live}`);
  ok("C2 an all-parked crew reads 0 live", crewPayload([at("a", 1, { status: "parked" })], ME).live === 0);
  ok("C3 an empty crew reads 0 live and 0 members",
     crewPayload([], ME).live === 0 && crewPayload(null, ME).members.length === 0);
}

// ── D · republish throttle ────────────────────────────────────────────────────
{
  const sig = "a:live:1|b:live:2";
  ok("D1 below the floor never publishes", shouldPublishCrew(1000, 0, "", sig, CREW_MIN_MS) === false);
  ok("D2 past the floor with a new signature publishes",
     shouldPublishCrew(CREW_MIN_MS + 1, 0, "", sig) === true);
  ok("D3 past the floor with the SAME signature does not wake WidgetKit",
     shouldPublishCrew(CREW_MIN_MS + 1, 0, sig, sig) === false);
  ok("D4 a status flip alone is enough to publish",
     shouldPublishCrew(CREW_MIN_MS + 1, 0, "a:live:1", "a:parked:1") === true);
  ok("D5 a distance change past 0.1 km publishes",
     shouldPublishCrew(CREW_MIN_MS + 1, 0, "a:live:1", "a:live:1.1") === true);
}

// ── E · snapshot gate (the expensive one) ─────────────────────────────────────
{
  const base = { now: MAP_MIN_MS + 1, lastAt: 0, busy: false, navActive: false, appActive: true, hasCenter: true };
  ok("E1 foreground, idle, past the floor -> snapshot", shouldSnapshotMap(base) === true);
  ok("E2 NEVER while navigating", shouldSnapshotMap({ ...base, navActive: true }) === false);
  ok("E3 never while backgrounded", shouldSnapshotMap({ ...base, appActive: false }) === false);
  ok("E4 never without a centre", shouldSnapshotMap({ ...base, hasCenter: false }) === false);
  ok("E5 never re-entrant", shouldSnapshotMap({ ...base, busy: true }) === false);
  ok("E6 below the floor -> no", shouldSnapshotMap({ ...base, now: MAP_MIN_MS - 1 }) === false);
  ok("E7 the snapshot floor is far slacker than the JSON floor", MAP_MIN_MS >= 5 * CREW_MIN_MS);
}

// ── F · staleness ─────────────────────────────────────────────────────────────
{
  const now = 1_800_000_000_000;
  ok("F1 fresh crew shows", crewIsFresh(now, now - 60_000) === true);
  ok("F2 crew older than the window is treated as absent",
     crewIsFresh(now, now - CREW_STALE_MS - 1) === false);
  ok("F3 a never-written crew is absent", crewIsFresh(now, 0) === false);
  ok("F4 leave-by ahead of us shows", leaveByIsShowable(now, now + 60_000) === true);
  ok("F5 leave-by inside the grace still shows", leaveByIsShowable(now, now - LEAVE_GRACE_MS + 1_000) === true);
  ok("F6 leave-by past the grace is cleared", leaveByIsShowable(now, now - LEAVE_GRACE_MS - 1) === false);
  ok("F7 a missing leave-by is cleared", leaveByIsShowable(now, null) === false && leaveByIsShowable(now, 0) === false);
}

// ── G · distance sanity (the km the ring row prints) ──────────────────────────
{
  // 1 degree of latitude is ~111.32 km; the Marshall Rd / Sevenoaks pair from the
  // self-lift sim work is ~2.6 km apart.
  ok("G1 one degree of latitude is ~111.3 km",
     Math.abs(haversineKm(49, -122, 50, -122) - 111.19) < 0.5);
  ok("G2 identical points are 0 km", haversineKm(49.0475, -122.2925, 49.0475, -122.2925) === 0);
  const d = haversineKm(49.039116, -122.2929338, 49.050387, -122.32475);
  ok("G3 Marshall Rd -> Sevenoaks lot is ~2.6 km", d > 2.2 && d < 3.0, d.toFixed(2) + " km");
}

console.log(fails === 0 ? "\nPASS crew_widget" : `\nFAIL crew_widget (${fails})`);
if (fails) process.exit(1);
