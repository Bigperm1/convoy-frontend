// ai_route_test — the learned-route ("AI route") memory, src/aiRoutes.ts. Jeff, 2026-09-24: "FOR SOME REASON THE
// ROUTE LEARNING IS NOT WORKING... EVERYDAY I MERGE OFF THE HIGHWAY ON THE WAY TO WORK, BUT IT ALWAYS IS TAKING ME
// THE FASTEST WAY NOT MY WAY. LETS FIX IT". Three things this gate pins:
//   1. The memory applies when the car is ON the remembered road, not only within 350 m of the exact fix where
//      the driver happened to tap Start (every commute plot in his crumbs is fsrc=course — he plots while moving).
//   2. The replay's via points sit on the stretch where HIS path leaves the fastest route (the exit + the parallel
//      road), so Mapbox is forced off the highway there — evenly-spaced points 4 km apart could miss a 3 km detour,
//      hand back the highway, and the "AI" route was then dropped as identical to Best.
//   3. A memory that never diverges from Best replays nothing (there is no "my way" to offer).
import {
  matchAiRouteAlongPath, viaPointsAhead, vetReplay, remainingPathM, AI_MATCH_RADIUS_M, AI_DIVERGE_M, type AiRoute,
} from "../../src/aiRoutes.ts";

let fails = 0;
const ok = (name: string, cond: boolean, detail = "") => {
  if (!cond) { fails++; console.log(`  FAIL ${name} ${detail}`); } else console.log(`  ok   ${name} ${detail}`);
};

// ── A synthetic 30 km eastbound commute at 49.1° N. Longitude degrees → metres: 1° ≈ 72.8 km here. ──
const LAT = 49.1;
const M_PER_DEG_LNG = 111320 * Math.cos((LAT * Math.PI) / 180);   // ≈ 72,830 m
const M_PER_DEG_LAT = 111320;
const lng0 = -122.9;
const east = (m: number) => lng0 + m / M_PER_DEG_LNG;
const north = (m: number) => LAT + m / M_PER_DEG_LAT;

// The fastest route: straight along the "highway" for 30 km.
const best: [number, number][] = [];
for (let m = 0; m <= 30000; m += 50) best.push([east(m), north(0)]);

// His way: highway to km 24, exit, a parallel road 400 m north from km 24.5 to km 28, back to the line at km 28.5,
// then the last 1.5 km on the highway to work. (Same start and end as Best.)
const mine: [number, number][] = [];
for (let m = 0; m <= 30000; m += 60) {
  let off = 0;
  if (m > 24000 && m < 24500) off = ((m - 24000) / 500) * 400;
  else if (m >= 24500 && m <= 28000) off = 400;
  else if (m > 28000 && m < 28500) off = ((28500 - m) / 500) * 400;
  mine.push([east(m), north(off)]);
}
const route: AiRoute = {
  placeId: "work", startLat: mine[0][1], startLng: mine[0][0], endLat: mine[mine.length - 1][1], endLng: mine[mine.length - 1][0],
  coords: mine, drives: 3, lastDrivenAt: Date.now(), duration_s: 1500, distance_m: 30400,
};
const dist = (a: [number, number], b: [number, number]) =>
  Math.hypot((a[0] - b[0]) * M_PER_DEG_LNG, (a[1] - b[1]) * M_PER_DEG_LAT);

// A — matching along the path
{
  const atStart = matchAiRouteAlongPath(route, route.startLat, route.startLng);
  ok("A1 origin at the remembered start → hit at idx 0", !!atStart && atStart.idx === 0, `idx=${atStart?.idx}`);
  const moving = matchAiRouteAlongPath(route, north(30), east(2100));          // 2.1 km down the road, 30 m off it
  ok("A2 plotted while moving, 2.1 km down the road → hit", !!moving && moving.distM < 60, `d=${moving?.distM.toFixed(0)}`);
  ok("A3 …and the index is where the car is, not 0", !!moving && moving.idx > 30 && moving.idx < 40, `idx=${moving?.idx}`);
  const far = matchAiRouteAlongPath(route, north(AI_MATCH_RADIUS_M + 200), east(2100));
  ok("A4 a parallel street beyond the match radius → miss", far === undefined);
  const pastIt = matchAiRouteAlongPath(route, north(0), east(29400));          // 600 m from work, past the detour
  ok("A5 origin past the last usable stretch → miss (nothing left to replay)", pastIt === undefined);
  const start350 = matchAiRouteAlongPath(route, north(0), east(340));
  ok("A6 the old 350 m-from-start case still matches", !!start350, "");
}

