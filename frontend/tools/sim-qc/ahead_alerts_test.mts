// ahead_alerts_test — the ahead-alerts decision: what an OSM `maxspeed:conditional` means, when a
// school or playground zone is actually live, how far ahead we call a thing out, and whether a
// point is on the road in front of the car (src/aheadAlertRules.ts).
//
//   node --experimental-strip-types tools/sim-qc/ahead_alerts_test.mts
//
// Jeff, 2026-09-21: "Yes build them and stage 2 for 80. Make the chime the same as the speed ding
// but 1 ding. Give the speed cameras and playground/school zones a good heads up for distance and
// time."
//
// EVERY tag string below is REAL — pulled live from Overpass on 2026-09-21 over Jeff's corridor
// (bbox 49.00,-123.05,49.30,-122.20): 363 ways carrying `maxspeed:conditional` in 34 distinct
// spellings. The counts in the comments are that query's, not estimates. The junk fixture
// ('r 08:00-17:00)') is a real tag too — one way in the corridor carries it truncated.
//
// src/aheadAlertRules.ts imports NOTHING, so this gate needs no stub harness (contrast
// uturn_rank_test.mts, which has to fake out react-native) and no explicit process.exit for a
// timer pump — but it still exits explicitly on failure so the shell sees a non-zero status.
const R = await import("../../src/aheadAlertRules.ts");

let fails = 0;
const ok = (name: string, cond: boolean, detail = "") => { console.log(`${cond ? "  ok  " : "  FAIL"} ${name} ${detail}`); if (!cond) fails++; };

// ─── 1 · THE PARSER, against the real corridor strings ───────────────────────────────────────
console.log("Parsing maxspeed:conditional — the 34 spellings that actually exist");
const P = R.parseMaxspeedConditional;

// The 71-count majority form and the 54/51/24-count school forms.
{
  const c = P("30 @ (sunrise-sunset)")!;
  ok("P1  '30 @ (sunrise-sunset)' (71 ways) → playground, 30, daytime",
    c.kind === "playground" && c.limitKmh === 30 && c.window.type === "daylight" && !c.window.night && !c.window.civil);
}
{
  const c = P("30 @ (Mo-Fr 08:00-17:00; PH off; SH off)")!;
  ok("P2  '… (Mo-Fr 08:00-17:00; PH off; SH off)' (54 ways) → school 08:00-17:00, weekdays",
    c.kind === "school" && c.limitKmh === 30 && c.window.type === "clock" &&
    c.window.weekdaysOnly && c.window.startMin === 480 && c.window.endMin === 1020,
    JSON.stringify(c.window));
}
{
  const c = P("30 @ (Mo-Fr 07:00-22:00; SH off; PH off)")!;
  ok("P3  Burnaby's 07:00-22:00 form (24 ways) keeps its own hours",
    c.kind === "school" && c.window.type === "clock" && c.window.startMin === 420 && c.window.endMin === 1320);
}
// The inverted playground tags — the ones that state the NIGHT limit.
{
  const c = P("50 @ (dusk-dawn)")!;
  ok("P4  '50 @ (dusk-dawn)' (11 ways) → playground, night:true, civil twilight",
    c.kind === "playground" && c.limitKmh === 50 && c.window.type === "daylight" && c.window.night && c.window.civil);
}
{
  const c = P("50 @ (sunset-sunrise)")!;
  ok("P5  '50 @ (sunset-sunrise)' (10 ways) → playground, night:true, geometric",
    c.kind === "playground" && c.window.type === "daylight" && c.window.night && !c.window.civil);
}
ok("P6  '30 @ (dawn-dusk)' (11 ways) is NOT inverted",
  P("30 @ (dawn-dusk)")!.window.type === "daylight" && !(P("30 @ (dawn-dusk)")!.window as any).night);

// The non-canonical forms. These are the ones that break a naive `NN @ (…)` regex.
console.log("\nThe non-canonical forms (18 of the corridor's ways are one of these)");
{
  const c = P('30 @ "school days":0800-1700')!;
  ok("N1  quoted school days, colon separator, no parens, HHMM clock",
    c.kind === "school" && c.limitKmh === 30 && c.window.type === "clock" &&
    c.window.startMin === 480 && c.window.endMin === 1020 && c.window.schoolDays, JSON.stringify(c.window));
}
{
  const c = P("Mo-Fr 30 @ (08:00-17:00)")!;
  ok("N2  the NUMBER COMES AFTER the day spec — and Mo-Fr must survive",
    c.kind === "school" && c.limitKmh === 30 && c.window.type === "clock" && c.window.weekdaysOnly,
    JSON.stringify(c.window));
}
{
  const c = P("30 (Mo-Fr 08:00-17:00; PH SH off)")!;
  ok("N3  no '@' at all, parens only", c.kind === "school" && c.limitKmh === 30 && (c.window as any).weekdaysOnly);
}
ok("N4  '30 (dawn-dusk)' — no '@', daylight", P("30 (dawn-dusk)")!.kind === "playground");
ok("N5  '30 @ dawn to dusk' — the word 'to'", P("30 @ dawn to dusk")!.kind === "playground");
ok("N6  '30 @ (sunrise-sunset).' — trailing full stop", P("30 @ (sunrise-sunset).")!.kind === "playground");
ok("N7  '30 @ (School Days 08:00-17:00)' — capitalised, unquoted",
  P("30 @ (School Days 08:00-17:00)")!.kind === "school");
ok("N8  '30 @ (08:00 - 17:00)' — spaces round the dash",
  (P("30 @ (08:00 - 17:00)")!.window as any).startMin === 480);
ok("N9  '30 @ (Mo-Fr 0800-1700; PH off; Sep-Jun)' — HHMM plus a month range",
  P("30 @ (Mo-Fr 0800-1700; PH off; Sep-Jun)")!.kind === "school");
{
  // `;` is BOTH the rule separator and the separator inside the parens. Splitting naively here
  // would leave '30 @ ("school days":0800-1700' and lose the clock.
  const c = P('30 @ "school days":0800-1700;30 @ dawn-dusk')!;
  ok("N10 two rules in one tag → take the FIRST, do not double-announce one zone",
    c.kind === "school" && (c.window as any).startMin === 480, JSON.stringify(c.window));
}
ok("N11 '30 @ (Mo-Fr 08:00-17:00; SH off)' is not split by the inner ';'",
  (P("30 @ (Mo-Fr 08:00-17:00; SH off)")!.window as any).endMin === 1020);

console.log("\nJunk and out-of-scope tags are SKIPPED, never thrown and never announced");
ok("J1  'r 08:00-17:00)' (a real truncated tag) → null", P("r 08:00-17:00)") === null);
ok("J2  undefined → null", P(undefined) === null);
ok("J3  '' → null", P("") === null);
ok("J4  'CA:urban' (an implicit code) → null", P("CA:urban") === null);
ok("J5  '60 @ (23:00-05:00)' is a real tag but NOT a zone → kind 'other'",
  P("60 @ (23:00-05:00)")!.kind === "other");
ok("J6  '30 @ (Mo-Fr 00:00-24:00; PH off; SH off)' parses without a degenerate window",
  (P("30 @ (Mo-Fr 00:00-24:00; PH off; SH off)")!.window as any).endMin === 1440);
ok("J7  an mph conditional converts", P("20 mph @ (Mo-Fr 08:00-17:00)")!.limitKmh === 32);