// B — via points aimed at the divergence
{
  const m = matchAiRouteAlongPath(route, north(20), east(1000))!;
  const via = viaPointsAhead(route, m.idx, best);
  ok("B1 between 2 and 8 via points", via.length >= 2 && via.length <= 8, `n=${via.length}`);
  const offBest = via.map((v) => Math.min(...best.map((b) => dist(v, b))));
  ok("B2 every via point is on the divergent stretch (> AI_DIVERGE_M from Best)", offBest.every((d) => d > AI_DIVERGE_M), offBest.map((d) => d.toFixed(0)).join("/"));
  ok("B3 every via point is on his remembered road", via.every((v) => Math.min(...mine.map((p) => dist(v, p))) < 5));
  const xs = via.map((v) => v[0]);
  ok("B4 via points are ordered along the direction of travel", xs.every((x, i) => i === 0 || x > xs[i - 1]));
  ok("B5 the first via is near the start of the detour, not mid-highway", east(24000) < xs[0] && xs[0] < east(25200), `firstKm=${((xs[0] - lng0) * M_PER_DEG_LNG / 1000).toFixed(1)}`);
  ok("B6 the last via is before the rejoin", xs[xs.length - 1] < east(28500), `lastKm=${((xs[xs.length - 1] - lng0) * M_PER_DEG_LNG / 1000).toFixed(1)}`);
  // Origin already on the parallel road: only what is still ahead is replayed.
  const m2 = matchAiRouteAlongPath(route, north(400), east(26000))!;
  const via2 = viaPointsAhead(route, m2.idx, best);
  ok("B7 from mid-detour, via points are all ahead of the car", via2.length >= 1 && via2.every((v) => v[0] > east(26000)), `n=${via2.length}`);
}

// C — no divergence, no replay
{
  const same: AiRoute = { ...route, coords: best.filter((_, i) => i % 2 === 0) };
  const m = matchAiRouteAlongPath(same, north(0), east(500))!;
  ok("C1 a memory that IS the fastest route replays nothing", viaPointsAhead(same, m.idx, best).length === 0);
  ok("C2 without a Best geometry the legacy even sampling still returns ≤ 8 interior points", (() => {
    const v = viaPointsAhead(route, m.idx);
    return v.length >= 2 && v.length <= 8 && v.every((p) => p[0] > east(500) && p[0] < east(30000));
  })());
}

// D — degenerate input never throws
{
  const tiny: AiRoute = { ...route, coords: [mine[0], mine[mine.length - 1]] };
  ok("D1 two-point memory → no match past idx 0 / no vias", viaPointsAhead(tiny, 0, best).length === 0);
  ok("D2 origin far from everything → miss", matchAiRouteAlongPath(route, 50.5, -120.0) === undefined);
}

// E — Codex review 2026-09-24: heading, a missed exit, sparse Best geometry, the replay vet
{
  // E1/E2 — the opposite carriageway is not "this road": eastbound memory, car heading west.
  ok("E1 heading east on the remembered road → hit", !!matchAiRouteAlongPath(route, north(10), east(3000), 90));
  ok("E2 heading west (opposite carriageway) → miss", matchAiRouteAlongPath(route, north(10), east(3000), 270) === undefined);
  ok("E3 no heading known → nearest point, as before", !!matchAiRouteAlongPath(route, north(10), east(3000), null));
  // E4 — car 160 m past where the ramp leaves, still on the highway: no via point may be behind the car.
  const missed = matchAiRouteAlongPath(route, north(0), east(24160), 90);
  const viaMissed = missed ? viaPointsAhead(route, missed.idx, best, 8, { lat: north(0), lng: east(24160), headingDeg: 90 }) : [];
  ok("E4 missed exit → every via point is ahead of the car", viaMissed.every((v) => v[0] > east(24160)), `n=${viaMissed.length}`);
  // E5 — and the replay Mapbox returns for that case (a loop back to the ramp) is refused by the vet.
  const fromIdx = missed?.idx ?? 400;
  const rem = remainingPathM(route, fromIdx);
  // A memory with driven metres (as recordDrive writes from 2026-09-24): straight road, so metres == chords here.
  const cum: number[] = [0];
  for (let i = 1; i < mine.length; i++) cum.push(cum[i - 1] + dist(mine[i - 1], mine[i]));
  const metered: AiRoute = { ...route, m: cum.map((v) => Math.round(v)) };
  ok("E5 vet refuses a replay that needs a U-turn Best does not", vetReplay({ memory: metered, fromIdx, aiDistanceM: rem, aiDurationS: 300, aiUturns: 1, bestUturns: 0 }) === "uturn");
  ok("E6 vet refuses a replay far LONGER than the remembered road ahead (next exit and back)", vetReplay({ memory: metered, fromIdx, aiDistanceM: rem * 1.3 + 1500, aiDurationS: 600, aiUturns: 0, bestUturns: 0 }) === "too-long", `rem=${rem.toFixed(0)}m`);
  ok("E7 vet accepts a replay of the remembered length, whatever it takes in time (no per-point times stored)", vetReplay({ memory: metered, fromIdx, aiDistanceM: rem * 1.03, aiDurationS: 900, aiUturns: 0, bestUturns: 0 }) === null);
  ok("E7d an OLDER memory (no driven metres) is never refused by distance — its chords cut corners", vetReplay({ memory: route, fromIdx, aiDistanceM: rem * 2.5, aiDurationS: 600, aiUturns: 0, bestUturns: 0 }) === null);
  // E7b — Codex's case: a 30-min commute whose last 3 km take 10 min. With per-point times, an exact replay of that
  // local-road tail is accepted and a replay taking three times as long is not.
  const tTimed = mine.map((_, i) => (i < mine.length - 51 ? Math.round(i * (1200 / (mine.length - 51))) : 1200 + Math.round((i - (mine.length - 51)) * (600 / 50))));
  const timed: AiRoute = { ...route, t: tTimed, duration_s: 1800 };
  const tail = mine.length - 51;                      // ~3 km from the end
  ok("E7b timed memory: exact 600 s replay of the slow local tail → accepted", vetReplay({ memory: timed, fromIdx: tail, aiDistanceM: remainingPathM(timed, tail), aiDurationS: 600, aiUturns: 0, bestUturns: 0 }) === null);
  ok("E7c timed memory: a replay three times slower than the remembered tail → too-slow", vetReplay({ memory: timed, fromIdx: tail, aiDistanceM: remainingPathM(timed, tail), aiDurationS: 1800, aiUturns: 0, bestUturns: 0 }) === "too-slow");
  // E8 — sparse Best geometry (a vertex every 600 m on a straight highway) must not read as a detour.
  const sparseBest = best.filter((_, i) => i % 12 === 0);
  const same: AiRoute = { ...route, coords: best.filter((_, i) => i % 2 === 0) };
  const m0 = matchAiRouteAlongPath(same, north(0), east(500))!;
  ok("E8 identical straight path vs sparse Best → no vias", viaPointsAhead(same, m0.idx, sparseBest).length === 0);
  // E9 — with the same sparse Best, his real detour is still found and nothing else is.
  const m1 = matchAiRouteAlongPath(route, north(0), east(1000))!;
  const viaSparse = viaPointsAhead(route, m1.idx, sparseBest);
  ok("E9 sparse Best: vias only on the detour", viaSparse.length >= 2 && viaSparse.every((v) => v[0] > east(24000) && v[0] < east(28500)), `n=${viaSparse.length}`);
}