// ─── 2 · SUN TIMES, cross-checked against an independent NOAA implementation ─────────────────
// The reference figures below were computed 2026-09-21 by a separate NOAA-spreadsheet
// implementation in Python for Vancouver (49.2827,-123.1207) and agreed with this module to
// within 82 seconds on every date. Playground zones are the one half of this feature that can be
// exactly right, so it is pinned.
console.log("\nSun times (Vancouver 49.2827,-123.1207) — within 3 min of the NOAA reference");
const refs: [string, string, string][] = [
  ["2026-09-21", "13:57", "02:14"],   // rise UTC, set UTC (next day for the set)
  ["2026-06-21", "12:06", "04:21"],
  ["2026-12-21", "16:04", "00:15"],
];
for (const [day, wantRise, wantSet] of refs) {
  const t = R.sunTimesMs(Date.parse(day + "T20:00:00Z"), 49.2827, -123.1207, R.ALT_SUNRISE_DEG)!;
  const hm = (ms: number) => new Date(ms).toISOString().slice(11, 16);
  const mins = (s: string) => Number(s.slice(0, 2)) * 60 + Number(s.slice(3, 5));
  const dr = Math.abs(mins(hm(t.rise)) - mins(wantRise));
  const ds = Math.abs(mins(hm(t.set)) - mins(wantSet));
  ok(`S:${day} rise ${hm(t.rise)}Z (ref ${wantRise}Z), set ${hm(t.set)}Z (ref ${wantSet}Z)`, dr <= 3 && ds <= 3);
}
ok("S1  polar night returns null, not a guess",
  R.sunTimesMs(Date.parse("2026-12-21T12:00:00Z"), 78.22, 15.63, R.ALT_SUNRISE_DEG) === null);
ok("S2  noon PDT in Vancouver is daylight",
  R.isDaylight(Date.parse("2026-09-21T19:00:00Z"), 49.2827, -123.1207, R.ALT_SUNRISE_DEG));
ok("S3  23:00 PDT is not",
  !R.isDaylight(Date.parse("2026-09-22T06:00:00Z"), 49.2827, -123.1207, R.ALT_SUNRISE_DEG));
ok("S4  civil dawn is EARLIER than sunrise (the tags mean different things by them)",
  R.sunTimesMs(Date.parse("2026-09-21T20:00:00Z"), 49.2827, -123.1207, R.ALT_CIVIL_DEG)!.rise <
  R.sunTimesMs(Date.parse("2026-09-21T20:00:00Z"), 49.2827, -123.1207, R.ALT_SUNRISE_DEG)!.rise);

// ─── 3 · THE BC SCHOOL-YEAR TABLE ────────────────────────────────────────────────────────────
console.log("\nWhen BC school is plausibly in (approximate by design — the wording never asserts the limit)");
const d = (s: string) => new Date(s + "T12:00:00");           // local noon, so no tz edge
ok("Y1  Tue 2026-10-06 (term time)      → in", R.bcSchoolDayLikely(d("2026-10-06")));
ok("Y2  Sat 2026-10-10                  → out", !R.bcSchoolDayLikely(d("2026-10-10")));
ok("Y3  Wed 2026-07-15 (summer)         → out", !R.bcSchoolDayLikely(d("2026-07-15")));
ok("Y4  Mon 2026-08-31 (still summer)   → out", !R.bcSchoolDayLikely(d("2026-08-31")));
ok("Y5  Tue 2026-09-08 (day after Labour Day) → in", R.bcSchoolDayLikely(d("2026-09-08")));
ok("Y6  Mon 2026-09-07 (Labour Day)     → out", !R.bcSchoolDayLikely(d("2026-09-07")));
ok("Y7  Wed 2026-12-23 (winter break)   → out", !R.bcSchoolDayLikely(d("2026-12-23")));
ok("Y8  Mon 2026-03-16 (spring break)   → out", !R.bcSchoolDayLikely(d("2026-03-16")));
ok("Y9  Mon 2026-10-12 (Thanksgiving)   → out", !R.bcSchoolDayLikely(d("2026-10-12")));
ok("Y10 Mon 2026-02-16 (BC Family Day, 3rd Monday) → out", !R.bcSchoolDayLikely(d("2026-02-16")));
ok("Y11 Fri 2026-04-03 (Good Friday)    → out", !R.bcSchoolDayLikely(d("2026-04-03")));
ok("Y12 Mon 2026-05-18 (Victoria Day)   → out", !R.bcSchoolDayLikely(d("2026-05-18")));
ok("Y13 Wed 2026-11-11 (Remembrance Day)→ out", !R.bcSchoolDayLikely(d("2026-11-11")));
ok("Y14 Thu 2026-06-25 (last week of June counted IN, deliberately)", R.bcSchoolDayLikely(d("2026-06-25")));