// F — Codex round 3: a winding road through recordDrive's decimation + 400-point cap must keep its true length.
{
  const { recordDrive } = await import("../../src/aiRoutes.ts");
  // 40 km straight at 20 m fixes, then 8.5 km of switchbacks (±40 m every 100 m) — 2,425 raw fixes → capped to 400.
  const raw: { lat: number; lng: number; ts: number }[] = [];
  let ts = 0;
  for (let m = 0; m <= 40000; m += 20) raw.push({ lat: north(0), lng: east(m), ts: (ts += 700) });
  for (let m = 20; m <= 8500; m += 20) {
    const phase = (m % 200) / 200;
    const off = phase < 0.5 ? (phase / 0.5) * 80 - 40 : 40 - ((phase - 0.5) / 0.5) * 80;
    raw.push({ lat: north(off), lng: east(40000 + m), ts: (ts += 2000) });
  }
  const rawLen = raw.slice(1).reduce((a, p, i) => a + dist([p.lng, p.lat], [raw[i].lng, raw[i].lat]), 0);
  const rec = await recordDrive({ placeId: "winding-sim", trace: raw });
  ok("F1 recordDrive keeps a capped memory (≤ 400 points) with t[] and m[] aligned", !!rec && rec.coords.length <= 400 && rec.t?.length === rec.coords.length && rec.m?.length === rec.coords.length, `pts=${rec?.coords.length}`);
  ok("F2 the memory's distance is the RAW road length, not the chords", !!rec && Math.abs(rec.distance_m - rawLen) / rawLen < 0.02, `stored=${rec?.distance_m} raw=${rawLen.toFixed(0)}`);
  if (rec) {
    const atBend = matchAiRouteAlongPath(rec, north(0), east(40000))!;
    const remDriven = remainingPathM(rec, atBend.idx);
    const chords = (() => { let s = 0; for (let i = atBend.idx + 1; i < rec.coords.length; i++) s += dist(rec.coords[i - 1], rec.coords[i]); return s; })();
    // The zigzag's true length is 1.28× its horizontal run (each 100 m leg climbs 80 m); the capped chords fall short of it.
    ok("F3 remaining metres come from the driven fixes (the chords under-count the switchbacks)", remDriven > chords * 1.1 && Math.abs(remDriven - 8500 * 1.28) < 1500, `driven=${remDriven.toFixed(0)} chords=${chords.toFixed(0)}`);
    ok("F4 an exact road-length replay of the winding tail is accepted", vetReplay({ memory: rec, fromIdx: atBend.idx, aiDistanceM: remDriven * 1.02, aiDurationS: (rec.t![rec.t!.length - 1] - rec.t![atBend.idx]) * 1.1, aiUturns: 0, bestUturns: 0 }) === null);
    ok("F5 …and a loop twice that long is not", vetReplay({ memory: rec, fromIdx: atBend.idx, aiDistanceM: remDriven * 2, aiDurationS: 600, aiUturns: 0, bestUturns: 0 }) === "too-long");
  }
}