// ─── 4 · IS THE ZONE LIVE RIGHT NOW? ─────────────────────────────────────────────────────────
console.log("\nActive-hours gating — outside the window the app says NOTHING");
const VAN: [number, number] = [49.2827, -123.1207];
const play = (tag: string) => ({ kind: "playground" as const, window: P(tag)!.window });
const school = (tag: string | null) => ({ kind: "school" as const, window: tag ? P(tag)!.window : { type: "always" as const } });

// Playground: dawn→dusk, 365 days, no school calendar involved at all.
{
  const noonMs = Date.parse("2026-09-21T19:00:00Z");     // 12:00 PDT
  const nightMs = Date.parse("2026-09-22T06:00:00Z");    // 23:00 PDT
  ok("A1  playground live at midday", R.zoneActive(play("30 @ (sunrise-sunset)"), new Date(noonMs), noonMs, ...VAN));
  ok("A2  playground silent at 23:00", !R.zoneActive(play("30 @ (sunrise-sunset)"), new Date(nightMs), nightMs, ...VAN));
  const sunMs = Date.parse("2026-12-20T19:00:00Z");      // a Sunday, 11:00 PST — school is out, playground is not
  ok("A3  playground live on a SUNDAY (BC: 365 days)", R.zoneActive(play("30 @ (dawn-dusk)"), new Date(sunMs), sunMs, ...VAN));
  ok("A4  the INVERTED '50 @ (dusk-dawn)' tag still means 'live in daylight'",
    R.zoneActive(play("50 @ (dusk-dawn)"), new Date(noonMs), noonMs, ...VAN));
}
// School: Mo-Fr, clamped to 08:00-17:00, and only inside the school year.
{
  const at = (iso: string) => { const dt = new Date(iso); return { dt, ms: dt.getTime() }; };
  const tue10 = at("2026-10-06T10:00:00");
  const tue19 = at("2026-10-06T19:30:00");
  const tue07 = at("2026-10-06T07:15:00");
  const sat10 = at("2026-10-10T10:00:00");
  const jul10 = at("2026-07-15T10:00:00");
  ok("A5  Tue 10:00 in term → live", R.zoneActive(school("30 @ (Mo-Fr 08:00-17:00; SH off)"), tue10.dt, tue10.ms, ...VAN));
  ok("A6  Sat 10:00 → silent", !R.zoneActive(school("30 @ (Mo-Fr 08:00-17:00; SH off)"), sat10.dt, sat10.ms, ...VAN));
  ok("A7  July → silent", !R.zoneActive(school("30 @ (Mo-Fr 08:00-17:00; SH off)"), jul10.dt, jul10.ms, ...VAN));
  ok("A8  Burnaby's 07:00-22:00 tag is CLAMPED — 19:30 is silent",
    !R.zoneActive(school("30 @ (Mo-Fr 07:00-22:00; SH off; PH off)"), tue19.dt, tue19.ms, ...VAN));
  ok("A9  …and 07:15 is silent too (the clamp starts at 08:00)",
    !R.zoneActive(school("30 @ (Mo-Fr 07:00-22:00; SH off; PH off)"), tue07.dt, tue07.ms, ...VAN));
  const tue0930 = at("2026-10-06T09:30:00");
  const tue0830 = at("2026-10-06T08:30:00");
  ok("A10 a NARROWER tag wins over the clamp: 09:00-17:00 is silent at 08:30",
    !R.zoneActive(school("30 @ (Mo-Fr 09:00-17:00; SH off; PH off)"), tue0830.dt, tue0830.ms, ...VAN));
  ok("A11 …and live at 09:30", R.zoneActive(school("30 @ (Mo-Fr 09:00-17:00; SH off; PH off)"), tue0930.dt, tue0930.ms, ...VAN));
  ok("A12 a hazard=school_zone way with NO conditional falls back to the clamp",
    R.zoneActive(school(null), tue10.dt, tue10.ms, ...VAN) && !R.zoneActive(school(null), tue19.dt, tue19.ms, ...VAN));
}

// ─── 5 · THE HEADS-UP: DISTANCE AND TIME ─────────────────────────────────────────────────────
// Jeff: "a good heads up for distance and time". 20 s, floor 200 m, cap 450 m. The old camera
// alert was a FIXED 100 m — the negative control below is what it gave at each speed.
console.log("\nLead distance — a constant TIME, clamped (nav.ts's prepareM/imminentM shape)");
for (const [kmh, wantM, wantS] of [[30, 200, 24.0], [50, 278, 20.0], [100, 450, 16.2]] as const) {
  const spd = kmh / 3.6;
  const lead = R.aheadLeadM(spd);
  const secs = lead / spd;
  ok(`L:${kmh} km/h → ${Math.round(lead)} m = ${secs.toFixed(1)} s  (old fixed 100 m = ${(100 / spd).toFixed(1)} s)`,
    Math.round(lead) === wantM && Math.abs(secs - wantS) < 0.1);
}
// The 20 s lead is EXACT between 36 and 81 km/h; outside that band a clamp takes over and the
// warning time drifts. Pinned here so the drift is on the record rather than a surprise:
//   • the 200 m floor stretches the slow end — 48 s at the 15 km/h cut-in, ~1.5 city blocks. Early.
//   • the 450 m cap shortens the fast end — 16.2 s at 100 km/h, 13.5 s at BC's 120 km/h maximum.
//     That is still between nav.ts's IMMINENT_LEAD_S (10) and PREPARE_LEAD_S (30), and the cap
//     cannot be raised: it is what keeps the lead inside the speed-limit pipeline's 500 m frontier.
ok("L1  no speed from 15 to 130 km/h gets less than 12 s or more than 48 s", (() => {
  for (let k = 15; k <= 130; k += 5) {
    const s = R.aheadLeadM(k / 3.6) / (k / 3.6);
    if (s < 12 || s > 48.01) return false;
  }
  return true;
})());
for (const [kmh, wantS] of [[15, 48.0], [120, 13.5]] as const) {
  const spd = kmh / 3.6;
  ok(`L1a ${kmh} km/h (a clamped end) → ${(R.aheadLeadM(spd) / spd).toFixed(1)} s`,
    Math.abs(R.aheadLeadM(spd) / spd - wantS) < 0.1);
}
ok("L1b the lead is EXACTLY the 20 s design figure between 36 and 81 km/h", (() => {
  for (let k = 36; k <= 81; k += 3) {
    const s = R.aheadLeadM(k / 3.6) / (k / 3.6);
    if (Math.abs(s - R.AHEAD_LEAD_S) > 0.01) return false;
  }
  return true;
})());
ok("L2  the cap (450 m) stays inside the speed-limit pipeline's 500 m guaranteed frontier",
  R.AHEAD_LEAD_MAX_M < 1500 - 1000);
ok("L3  the cap only binds above 81 km/h — the speed at which school and playground zones stop existing",
  R.aheadLeadM(80 / 3.6) < R.AHEAD_LEAD_MAX_M && R.aheadLeadM(85 / 3.6) === R.AHEAD_LEAD_MAX_M);