// G — 2026-09-24: a one-off drive must not overwrite the habit. Jeff's Tim Hortons stop (09-24 09:27, plotted
// mid-commute) would have become the next day's "AI route" because recordDrive stored the LAST drive, whatever it was.
// The habit (drives ≥ 2) now survives a detour or a different way; a way driven twice in a row replaces it.
{
  const { recordDrive, compareDrive } = await import("../../src/aiRoutes.ts");
  const fixes = (pts: [number, number][]) => pts.map((p, i) => ({ lat: p[1], lng: p[0], ts: i * 3000 }));
  // A road with a loop off it at km 10: north `spikeM` and straight back (a detour of 2 × spikeM).
  const spikedOn = (base: [number, number][], spikeM: number): [number, number][] => {
    const out: [number, number][] = [];
    for (const p of base) {
      out.push(p);
      if (Math.abs(p[0] - east(10020)) < 1e-9) {
        for (let n = 60; n <= spikeM; n += 60) out.push([p[0], north(n)]);
        for (let n = spikeM - 60; n > 0; n -= 60) out.push([p[0], north(n)]);
      }
    }
    return out;
  };
  const spiked = (spikeM: number) => spikedOn(mine, spikeM);
  // A genuinely different way: highway to km 20, a parallel road 400 m SOUTH from km 20.5 to km 29, rejoin at 29.5.
  const other: [number, number][] = [];
  for (let m = 0; m <= 30000; m += 60) {
    let off = 0;
    if (m > 20000 && m < 20500) off = -((m - 20000) / 500) * 400;
    else if (m >= 20500 && m <= 29000) off = -400;
    else if (m > 29000 && m < 29500) off = -((29500 - m) / 500) * 400;
    other.push([east(m), north(off)]);
  }
  const drive = (placeId: string, pts: [number, number][]) => recordDrive({ placeId, trace: fixes(pts) });
  const minNorth = (r: { coords: [number, number][] }) => Math.min(...r.coords.map((c) => (c[1] - LAT) * M_PER_DEG_LAT));
  const maxNorth = (r: { coords: [number, number][] }) => Math.max(...r.coords.map((c) => (c[1] - LAT) * M_PER_DEG_LAT));

  // G1/G2 — three identical commutes make the habit; a fourth with 15 m of GPS jitter reinforces it.
  await drive("g-habit", mine); await drive("g-habit", mine);
  const h3 = (await drive("g-habit", mine))!;
  ok("G1 three identical drives → drives=3, verdict same", h3.drives === 3 && h3.learn === "same", `drives=${h3.drives} learn=${h3.learn}`);
  const jitter = mine.map((p, i): [number, number] => [p[0], p[1] + ((i % 3) - 1) * 15 / M_PER_DEG_LAT]);
  const h4 = (await drive("g-habit", jitter))!;
  ok("G2 a near-identical drive (15 m jitter) reinforces: drives=4, geometry replaced", h4.drives === 4 && h4.learn === "same" && h4.coords !== h3.coords, `drives=${h4.drives} learn=${h4.learn}`);

  // G3 — a 30 % longer loop (4.5 km north and back) on a drives=4 memory does NOT replace it.
  const before = Date.now();
  const loop = spiked(4500);
  const h5 = (await drive("g-habit", loop))!;
  ok("G3 a 30 % longer detour on an established habit → habit kept, drives unchanged, lastDrivenAt bumped",
    h5.learn === "one-off" && h5.drives === 4 && h5.coords === h4.coords && h5.lastDrivenAt >= before && maxNorth(h5) < 500, `learn=${h5.learn} drives=${h5.drives}`);
  ok("G3b …and the detour sits in the candidate slot", !!h5.candidate && Math.max(...h5.candidate.coords.map((c) => (c[1] - LAT) * M_PER_DEG_LAT)) > 4000);
  // G4 — the habit driven again clears the candidate (two in a ROW is the rule).
  const h6 = (await drive("g-habit", mine))!;
  ok("G4 the habit driven again → drives=5, candidate cleared", h6.drives === 5 && h6.learn === "same" && h6.candidate === undefined, `drives=${h6.drives} cand=${!!h6.candidate}`);
  // G5/G6 — a genuinely new way once is a one-off; twice in a row it becomes the habit.
  const h7 = (await drive("g-habit", other))!;
  ok("G5 a different way once → one-off, habit kept", h7.learn === "one-off" && h7.drives === 5 && minNorth(h7) > -50 && !!h7.candidate, `learn=${h7.learn}`);
  const h8 = (await drive("g-habit", other))!;
  ok("G6 the same different way twice in a row → promoted: it IS the habit now (drives=2), candidate cleared",
    h8.learn === "promote" && h8.drives === 2 && minNorth(h8) < -350 && h8.candidate === undefined, `learn=${h8.learn} drives=${h8.drives} minN=${minNorth(h8).toFixed(0)}`);

  // G7 — plotted later / earlier on the SAME road: the memory never shrinks, and it grows.
  await drive("g-extent", mine); const e2 = (await drive("g-extent", mine))!;
  const fromKm12 = mine.filter((p) => p[0] >= east(12000));
  const e3 = (await drive("g-extent", fromKm12))!;
  ok("G7 plotted 12 km later on the habit → partial: drives+1, geometry kept (start unchanged)", e3.learn === "partial" && e3.drives === 3 && e3.coords === e2.coords && e3.startLng === mine[0][0], `learn=${e3.learn} drives=${e3.drives}`);
  const fromHome: [number, number][] = [];
  for (let m = -5000; m < 0; m += 60) fromHome.push([east(m), north(0)]);
  const e4 = (await drive("g-extent", fromHome.concat(mine)))!;
  ok("G7b plotted 5 km earlier → same: drives+1, memory extends back to the new start", e4.learn === "same" && e4.drives === 4 && e4.startLng < mine[0][0] - 4000 / M_PER_DEG_LNG, `learn=${e4.learn} startKm=${((e4.startLng - lng0) * M_PER_DEG_LNG / 1000).toFixed(1)}`);

  // G8 — Jeff's case: a coffee stop 600 m off the road (1.2 km excursion, +4 % length, 96 % shared) must not enter the habit.
  await drive("g-tims", mine); const t2 = (await drive("g-tims", mine))!;
  const t3 = (await drive("g-tims", spiked(600)))!;
  ok("G8 a 600 m coffee stop on a 30 km habit → one-off, habit kept", t3.learn === "one-off" && t3.coords === t2.coords, `learn=${t3.learn}`);
  const t4 = (await drive("g-tims", spiked(100)))!;
  ok("G8b a 100 m wobble (a lane, a lot) is still the same road → same", t4.learn === "same" && t4.drives === 3, `learn=${t4.learn}`);

  // G9 — no habit yet (drives=1): the last drive still wins, as v1 did.
  await drive("g-fresh", mine);
  const f2 = (await drive("g-fresh", other))!;
  ok("G9 drives=1 + a different way → replaced (no habit to keep yet), drives=2", f2.drives === 2 && minNorth(f2) < -350, `drives=${f2.drives}`);

  // G10 — the comparison itself, on the raw arrays.
  const cmp = compareDrive(route, loop);
  ok("G10 compareDrive: the loop is ~9 km of excursion → one-off", cmp.verdict === "one-off" && cmp.excursionM > 8000 && cmp.excursionM < 10000, `exc=${cmp.excursionM.toFixed(0)}`);
  const cmp2 = compareDrive(route, mine);
  ok("G10b compareDrive: the same road → same, nothing missed, nothing skipped", cmp2.verdict === "same" && cmp2.missedM < 50 && cmp2.skippedM < 50, `missed=${cmp2.missedM?.toFixed(0)} skipped=${cmp2.skippedM?.toFixed(0)}`);
  const cmp3 = compareDrive(route, fromKm12);
  ok("G10c compareDrive: the last 18 km of it → partial, 12 km skipped at the start", cmp3.verdict === "partial" && cmp3.skippedM > 11500 && cmp3.skippedM < 12500, `skipped=${cmp3.skippedM?.toFixed(0)}`);

  // G11 — Codex 2026-09-24: a start only 1.5 km later must not shrink the memory either (a 90 % coverage rule let it, 3 × over).
  await drive("g-shrink", mine); const s2 = (await drive("g-shrink", mine))!;
  let sN = s2;
  for (const km of [1.5, 3, 4.5]) sN = (await drive("g-shrink", mine.filter((p) => p[0] >= east(km * 1000))))!;
  ok("G11 three drives each starting a little later → all partial, the memory keeps its start", sN.learn === "partial" && sN.drives === 5 && sN.coords === s2.coords && sN.startLng === mine[0][0], `learn=${sN.learn} drives=${sN.drives} startKm=${((sN.startLng - lng0) * M_PER_DEG_LNG / 1000).toFixed(1)}`);

  // G12 — Codex: a memory that itself holds a loop (v1 stored whatever the last drive was — the coffee stop may BE the
  // memory today) must be replaceable by the direct road driven twice.
  const looped = spiked(3000);
  await drive("g-loop", looped); const l2 = (await drive("g-loop", looped))!;
  const l3 = (await drive("g-loop", mine))!;
  ok("G12 the direct road against a looped habit → one-off (it skips 6 km of the memory), habit kept", l3.learn === "one-off" && l3.coords === l2.coords && maxNorth(l3) > 2500, `learn=${l3.learn}`);
  const l4 = (await drive("g-loop", mine))!;
  ok("G12b …and twice in a row → promoted, the loop is gone", l4.learn === "promote" && l4.drives === 2 && maxNorth(l4) < 500, `learn=${l4.learn} maxN=${maxNorth(l4).toFixed(0)}`);

  // G13 — Codex: a candidate holding an early loop AND the different exit, repeated only from after the loop → the promoted
  // geometry is the CONFIRMED drive (exit yes, loop no), never the candidate's whole shape.
  await drive("g-cand", mine); await drive("g-cand", mine);
  const c3 = (await drive("g-cand", spikedOn(other, 2000)))!;
  const c4 = (await drive("g-cand", other.filter((p) => p[0] >= east(12000))))!;
  ok("G13 the second drive repeats only the exit → promoted with its own geometry: exit yes, loop no", c3.learn === "one-off" && c4.learn === "promote" && minNorth(c4) < -350 && maxNorth(c4) < 500, `learn=${c4.learn} maxN=${maxNorth(c4).toFixed(0)} minN=${minNorth(c4).toFixed(0)}`);

  // G14 — Codex: a start off the road. Joining the habit AT its start (parked 600 m beside it) is a lead: same, and it
  // replaces — harmless, the lead is behind the car at any later plot. Joining it mid-way from a side street is not.
  const beside: [number, number][] = [];
  for (let n = 600; n > 0; n -= 60) beside.push([mine[0][0], north(n)]);
  await drive("g-side", mine); await drive("g-side", mine);
  const b3 = (await drive("g-side", beside.concat(mine)))!;
  ok("G14 a 600 m lead into the habit's START → same (a lead extends)", b3.learn === "same" && b3.drives === 3, `learn=${b3.learn}`);
  const sideIn: [number, number][] = [];
  for (let n = 600; n > 0; n -= 60) sideIn.push([east(10020), north(n)]);
  const b4 = (await drive("g-side", sideIn.concat(mine.filter((p) => p[0] >= east(10020)))))!;
  ok("G14b a 600 m side street INTO km 10 of the habit → one-off (the first 10 km came from elsewhere)", b4.learn === "one-off" && b4.coords === b3.coords, `learn=${b4.learn}`);

  // G15 — Codex: a sparse recording (a GPS dropout: 4 fixes for 30 km) must never replace a dense memory. A STRAIGHT road,
  // so the chord passes within 120 m of every remembered point and only the gap itself can refuse it.
  const straight = mine.map((p): [number, number] => [p[0], north(0)]);
  const sparse: [number, number][] = [straight[0], straight[2], straight[straight.length - 3], straight[straight.length - 1]];
  await drive("g-gap", straight); const g2 = (await drive("g-gap", straight))!;
  const g3 = (await drive("g-gap", sparse))!;
  ok("G15 a 4-fix trace over a dense habit → counted, geometry kept", g3.drives === 3 && g3.coords === g2.coords && g3.coords.length > 100, `learn=${g3.learn} pts=${g3.coords.length}`);

  // G16 — Codex: a persisted candidate with unusable coords must not survive validation (compareDrive would throw on it).
  const { isTrace } = await import("../../src/aiRoutes.ts");
  const good = { startLat: 1, startLng: 2, endLat: 3, endLng: 4, coords: [[1, 2], [3, 4]], duration_s: 1, distance_m: 1 };
  ok("G16 isTrace: finite pairs pass; null, NaN or string fields fail", typeof isTrace === "function" && isTrace(good) && !isTrace({ ...good, coords: [null, null] }) && !isTrace({ ...good, coords: [[1, 2], [NaN, 4]] }) && !isTrace({ ...good, startLat: "1" }));
}

console.log(fails ? `FAIL ai_route (${fails})` : "PASS ai_route");
process.exit(fails ? 1 : 0);