ok("L4  a stationary or speedless fix falls to the floor, never NaN",
  R.aheadLeadM(0) === R.AHEAD_LEAD_MIN_M && R.aheadLeadM(null) === R.AHEAD_LEAD_MIN_M && R.aheadLeadM(NaN) === R.AHEAD_LEAD_MIN_M);

// ─── 6 · THE FORWARD CORRIDOR ────────────────────────────────────────────────────────────────
// Why this exists: 277 `railway=level_crossing` nodes sit within 8 km of Jeff's 09-20 departure
// point (measured 2026-09-21). A plain radius test would alert on crossings he never drives over.
console.log("\nForward corridor — ahead, and on the road you are on");
{
  // 300 m due north of the car, heading north.
  const N = (m: number) => 49.2 + m / 111320;
  const E = (m: number) => -123.0 + m / (111320 * Math.cos(49.2 * Math.PI / 180));
  const o = R.forwardOffsets(49.2, -123.0, 0, N(300), -123.0)!;
  ok("C1  300 m due north, heading 0° → along 300, cross 0", Math.round(o.alongM) === 300 && Math.round(o.crossM) === 0);
  const back = R.forwardOffsets(49.2, -123.0, 180, N(300), -123.0)!;
  ok("C2  the same point heading SOUTH is BEHIND (along < 0)", back.alongM < 0);
  ok("C3  …and is rejected", !R.inCorridor(back.alongM, back.crossM, 450));
  const side = R.forwardOffsets(49.2, -123.0, 0, N(300), E(200))!;
  ok("C4  300 m ahead but 200 m to the side (the next street over) is rejected",
    Math.round(side.crossM) === 200 && !R.inCorridor(side.alongM, side.crossM, 450));
  const lane = R.forwardOffsets(49.2, -123.0, 0, N(300), E(25))!;
  ok("C5  300 m ahead, 25 m off (the other carriageway) is accepted", R.inCorridor(lane.alongM, lane.crossM, 450));
  ok("C6  beyond the lead is rejected", !R.inCorridor(600, 0, 450));
  ok("C7  no course (a stationary fix) → null, never a guessed heading", R.forwardOffsets(49.2, -123.0, null, N(300), -123.0) === null);
  ok("C8  a negative course (iOS's 'no heading' sentinel) → null", R.forwardOffsets(49.2, -123.0, -1, N(300), -123.0) === null);
  ok("C9  the cone widens with distance: 40 m off is in at 300 m, out at 30 m",
    R.inCorridor(300, 40, 450) && !R.inCorridor(30, 40, 450));
}

// ─── 7 · PICKING ONE THING TO SAY ────────────────────────────────────────────────────────────
console.log("\npickAheadHit — one hit per tick, nearest first, off-switches and windows respected");
{
  const N = (m: number) => 49.2 + m / 111320;
  const all = () => true;
  const now = new Date("2026-10-06T10:00:00"); const nowMs = now.getTime();
  const rail = (id: string, m: number) => ({ id, kind: "railway" as const, lat: N(m), lng: -123.0 });
  const feats = [rail("far", 400), rail("near", 150)];
  const hit = R.pickAheadHit(feats, 49.2, -123.0, 0, 50 / 3.6, now, nowMs, all)!;
  ok("K1  the NEAREST qualifying feature wins", hit.feature.id === "near", `got ${hit?.feature.id}`);
  ok("K2  the hit carries the matched point, so the caller can cluster round it",
    Math.abs(hit.lat - N(150)) < 1e-9);
  ok("K3  below AHEAD_MIN_SPEED_KMH nothing is called out",
    R.pickAheadHit(feats, 49.2, -123.0, 0, 10 / 3.6, now, nowMs, all) === null);
  ok("K4  a switched-off kind is silent",
    R.pickAheadHit(feats, 49.2, -123.0, 0, 50 / 3.6, now, nowMs, (k) => k !== "railway") === null);
  // A way-shaped zone: only its nearest vertex matters.
  const zone = {
    id: "w1", kind: "school" as const, lat: N(1200), lng: -123.0, limitKmh: 30,
    geom: [{ lat: N(1200), lng: -123.0 }, { lat: N(200), lng: -123.0 }],
    when: { kind: "school" as const, window: P("30 @ (Mo-Fr 08:00-17:00; SH off)")!.window },
  };
  ok("K5  a zone WAY is hit at its nearest vertex, not its first",
    Math.round(R.pickAheadHit([zone], 49.2, -123.0, 0, 50 / 3.6, now, nowMs, all)!.alongM) === 200);
  const sat = new Date("2026-10-10T10:00:00");
  ok("K6  the same zone on a Saturday is silent",
    R.pickAheadHit([zone], 49.2, -123.0, 0, 50 / 3.6, sat, sat.getTime(), all) === null);
  ok("K7  an empty cache does not throw", R.pickAheadHit([], 49.2, -123.0, 0, 50 / 3.6, now, nowMs, all) === null);
  ok("K8  featureDistM measures to the nearest vertex of a way",
    Math.round(R.featureDistM(zone, 49.2, -123.0)) === 200);
  ok("K9  the re-arm radius is twice the lead, so a return trip speaks again", R.rearmM(300) === 600);
}

// ─── 8 · WHAT NOVA SAYS ──────────────────────────────────────────────────────────────────────
console.log("\nThe spoken lines — short, and every one carries the distance");
ok("V1  school is Jeff's wording, verbatim, with the distance in it",
  R.aheadLine("school", "300 m", 30, false) === "School zone ahead in 300 m — thirty when school's in.",
  R.aheadLine("school", "300 m", 30, false));
ok("V2  playground", R.aheadLine("playground", "250 m", 30, false) === "Playground zone ahead in 250 m — thirty until dusk.");
ok("V3  railway", R.aheadLine("railway", "400 m", null, false) === "Railway crossing ahead in 400 m.");
ok("V4  camera", R.aheadLine("camera", "450 m", null, false) === "Speed camera ahead in 450 m.");
ok("V5  an mph driver hears mph and feet — the caller already formatted the distance",
  R.aheadLine("school", "0.2 mi", 30, true) === "School zone ahead in 0.2 mi — twenty when school's in.",
  R.aheadLine("school", "0.2 mi", 30, true));
ok("V6  a zone with no known limit still says something sane",
  R.aheadLine("school", "300 m", null, false).includes("thirty"));
ok("V7  every line is under 60 characters so it lands before the thing it describes", (() => {
  const ls = [R.aheadLine("school", "300 m", 30, false), R.aheadLine("playground", "250 m", 30, false),
              R.aheadLine("railway", "400 m", null, false), R.aheadLine("camera", "450 m", null, false)];
  return ls.every((l) => l.length <= 60);
})());
ok("V8  spellLimit says numbers TTS reads back as words, not years",
  R.spellLimit(30, false) === "thirty" && R.spellLimit(50, false) === "fifty" && R.spellLimit(35, false) === "35");

console.log("\nThe camera line keeps its variety (2026-09-21 review)");
{
  const seen = new Set<string>();
  for (let i = 0; i < 5; i++) seen.add(R.pickCameraLine("400 m"));
  ok("CAM1 five distinct lines", seen.size === 5, `got ${seen.size}`);
  ok("CAM2 every one carries the distance", [...seen].every((l) => l.includes("400 m")));
  const a = R.pickCameraLine("200 m"), b = R.pickCameraLine("200 m");
  ok("CAM3 never the same one twice in a row", a !== b, `${a} | ${b}`);
  ok("CAM4 it rotates rather than randomises — 5 apart repeats",
    (() => { const first = R.pickCameraLine("1 km"); for (let i = 0; i < 4; i++) R.pickCameraLine("1 km"); return R.pickCameraLine("1 km") === first; })());
}

console.log(fails === 0 ? "\nPASS ahead_alerts" : `\nFAIL ahead_alerts (${fails})`);
if (fails) process.exit(1);
