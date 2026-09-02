// worker_test.ts — the state machine, every money rule, on in-memory fakes.

import { assert, assertEquals } from "jsr:@std/assert@1";
import {
  CONVERT_MAX_POLLS,
  CREDITS_PAUSE_S,
  CREDITS_PER_CAR,
  GEN_MAX_POLLS,
  GUARD_WAIT_S,
  MAX_ACTIVE_TRIPO,
  MAX_CREDITS_PER_JOB,
  MAX_JOBS_PER_TICK,
  PAID_CALL_RESERVE_MS,
  POLL_S,
  runTick,
  TICK_WORK_BUDGET_MS,
} from "./worker.ts";
import type { Deps, Job, JobResult } from "./worker.ts";
import { DEFAULT_FLAGS, FAKE_EPOCH, FakeTripo, FakeWorld, makeTestGlb, newJob, newSlot, seedFolder } from "./fakes.ts";
import { InsufficientCredits } from "./tripo.ts";
import { sha256Hex } from "./glb.ts";

const SCAN = "tester-20260902-120000";

function world(over: Partial<ConstructorParameters<typeof FakeWorld>[0]> = {}, jobOver: Partial<Job> = {}) {
  const tripo = new FakeTripo();
  return new FakeWorld({
    jobs: [newJob(SCAN, jobOver)],
    carScans: seedFolder(SCAN),
    fakeUrls: { "fake://twin.glb": makeTestGlb({ verts: 14201 }), "fake://hero.glb": makeTestGlb({ verts: 85856, indexType: 5125 }) },
    tripo,
    ...over,
  });
}

/** Tick until nothing is claimable (idle) or `max` ticks, advancing the clock past next_run_at.
 *  Flattens every tick's `jobs[]` into one array — with `seen`-guarding in runTick, a
 *  world with exactly one due job still yields exactly one JobResult per tick, same as
 *  the pre-v3 shape these tests were written against; a world with several due jobs may
 *  contribute more than one JobResult from a single tick. */
async function drain(w: FakeWorld, max = 30, scan?: string): Promise<JobResult[]> {
  const results: JobResult[] = [];
  for (let i = 0; i < max; i++) {
    const r = await runTick(w.deps(), { tickId: `t${i}`, scan });
    if (r.idle) break;
    results.push(...r.jobs);
    w.advance(61);
  }
  return results;
}

/** Old single-job TickResult shape, for the ~30 pre-v3 tests that assert on `.to` /
 *  `.from` / `.scan` / `.error` directly. A tick that advanced nothing (idle) keeps the
 *  exact `{ok, idle}` shape (no `jobs` field) the old runTick returned. Every test using
 *  this helper seeds at most one claimable job, so `jobs[0]` is always the right one —
 *  new multi-job behaviour (item 1) is exercised through raw `runTick` instead. */
async function tick1(deps: Deps, opts: { tickId: string; scan?: string; signal?: AbortSignal }): Promise<JobResult & { idle?: "disabled" | "empty" }> {
  const r = await runTick(deps, opts);
  // idle: same fields the old TickResult carried (ok + idle, nothing else) — from/to are
  // placeholders no idle-checking test ever reads.
  if (r.idle) return { ok: r.ok, idle: r.idle, scan: "", from: "queued", to: "queued" };
  return r.jobs[0];
}

Deno.test("happy path: queued -> fetching -> generating -> converting_map -> converting_hero -> done, 50 credits, twin before hero", async () => {
  const w = world();
  const t = w.tripo as FakeTripo;
  const rs = await drain(w);
  const j = w.job(SCAN);
  assertEquals(j.status, "done");
  assertEquals(j.credits_spent, CREDITS_PER_CAR);
  assertEquals(j.handle, "tester");
  assertEquals(j.shots, ["front", "right", "rear", "left"], "manifest shots persisted on the job at queued->fetching");
  assertEquals(j.paid_call, null);
  assertEquals(j.paid_call_started_at, null);
  assertEquals(w.publishOrder, [`scan_${SCAN}_map.glb`, `scan_${SCAN}.glb`]);
  assertEquals(rs.map((r) => `${r.from}->${r.to}`), [
    "queued->fetching",
    "fetching->generating",
    "generating->converting_map",
    "converting_map->converting_hero",
    "converting_hero->done",
  ]);
  // exactly one generate, exactly two converts, in the documented shapes
  const gens = t.calls.filter((c) => c.method.includes("multiview"));
  assertEquals(gens.length, 1);
  assertEquals((gens[0].body as { model: string }).model, "v3.1-20260211");
  const inputs = (gens[0].body as { inputs: Record<string, string>[] }).inputs;
  assertEquals(inputs.map((i) => Object.keys(i)[0]), ["front", "left", "back", "right"]);
  assert(inputs[2].back.includes("03rearjpg"), "back view must be the 03-rear photo");
  assert(inputs[1].left.includes("04leftjpg"), "left view must be the 04-left photo");
  const converts = t.calls.filter((c) => c.method.includes("convert")).map((c) => c.body as Record<string, unknown>);
  assertEquals(converts.length, 2);
  assertEquals(converts[0].face_limit, 20000);
  assertEquals(converts[0].texture_size, 1024);
  assertEquals(converts[1].face_limit, 150000);
  assertEquals(converts[1].texture_size, 2048);
  for (const c of converts) {
    assertEquals(c.export_orientation, "-x");
    assertEquals(c.scale_factor, 1.9101);
    assertEquals(c.pivot_to_center_bottom, true);
    assertEquals(c.format, "GLTF");
    assertEquals("quad" in c, false);
  }
  // sha256 of what is in the bucket == what the job recorded
  assertEquals(await sha256Hex(w.models.get(`scan_${SCAN}_map.glb`)!), j.twin_sha256);
  assertEquals(await sha256Hex(w.models.get(`scan_${SCAN}.glb`)!), j.hero_sha256);
  // breadcrumbs: one per transition, none for idle polls
  assertEquals(w.breadcrumbs.length, 5);
  assert(w.breadcrumbs.every((b) => b.message.startsWith(`carscan-worker id=${SCAN} `)));
  assert(w.breadcrumbs.at(-1)!.message.includes("done credits=50"));
});

Deno.test("polls that are still running are silent waits, not transitions", async () => {
  const w = world();
  (w.tripo as FakeTripo).pollsToSuccess = 3;
  await drain(w, 40);
  assertEquals(w.job(SCAN).status, "done");
  assertEquals(w.breadcrumbs.length, 5);
});

Deno.test("kill switch: flags disabled or unreadable -> idle, nothing claimed", async () => {
  const w = world({ flags: { enabled: false, daily_credit_cap: 300, per_user_cap: 2, min_balance: 100, paused_reason: "test", require_slot: false } });
  assertEquals(await runTick(w.deps(), { tickId: "t" }), { ok: true, idle: "disabled", jobs: [] });
  const w2 = world({ flags: null });
  assertEquals(await runTick(w2.deps(), { tickId: "t" }), { ok: true, idle: "disabled", jobs: [] });
  assertEquals(w2.job(SCAN).locked_by, null);
});

Deno.test("idempotency: both models already published -> done with 0 credits, no Tripo call", async () => {
  const w = world({ models: { [`scan_${SCAN}_map.glb`]: new Uint8Array(3), [`scan_${SCAN}.glb`]: new Uint8Array(3) } });
  const r = await tick1(w.deps(), { tickId: "t" });
  assertEquals(r.to, "done");
  assertEquals(w.job(SCAN).credits_spent, 0);
  assertEquals(w.job(SCAN).reason, "already-published");
  assertEquals((w.tripo as FakeTripo).calls.length, 0);
});

Deno.test("idempotency: a twin the worker did not publish -> skipped manual-in-progress, even mid-flight", async () => {
  const w = world({ models: { [`scan_${SCAN}_map.glb`]: new Uint8Array(3) } }, { status: "generating", tripo_gen_task: "gen-x", generate_submitted_at: new Date().toISOString() });
  const r = await tick1(w.deps(), { tickId: "t" });
  assertEquals(r.to, "skipped");
  assertEquals(w.job(SCAN).reason, "manual-in-progress");
  assertEquals((w.tripo as FakeTripo).calls.length, 0);
});

Deno.test("a twin the worker DID publish is resumed, not skipped", async () => {
  const w = world();
  const t = w.tripo as FakeTripo;
  // run to converting_hero
  await drain(w, 4);
  assertEquals(w.job(SCAN).status, "converting_hero");
  assert(w.models.has(`scan_${SCAN}_map.glb`));
  w.advance(61);
  const r = await tick1(w.deps(), { tickId: "t" });
  assertEquals(r.to, "done");
  assertEquals(t.calls.filter((c) => c.method.includes("convert")).length, 2);
});

Deno.test("junk ids and empty folders are skipped without listing/spending", async () => {
  const w = new FakeWorld({ jobs: [newJob("_selftest"), newJob("claudetest-20260821-000001"), newJob("ghost-20260902-000000")] });
  await drain(w, 10);
  assertEquals(w.job("_selftest").reason, "junk");
  assertEquals(w.job("claudetest-20260821-000001").reason, "junk");
  assertEquals(w.job("ghost-20260902-000000").reason, "junk");
});

Deno.test("photos still arriving: waits (no breadcrumb), then fails after 20 waits", async () => {
  const w = new FakeWorld({ jobs: [newJob(SCAN)], carScans: { [`${SCAN}/manifest.json`]: new Uint8Array(10), [`${SCAN}/01-front.jpg`]: new Uint8Array(500000) } });
  for (let i = 0; i < 19; i++) {
    const r = await tick1(w.deps(), { tickId: `t${i}` });
    assertEquals(r.to, "queued");
    w.advance(61);
  }
  assertEquals(w.job(SCAN).waits, 19);
  assertEquals(w.breadcrumbs.length, 0);
  const r = await tick1(w.deps(), { tickId: "last" });
  assertEquals(r.to, "failed");
  assertEquals(w.job(SCAN).reason, "incomplete-upload");
});

Deno.test("photos before manifest: a job enqueued early waits, then proceeds once the manifest lands", async () => {
  const folder = seedFolder(SCAN);
  const manifest = folder[`${SCAN}/manifest.json`];
  delete folder[`${SCAN}/manifest.json`];
  const w = world({ carScans: folder });
  assertEquals((await tick1(w.deps(), { tickId: "t0" })).to, "queued");
  w.carScans.set(`${SCAN}/manifest.json`, manifest);
  w.advance(61);
  assertEquals((await tick1(w.deps(), { tickId: "t1" })).to, "fetching");
});

Deno.test("a lap the app reported incomplete (uploaded=3) is skipped, never rendered", async () => {
  const folder = seedFolder(SCAN);
  const m = JSON.parse(new TextDecoder().decode(folder[`${SCAN}/manifest.json`]));
  m.uploaded = 3;
  m.failed = ["Rear"];
  folder[`${SCAN}/manifest.json`] = new TextEncoder().encode(JSON.stringify(m));
  const w = world({ carScans: folder });
  const r = await tick1(w.deps(), { tickId: "t" });
  assertEquals(r.to, "skipped");
  assertEquals(w.job(SCAN).reason, "manifest-uploaded-3");
});

Deno.test("per-user cap: third render for a handle waits once, then fails user-cap; no generate", async () => {
  const w = world({
    jobs: [
      newJob("tester-1", { handle: "tester", status: "done", credits_spent: 50 }),
      newJob("tester-2", { handle: "tester", status: "done", credits_spent: 50 }),
      newJob(SCAN),
    ],
  });
  const t = w.tripo as FakeTripo;
  await tick1(w.deps(), { tickId: "t0" }); // queued -> fetching
  w.advance(61);
  const r1 = await tick1(w.deps(), { tickId: "t1" });
  assertEquals(r1.to, "fetching");
  assertEquals(w.job(SCAN).reason, "wait:user-cap");
  w.advance(5 * 60 + 1);
  const r2 = await tick1(w.deps(), { tickId: "t2" });
  assertEquals(r2.to, "failed");
  assertEquals(w.job(SCAN).reason, "user-cap");
  assertEquals(t.calls.filter((c) => c.method.includes("multiview")).length, 0);
  assertEquals(w.job(SCAN).credits_spent, 0);
});

Deno.test("daily cap: 300 credits in 24 h -> wait, no generate; clears after the window", async () => {
  const w = world({
    jobs: [newJob("other-1", { handle: "other", status: "done", credits_spent: 300, generate_submitted_at: new Date("2026-09-02T11:00:00Z").toISOString() }), newJob(SCAN)],
  });
  const t = w.tripo as FakeTripo;
  await tick1(w.deps(), { tickId: "t0" });
  w.advance(61);
  const r = await tick1(w.deps(), { tickId: "t1" });
  assertEquals(r.to, "fetching");
  assertEquals(w.job(SCAN).reason, "wait:daily-cap");
  assertEquals(t.calls.filter((c) => c.method.includes("multiview")).length, 0);
  w.advance(24 * 3600);
  const r2 = await tick1(w.deps(), { tickId: "t2" });
  assertEquals(r2.to, "generating");
});

Deno.test("balance floor: below min_balance + 50 -> wait, no generate", async () => {
  const w = world();
  (w.tripo as FakeTripo).balanceValue = 120;
  await tick1(w.deps(), { tickId: "t0" });
  w.advance(61);
  const r = await tick1(w.deps(), { tickId: "t1" });
  assertEquals(r.to, "fetching");
  assertEquals(w.job(SCAN).reason, "wait:balance");
  assertEquals(w.job(SCAN).credits_spent, 0);
});

Deno.test("Tripo says insufficient credits -> NO self-disable (item 7): paused_reason set, enabled untouched, job waits 10 min", async () => {
  const w = world();
  const t = w.tripo as FakeTripo;
  t.failNextGenerate = new InsufficientCredits("Insufficient credits", 400);
  // balance passes the guard going IN (so paidSubmit is actually reached and Tripo's
  // rejection fires); Tripo reporting insufficient credits then reflects in a lower
  // balance from here on, same as reality.
  await tick1(w.deps(), { tickId: "t0" });
  w.advance(61);
  const r = await tick1(w.deps(), { tickId: "t1" });
  assertEquals(r.to, "fetching");
  assertEquals(w.flags!.enabled, true, "NO SELF-DISABLE: other jobs keep spending normally");
  assertEquals(w.flags!.paused_reason, "tripo-credits");
  assertEquals(w.job(SCAN).reason, "wait:tripo-credits");
  assertEquals(w.job(SCAN).credits_spent, 0, "the intent ledger is rolled back");
  assertEquals(w.job(SCAN).paid_call, null);
  assertEquals(w.job(SCAN).generate_submitted_at, null);
  assert(w.breadcrumbs.some((b) => b.message.includes("PAUSED tripo-credits")));
  // pipeline is NOT idle:disabled — the tick still claims and advances the job. The
  // account is still empty (still below the floor), so the balance guard keeps waiting.
  t.balanceValue = 50;
  w.advance(CREDITS_PAUSE_S + 1);
  const r2 = await tick1(w.deps(), { tickId: "t2" });
  assertEquals(r2.to, "fetching", "flags.enabled stayed true, so the job is reclaimed, not idle:disabled");
  assertEquals(w.job(SCAN).reason, "wait:balance", "balance guard re-checked Tripo live — still low, still waiting");
  assertEquals(w.flags!.paused_reason, "tripo-credits", "not cleared yet: balance has not recovered");
  // top up the Tripo account — the balance guard clears paused_reason the moment it passes
  t.balanceValue = 1890;
  w.advance(GUARD_WAIT_S + 1);
  const r3 = await tick1(w.deps(), { tickId: "t3" });
  assertEquals(r3.to, "generating", "resumed rendering with no human flipping a switch");
  assertEquals(w.flags!.paused_reason, null);
  assert(w.breadcrumbs.some((b) => b.message.includes("RESUMED balance=1890")));
});

Deno.test("a failed generate is terminal and NEVER resubmitted", async () => {
  const w = world();
  const t = w.tripo as FakeTripo;
  t.failGenerateStatus = "failed";
  await drain(w, 10);
  assertEquals(w.job(SCAN).status, "failed");
  assertEquals(w.job(SCAN).reason, "gen-failed");
  assertEquals(w.job(SCAN).last_error, "gen-failed-refund-expected");
  assertEquals(t.calls.filter((c) => c.method.includes("multiview")).length, 1);
  w.advance(600);
  assertEquals((await tick1(w.deps(), { tickId: "again" })).idle, "empty");
});

Deno.test("twin that fails a Mapbox gate -> failed qc-*, hero convert never bought (40 credits, not 50)", async () => {
  const w = world({ fakeUrls: { "fake://twin.glb": makeTestGlb({ verts: 14201, indexType: 5125 }), "fake://hero.glb": makeTestGlb() } });
  const t = w.tripo as FakeTripo;
  await drain(w, 10);
  assertEquals(w.job(SCAN).status, "failed");
  assert(w.job(SCAN).reason!.startsWith("qc-indices"));
  assertEquals(w.job(SCAN).credits_spent, 40);
  assertEquals(t.calls.filter((c) => c.method.includes("convert")).length, 1);
  assertEquals(w.publishOrder, []);
});

Deno.test("409 on the twin with EQUAL bytes continues; with DIFFERENT bytes -> twin-conflict, never deleted", async () => {
  // equal: pre-seed the exact finished bytes the worker will produce by running once and copying
  const w1 = world();
  await drain(w1, 4);
  const twinName = `scan_${SCAN}_map.glb`;
  const finished = w1.models.get(twinName)!;
  // the bucket answers 409 to our upload and already holds OUR bytes (a race with an
  // identical upload); pre-flight saw no twin, so this is the publish() 409 path
  const w2 = world({ duplicateOn: new Set([twinName]), duplicateBytes: { [twinName]: finished } });
  await drain(w2, 10);
  assertEquals(w2.job(SCAN).status, "done");
  assertEquals(w2.job(SCAN).credits_spent, 50);
  // different: a foreign file landed under our name between pre-flight and upload
  const w3 = world({ duplicateOn: new Set([twinName]) });
  await drain(w3, 10);
  assertEquals(w3.job(SCAN).reason, "twin-conflict");
  assertEquals(w3.models.get(twinName), new Uint8Array([1, 2, 3]));
});

Deno.test("expired model URL: one re-convert (+10), a second expiry fails", async () => {
  const w = world({ expireOnce: new Set(["fake://twin.glb"]) });
  const t = w.tripo as FakeTripo;
  await drain(w, 12);
  assertEquals(w.job(SCAN).status, "done");
  assertEquals(w.job(SCAN).credits_spent, 60);
  assertEquals(w.job(SCAN).convert_retries, 1);
  assertEquals(t.calls.filter((c) => c.method.includes("convert")).length, 3);
  const w2 = world({ expireOnce: new Set(["fake://twin.glb"]) });
  await drain(w2, 4);
  w2.expireOnce.add("fake://twin.glb");
  await drain(w2, 10);
  assertEquals(w2.job(SCAN).reason, "map-url-expired");
});

Deno.test("generic error policy: exceptions back off and fail on the 5th; attempts reset on a transition", async () => {
  const w = world();
  const deps = w.deps();
  let boom = true;
  const flaky = { ...deps, listScan: (id: string) => (boom ? Promise.reject(new Error("storage 503")) : deps.listScan(id)) };
  for (let i = 1; i <= 4; i++) {
    const r = await tick1(flaky, { tickId: `e${i}` });
    assertEquals(r.ok, false);
    assertEquals(w.job(SCAN).attempts, i);
    assertEquals(w.job(SCAN).status, "queued");
    w.advance(600);
  }
  boom = false;
  const r = await tick1(flaky, { tickId: "ok" });
  assertEquals(r.to, "fetching");
  assertEquals(w.job(SCAN).attempts, 0);
  // and a 5th consecutive failure is terminal
  const w2 = world();
  const dead = { ...w2.deps(), listScan: () => Promise.reject(new Error("storage 503")) };
  for (let i = 1; i <= 5; i++) {
    await tick1(dead, { tickId: `e${i}` });
    w2.advance(600);
  }
  assertEquals(w2.job(SCAN).status, "failed");
  assertEquals(w2.job(SCAN).reason, "errors:queued");
});

Deno.test("kill-switch pause does NOT expire a paid job: 61 min disabled mid-generating, resume -> converting_map", async () => {
  const w = world();
  await drain(w, 2);
  assertEquals(w.job(SCAN).status, "generating");
  assertEquals(w.job(SCAN).credits_spent, 30);
  w.flags!.enabled = false;
  w.advance(61 * 60);
  assertEquals((await tick1(w.deps(), { tickId: "paused" })).idle, "disabled");
  w.flags!.enabled = true;
  const r = await tick1(w.deps(), { tickId: "resumed" });
  assertEquals(r.to, "converting_map", `after resume: ${r.from}->${r.to} ${r.detail ?? r.error}`);
  assertEquals(w.job(SCAN).credits_spent, 40);
  w.advance(61);
  await drain(w, 10);
  assertEquals(w.job(SCAN).status, "done");
});

Deno.test("a Tripo task that never finishes fails after GEN_MAX_POLLS polls — a poll COUNT, not a wall clock", async () => {
  const w = world();
  (w.tripo as FakeTripo).pollsToSuccess = 10_000;
  await drain(w, 2);
  assertEquals(w.job(SCAN).status, "generating");
  for (let i = 0; i < GEN_MAX_POLLS; i++) {
    const r = await tick1(w.deps(), { tickId: `p${i}` });
    assertEquals(r.to, "generating");
    w.advance(31);
  }
  assertEquals(w.job(SCAN).state_polls, GEN_MAX_POLLS);
  const r = await tick1(w.deps(), { tickId: "last" });
  assertEquals(r.to, "failed");
  assertEquals(w.job(SCAN).reason, "gen-timeout");
  // and the same count applies to a convert (CONVERT_MAX_POLLS), reset on the transition
  const w2 = world();
  const t2 = w2.tripo as FakeTripo;
  await drain(w2, 3);
  assertEquals(w2.job(SCAN).status, "converting_map");
  assertEquals(w2.job(SCAN).state_polls, 0);
  t2.pollsToSuccess = 10_000;
  for (let i = 0; i < CONVERT_MAX_POLLS; i++) {
    await tick1(w2.deps(), { tickId: `c${i}` });
    w2.advance(31);
  }
  assertEquals((await tick1(w2.deps(), { tickId: "last" })).to, "failed");
  assertEquals(w2.job(SCAN).reason, "map-timeout");
});

// ── lost replies: the reply to a paid POST never arrives (timeout / abort / edge kill) ──

Deno.test("LOST generate reply: exactly ONE generate is ever bought, job fails gen-submit-unknown, ledger keeps the 30", async () => {
  const w = world();
  const t = w.tripo as FakeTripo;
  t.loseNextGenerate = true;
  await drain(w, 20);
  const j = w.job(SCAN);
  assertEquals(t.calls.filter((c) => c.method.includes("multiview")).length, 1, "generates POSTed");
  assertEquals(t.created.filter((id) => id.startsWith("gen")).length, 1, "generates Tripo created (charged)");
  assertEquals(j.status, "failed");
  assertEquals(j.reason, "gen-submit-unknown");
  assertEquals(j.credits_spent, 30, "conservative ledger: Tripo may have charged");
  assertEquals(j.paid_call, "gen");
  assert(j.paid_call_started_at, "the intent marker stays on the row for the runbook");
  assert(j.generate_submitted_at, "creditsLast24h sees the spend");
  assertEquals(await w.deps().creditsLast24h(), 30);
  assertEquals(await w.deps().countUserRenders("tester", "other"), 1, "per-user cap sees the spend");
  // nothing more ever happens to it
  w.advance(3600);
  assertEquals((await tick1(w.deps(), { tickId: "again" })).idle, "empty");
});

Deno.test("LOST generate reply with the tick killed outright (marker on the row, no catch ran): next tick fails without re-POSTing", async () => {
  // Simulate the edge wall-clock kill: the pre-POST row update landed, nothing after it.
  const w = world({}, { status: "fetching", handle: "tester", credits_spent: 30, paid_call: "gen", paid_call_started_at: "2026-09-02T11:58:00Z", generate_submitted_at: "2026-09-02T11:58:00Z" });
  const t = w.tripo as FakeTripo;
  const r = await tick1(w.deps(), { tickId: "t" });
  assertEquals(r.to, "failed");
  assertEquals(w.job(SCAN).reason, "gen-submit-unknown");
  assertEquals(t.calls.filter((c) => c.method.includes("multiview")).length, 0);
  assertEquals(w.job(SCAN).credits_spent, 30);
});

Deno.test("LOST convert reply: ONE bounded retry (+10 in the ledger), then done at 60; a second loss fails map-submit-unknown", async () => {
  const w = world();
  const t = w.tripo as FakeTripo;
  t.loseNextConverts = 1;
  await drain(w, 20);
  assertEquals(w.job(SCAN).status, "done");
  assertEquals(w.job(SCAN).credits_spent, 60, "30 + 10 (lost, kept) + 10 (retry) + 10 (hero)");
  assertEquals(w.job(SCAN).convert_retries, 1);
  assertEquals(t.calls.filter((c) => c.method.includes("convert")).length, 3, "map (lost), map (retry), hero");
  assert(w.breadcrumbs.some((b) => b.message.includes("LOST map reply")));
  // two losses in a row: the second one is terminal — never a third POST
  const w2 = world();
  const t2 = w2.tripo as FakeTripo;
  t2.loseNextConverts = 2;
  await drain(w2, 20);
  assertEquals(w2.job(SCAN).status, "failed");
  assertEquals(w2.job(SCAN).reason, "map-submit-unknown");
  assertEquals(t2.calls.filter((c) => c.method.includes("convert")).length, 2);
  assertEquals(w2.job(SCAN).credits_spent, 50, "30 + 10 + 10, both kept");
  w2.advance(3600);
  assertEquals((await tick1(w2.deps(), { tickId: "again" })).idle, "empty");
});

// ── the twin is published, then something goes wrong before the hero is bought ──

Deno.test("twin published, then the hero convert reply is LOST: the twin stays OURS (never manual-in-progress), one retry, done", async () => {
  const w = world();
  const t = w.tripo as FakeTripo;
  await drain(w, 3);
  assertEquals(w.job(SCAN).status, "converting_map");
  t.loseNextConverts = 1; // the NEXT convert is the hero
  const r = await tick1(w.deps(), { tickId: "lost" });
  assertEquals(r.to, "converting_map", `${r.from}->${r.to} ${r.detail}`);
  assert(w.models.has(`scan_${SCAN}_map.glb`), "twin is in the bucket");
  assert(w.job(SCAN).twin_published_at, "ownership was persisted BEFORE the hero POST");
  assertEquals(w.job(SCAN).twin_pending_sha256, null);
  w.advance(61);
  await drain(w, 10);
  const j = w.job(SCAN);
  assertEquals(j.status, "done", `reason=${j.reason}`);
  assertEquals(j.credits_spent, 60);
  assertEquals(w.publishOrder, [`scan_${SCAN}_map.glb`, `scan_${SCAN}.glb`]);
  assertEquals(t.calls.filter((c) => c.method.includes("convert")).length, 3);
  assert(!w.breadcrumbs.some((b) => b.message.includes("manual-in-progress")));
});

Deno.test("twin published, then the hero convert is REJECTED once (definite): generic retry, done with credits_spent=50, never manual-in-progress", async () => {
  const w = world();
  const t = w.tripo as FakeTripo;
  await drain(w, 3);
  t.rejectNextConverts = 1;
  const r = await tick1(w.deps(), { tickId: "rejected" });
  assertEquals(r.ok, false);
  assertEquals(w.job(SCAN).status, "converting_map");
  assertEquals(w.job(SCAN).credits_spent, 40, "a definite rejection rolls the +10 back");
  assertEquals(w.job(SCAN).paid_call, null);
  assert(w.job(SCAN).twin_published_at);
  w.advance(600);
  await drain(w, 10);
  const j = w.job(SCAN);
  assertEquals(j.status, "done", `reason=${j.reason}`);
  assertEquals(j.credits_spent, 50);
  assertEquals(t.calls.filter((c) => c.method.includes("convert")).length, 3, "map, hero (rejected), hero");
  assertEquals(t.created.length, 3, "Tripo only ever created gen + 2 converts");
});

Deno.test("tick died between the twin UPLOAD and the ownership write: pre-flight reclaims it by twin_pending_sha256; foreign bytes are still skipped", async () => {
  const w1 = world();
  await drain(w1, 10);
  const twinName = `scan_${SCAN}_map.glb`;
  const finished = w1.models.get(twinName)!;
  const sha = await sha256Hex(finished);
  const dead = { status: "converting_map" as const, handle: "tester", credits_spent: 40, tripo_gen_task: "gen-1", tripo_map_task: "map-2", twin_pending_sha256: sha };
  const w2 = world({ models: { [twinName]: finished } }, dead);
  const t2 = w2.tripo as FakeTripo;
  const r = await tick1(w2.deps(), { tickId: "t" });
  assertEquals(r.to, "converting_hero", `${r.from}->${r.to} ${r.detail}`);
  assert(w2.job(SCAN).twin_published_at);
  assertEquals(w2.job(SCAN).twin_sha256, sha);
  assert(w2.breadcrumbs.some((b) => b.message.includes("twin reclaimed")));
  assertEquals(t2.calls.filter((c) => c.method.includes("convert")).length, 1, "only the hero was bought");
  w2.advance(61);
  await drain(w2, 10);
  assertEquals(w2.job(SCAN).status, "done");
  assertEquals(w2.job(SCAN).credits_spent, 50);
  // same row, but the bucket holds someone else's twin -> hands off
  const w3 = world({ models: { [twinName]: new Uint8Array([7, 7, 7]) } }, dead);
  assertEquals((await tick1(w3.deps(), { tickId: "t" })).to, "skipped");
  assertEquals(w3.job(SCAN).reason, "manual-in-progress");
  assertEquals((w3.tripo as FakeTripo).calls.length, 0);
});

Deno.test("claim: at most ONE live lease in `fetching` — the cap reads cannot race another job's generate", async () => {
  const w = new FakeWorld({
    jobs: [newJob("x-1", { status: "fetching", handle: "x" }), newJob("x-2", { status: "fetching", handle: "x" }), newJob("y-3")],
    carScans: { ...seedFolder("x-1"), ...seedFolder("x-2"), ...seedFolder("y-3") },
  });
  const d = w.deps();
  w.advance(1);
  const a = await d.claim("t1");
  assertEquals(a?.scan_id, "x-1");
  w.advance(1); // claims stamp updated_at; oldest-first ordering needs the clock to move, as it does in SQL
  const b = await d.claim("t2"); // x-1 holds the only fetching lease -> x-2 must NOT be handed out
  assertEquals(b?.scan_id, "y-3");
  w.advance(1);
  assertEquals(await d.claim("t3"), null);
  await d.updateJob("x-1", { lease_until: null, locked_by: null });
  w.advance(1);
  assertEquals((await d.claim("t4"))?.scan_id, "x-2");
});

Deno.test("pinning a scan advances only that job", async () => {
  const w = new FakeWorld({ jobs: [newJob("a-1"), newJob("b-2")], carScans: { ...seedFolder("a-1"), ...seedFolder("b-2") } });
  const r = await tick1(w.deps(), { tickId: "t", scan: "b-2" });
  assertEquals(r.scan, "b-2");
  assertEquals(w.job("a-1").status, "queued");
  assertEquals(w.job("b-2").status, "fetching");
});

Deno.test("lease is released after every tick", async () => {
  const w = world();
  await tick1(w.deps(), { tickId: "t" });
  assertEquals(w.job(SCAN).lease_until, null);
  assertEquals(w.job(SCAN).locked_by, null);
});

// ══════════════════════════════════════════════════════════════════════════
// launch sizing v3 (2026-09-02) — items 1, 3, 4, 5, 6
// ══════════════════════════════════════════════════════════════════════════

/** `FakeWorld`'s claim() mirrors claim_scan_job's "oldest updated_at first" ordering, and
 *  a claimed-then-advanced job's updated_at is rewritten to the TICK's frozen clock value
 *  (deps.now() does not tick forward mid-tick, in the fakes OR in real Postgres wall time
 *  within a single statement). If every seeded job shared the SAME initial updated_at
 *  (`newJob`'s default), the just-advanced job would tie the still-untouched ones and,
 *  by stable-sort/Map-insertion-order, win the tie AGAIN — exactly the same-job-reclaimed
 *  bug `seen` (runTick) exists to catch, but for the wrong reason here (a test artifact,
 *  not real contention). Staggering strictly BEFORE the world's clock, increasing by id
 *  order, guarantees each not-yet-processed job sorts ahead of any job this tick already
 *  bumped to "now" — letting a burst of DISTINCT jobs each get their turn, as intended. */
function burstWorld(ids: string[], over: Partial<ConstructorParameters<typeof FakeWorld>[0]> = {}) {
  return new FakeWorld({
    jobs: ids.map((id, i) => newJob(id, { updated_at: new Date(new Date(FAKE_EPOCH).getTime() - (ids.length - i) * 1000).toISOString() })),
    carScans: ids.reduce((acc, id) => ({ ...acc, ...seedFolder(id) }), {} as Record<string, Uint8Array>),
    ...over,
  });
}

// ── item 1: several jobs per tick ────────────────────────────────────────────

Deno.test("item 1: a tick with 3 claimable jobs advances all 3, not just the first", async () => {
  const ids = ["burst-1-20260902-000000", "burst-2-20260902-000000", "burst-3-20260902-000000"];
  const w = burstWorld(ids);
  const r = await runTick(w.deps(), { tickId: "t" });
  assertEquals(r.idle, undefined);
  assertEquals(r.jobs.length, 3, "all three claimable jobs advanced in ONE tick");
  assert(r.jobs.every((jr) => jr.from === "queued" && jr.to === "fetching"));
  assertEquals(new Set(r.jobs.map((jr) => jr.scan)), new Set(ids), "three DISTINCT jobs, not the same one three times");
  for (const id of ids) assertEquals(w.job(id).status, "fetching");
  // item 9: the tick summary breadcrumb fires because more than one job advanced
  const summary = w.breadcrumbs.find((b) => b.message.startsWith("carscan-worker tick jobs="));
  assert(summary, "tick summary breadcrumb present");
  assertEquals(summary!.handle, null);
  assert(summary!.message.startsWith("carscan-worker tick jobs=3 ms="));
});

Deno.test("item 1: a single-job tick does NOT get a tick-summary breadcrumb (preserves the silent-idle-poll invariant)", async () => {
  const w = world();
  await tick1(w.deps(), { tickId: "t" }); // queued -> fetching, one job, one breadcrumb
  assertEquals(w.breadcrumbs.length, 1);
  assert(!w.breadcrumbs[0].message.startsWith("carscan-worker tick jobs="));
});

Deno.test("item 1: the soft work budget (TICK_WORK_BUDGET_MS) stops the loop with jobs left for the next tick", async () => {
  const ids = ["slow-1-20260902-000000", "slow-2-20260902-000000", "slow-3-20260902-000000"];
  const w = burstWorld(ids);
  const base = w.deps();
  // Simulate a tick whose per-job work is slow: the clock jumps forward a lot every time
  // a job is claimed, so the SECOND budget check (top of the next loop iteration) sees
  // the soft budget already blown.
  const slow: Deps = {
    ...base,
    claim: async (tickId, scan) => {
      const j = await base.claim(tickId, scan);
      if (j) w.advance(60); // 60s of "work" per job — three of them blow the 100s soft budget
      return j;
    },
  };
  const r = await runTick(slow, { tickId: "t" });
  assert(r.jobs.length >= 1 && r.jobs.length < ids.length, `expected partial progress, got ${r.jobs.length} of ${ids.length}`);
  const stillQueued = ids.filter((id) => w.job(id).status === "queued");
  assert(stillQueued.length > 0, "at least one job left queued for the next tick, not silently dropped");
});

Deno.test("item 1: the hard cap MAX_JOBS_PER_TICK stops the loop even with time budget and claimable work left", async () => {
  const n = MAX_JOBS_PER_TICK + 2;
  const ids = Array.from({ length: n }, (_, i) => `cap-${i}-20260902-000000`);
  const w = burstWorld(ids);
  const r = await runTick(w.deps(), { tickId: "t" });
  assertEquals(r.jobs.length, MAX_JOBS_PER_TICK);
  const stillQueued = ids.filter((id) => w.job(id).status === "queued").length;
  assertEquals(stillQueued, n - MAX_JOBS_PER_TICK);
});

// ── item 3: abort / budget defers before a paid POST — zero ledger change ───

Deno.test("item 3: an aborted tick signal defers the generate POST, zero ledger change, tokens kept", async () => {
  const w = world({}, { status: "fetching", handle: "tester", tripo_file_tokens: { front: "f", left: "l", back: "b", right: "r" } });
  const controller = new AbortController();
  controller.abort();
  const r = await tick1(w.deps(), { tickId: "t", signal: controller.signal });
  assertEquals(r.to, "fetching");
  assertEquals(r.detail, "defer gen: budget");
  assertEquals(w.job(SCAN).credits_spent, 0);
  assertEquals(w.job(SCAN).paid_call, null);
  assertEquals(w.job(SCAN).tripo_file_tokens, { front: "f", left: "l", back: "b", right: "r" }, "already-uploaded tokens are kept");
  assertEquals((w.tripo as FakeTripo).calls.filter((c) => c.method.includes("multiview")).length, 0);
});

Deno.test("item 3: an aborted tick signal defers mid photo-upload before any upload runs, tokens untouched", async () => {
  const w = world({}, { status: "fetching", handle: "tester" });
  const controller = new AbortController();
  controller.abort();
  const r = await tick1(w.deps(), { tickId: "t", signal: controller.signal });
  assertEquals(r.to, "fetching");
  assertEquals(r.detail, "defer upload: budget");
  assertEquals(w.job(SCAN).tripo_file_tokens, null);
  assertEquals(w.job(SCAN).credits_spent, 0);
  assertEquals((w.tripo as FakeTripo).calls.length, 0);
});

Deno.test("item 3: remaining tick budget under PAID_CALL_RESERVE_MS defers too, not only an aborted signal", async () => {
  const w = world({}, { status: "fetching", handle: "tester", tripo_file_tokens: { front: "f", left: "l", back: "b", right: "r" } });
  const base = w.deps();
  let first: number | null = null;
  // First call establishes the tick's real start (and thus deadline); every call after
  // that reports a time deep enough into the budget that remainingMs() < PAID_CALL_RESERVE_MS,
  // without tripping the outer loop's OWN (looser) soft-budget check.
  const tight: Deps = {
    ...base,
    now: () => {
      if (first === null) {
        first = base.now().getTime();
        return new Date(first);
      }
      return new Date(first + (TICK_WORK_BUDGET_MS - PAID_CALL_RESERVE_MS + 1000));
    },
  };
  const r = await tick1(tight, { tickId: "t" });
  assertEquals(r.to, "fetching");
  assertEquals(r.detail, "defer gen: budget");
  assertEquals(w.job(SCAN).credits_spent, 0);
});

// ── item 4: a Tripo 5xx with a JSON code is AMBIGUOUS, not a definite rejection ──

Deno.test("item 4: 5xx-with-code on a CONVERT is ambiguous -> lost-response retry, credits kept (never rolled back)", async () => {
  const w = world();
  const t = w.tripo as FakeTripo;
  t.reject5xxNextConverts = 1;
  await drain(w, 20);
  assertEquals(w.job(SCAN).status, "done");
  assertEquals(w.job(SCAN).credits_spent, 60, "30 + 10 (5xx, kept) + 10 (retry) + 10 (hero)");
  assertEquals(w.job(SCAN).convert_retries, 1);
  assertEquals(t.calls.filter((c) => c.method.includes("convert")).length, 3, "map (5xx), map (retry), hero");
  assert(w.breadcrumbs.some((b) => b.message.includes("LOST map reply")));
});

Deno.test("item 4: 5xx-with-code on the GENERATE is ambiguous -> never re-POSTed, fails gen-submit-unknown, ledger kept", async () => {
  const w = world();
  const t = w.tripo as FakeTripo;
  t.reject5xxNextGenerate = true;
  await drain(w, 10);
  const j = w.job(SCAN);
  assertEquals(j.status, "failed");
  assertEquals(j.reason, "gen-submit-unknown");
  assertEquals(j.credits_spent, 30, "conservative ledger: Tripo may have created the task despite the 5xx");
  assertEquals(t.calls.filter((c) => c.method.includes("multiview")).length, 1, "exactly one generate POST, never re-tried");
});

Deno.test("item 4 negative control: a SUB-500 status with a JSON code is STILL a definite rejection (rolled back) — httpStatus alone changed, not the code check", async () => {
  const w = world();
  const t = w.tripo as FakeTripo;
  t.rejectNextConverts = 1; // 400 + code 2002, unchanged behaviour
  const r = await tick1(w.deps(), { tickId: "t0" });
  assertEquals(r.to, "fetching");
  w.advance(61);
  await tick1(w.deps(), { tickId: "t1" });
  w.advance(61);
  const before = w.job(SCAN).credits_spent; // 30, after the generate
  const rr = await tick1(w.deps(), { tickId: "t2" });
  assertEquals(rr.ok, false, "a definite rejection throws out of paidSubmit into the generic retry policy");
  assertEquals(w.job(SCAN).credits_spent, before, "the +10 intent write was rolled back within the same tick, unlike the 5xx case above");
});

// ── item 5: guards + paidSubmit both reserve MAX_CREDITS_PER_JOB, not CREDITS_PER_CAR ──

Deno.test("item 5: paidSubmit refuses to exceed MAX_CREDITS_PER_JOB even if every guard already passed", async () => {
  const w = world(
    {},
    {
      status: "converting_map",
      handle: "tester",
      credits_spent: MAX_CREDITS_PER_JOB - 5, // 55: the hero's 10 credits would push it to 65 > 60
      tripo_gen_task: "gen-1",
      tripo_map_task: "map-1",
      twin_sha256: "deadbeef",
      twin_published_at: FAKE_EPOCH,
    },
  );
  const r = await tick1(w.deps(), { tickId: "t" });
  assertEquals(r.to, "failed");
  assertEquals(r.detail, "FAILED ceiling");
  assertEquals(w.job(SCAN).reason, "ceiling");
  assertEquals(w.job(SCAN).credits_spent, MAX_CREDITS_PER_JOB - 5, "no spend: the assert fires before the intent write");
  assertEquals((w.tripo as FakeTripo).calls.filter((c) => c.method.includes("convert")).length, 0);
});

Deno.test("item 5: the daily-cap and balance guards reserve MAX_CREDITS_PER_JOB (60), not the optimistic CREDITS_PER_CAR (50)", async () => {
  // daily cap: 300 - 250 spent = 50 headroom left. 50 < CREDITS_PER_CAR? no (equal-ish),
  // but 50 < MAX_CREDITS_PER_JOB(60) -> must wait under the new reservation.
  const w = world({
    jobs: [newJob("other-1", { handle: "other", status: "done", credits_spent: 250, generate_submitted_at: new Date("2026-09-02T11:00:00Z").toISOString() }), newJob(SCAN)],
  });
  await tick1(w.deps(), { tickId: "t0" });
  w.advance(61);
  const r = await tick1(w.deps(), { tickId: "t1" });
  assertEquals(r.to, "fetching");
  assertEquals(w.job(SCAN).reason, "wait:daily-cap", `250 + ${MAX_CREDITS_PER_JOB} > 300, so this must wait even though 250 + ${CREDITS_PER_CAR} <= 300`);
});

// ── item 6: paidSubmit re-reads flags — protects a LATER job in the same multi-job tick ──

Deno.test("item 6: paidSubmit's kill-switch re-read protects a job later in the SAME tick even though runTick's flags snapshot is stale", async () => {
  const idA = "kill-a-20260902-000000";
  const idB = "kill-b-20260902-000000";
  const w = new FakeWorld({
    jobs: [
      // Both updated_at strictly BEFORE the clock (FAKE_EPOCH=12:00:00Z), staggered: A
      // claimed first; after A is advanced its updated_at is rewritten to "now" (12:00:00,
      // itself later than B's still-untouched 11:59:59) so B — not a re-claimed A — is
      // next (see burstWorld's comment above for why this matters).
      newJob(idA, { handle: "a", updated_at: "2026-09-02T11:59:58Z" }),
      newJob(idB, {
        status: "converting_map",
        handle: "b",
        tripo_gen_task: "gen-1",
        tripo_map_task: "map-1",
        twin_sha256: "deadbeef",
        twin_published_at: FAKE_EPOCH,
        credits_spent: 40,
        updated_at: "2026-09-02T11:59:59Z",
      }),
    ],
    carScans: seedFolder(idA),
  });
  const base = w.deps();
  // Simulate an operator's concurrent `update pipeline_flags set enabled=false` landing
  // right after job A is claimed — the kind of race a multi-job tick now has to survive
  // that a single-job-per-tick model never could (item 1 makes this race possible).
  let claims = 0;
  const racy: Deps = {
    ...base,
    claim: async (tickId, scan) => {
      const j = await base.claim(tickId, scan);
      claims++;
      if (claims === 1) w.flags!.enabled = false;
      return j;
    },
  };
  const r = await runTick(racy, { tickId: "t" });
  assertEquals(r.jobs.length, 2);
  assertEquals(w.job(idA).status, "fetching", "job A (queued->fetching) never calls paidSubmit, unaffected either way");
  assertEquals(w.job(idB).status, "converting_map", "job B: hero convert deferred, never bought");
  assertEquals(w.job(idB).reason, "wait:disabled");
  assertEquals(w.job(idB).credits_spent, 40, "no spend — caught before the intent write, not the stale per-tick flags snapshot");
  assertEquals((w.tripo as FakeTripo).calls.filter((c) => c.method.includes("convert")).length, 0);
});

// ── part 2 (2026-09-02): Tripo rate limits + server-issued scan slots ────────

// ── A/B: isRateLimited + paidSubmit's rate-limit handling ────────────────────

Deno.test("item B: a rate-limited generate (code 2000) rolls back the ledger and waits the server's Retry-After — no attempts++, job stays fetching", async () => {
  const w = world({}, { status: "fetching", handle: "tester", tripo_file_tokens: { front: "f", left: "l", back: "b", right: "r" } });
  const t = w.tripo as FakeTripo;
  t.rateLimitNextGenerate = true;
  t.rateLimitRetryAfterS = 45;
  const before = w.clock.getTime();
  const r = await tick1(w.deps(), { tickId: "t" });
  assertEquals(r.to, "fetching", `${r.from}->${r.to} ${r.detail ?? r.error}`);
  assertEquals(r.detail, "tripo rate-limited gen");
  assertEquals(w.job(SCAN).credits_spent, 0, "rolled back exactly like a definite rejection");
  assertEquals(w.job(SCAN).paid_call, null);
  assertEquals(w.job(SCAN).generate_submitted_at, null);
  assertEquals(w.job(SCAN).attempts, 0, "NOT the generic retry policy: no attempts++, no throw");
  assertEquals(w.job(SCAN).reason, "wait:tripo-rate");
  assertEquals(w.job(SCAN).tripo_file_tokens, { front: "f", left: "l", back: "b", right: "r" }, "already-uploaded tokens are kept");
  const nextRun = new Date(w.job(SCAN).next_run_at).getTime();
  assertEquals(nextRun - before, 45_000, "next_run_at is exactly now + the server's Retry-After");
  assert(w.breadcrumbs.filter((b) => b.message.includes("WAIT tripo-rate on gen")).length === 1, "one breadcrumb per occurrence");
  assertEquals(t.calls.filter((c) => c.method.includes("multiview")).length, 1, "the generate WAS posted (and refused) — never blind-resubmitted within this tick");
});

Deno.test("item B: no Retry-After header defaults to 30s; a rate-limited CONVERT rolls back (not the lost-reply retry) and recovers with no double charge", async () => {
  const w = world();
  const t = w.tripo as FakeTripo;
  t.rateLimitNextConverts = 1;
  t.rateLimitRetryAfterS = undefined; // the fake response carries no header
  t.rateLimitCode = 1007; // the other documented retryable code
  await drain(w, 2); // queued -> fetching -> generating
  assertEquals(w.job(SCAN).status, "generating");
  assertEquals(w.job(SCAN).credits_spent, 30);
  w.advance(61);
  const before = w.clock.getTime();
  const r = await tick1(w.deps(), { tickId: "rl" });
  assertEquals(r.to, "generating", `${r.from}->${r.to} ${r.detail ?? r.error}`);
  assertEquals(w.job(SCAN).credits_spent, 30, "the map convert's +10 intent was rolled back — never kept the way a lost reply is");
  assertEquals(w.job(SCAN).reason, "wait:tripo-rate");
  assertEquals(w.job(SCAN).map_submitted_at, null, "pre-fields reverted too, not just credits_spent");
  const nextRun = new Date(w.job(SCAN).next_run_at).getTime();
  assertEquals(nextRun - before, 30_000, "no Retry-After header -> RATE_LIMIT_RETRY_AFTER_DEFAULT_S");
  // recovers normally once Tripo stops refusing — the retried convert is a FRESH buy
  w.advance(31);
  await drain(w, 10);
  assertEquals(w.job(SCAN).status, "done");
  assertEquals(w.job(SCAN).credits_spent, 50, "30 + 10 (retried map) + 10 (hero) — the rejected attempt was never charged");
  assertEquals(w.job(SCAN).convert_retries, 0, "a rate-limited rejection is not the lost-reply retry — convert_retries is untouched");
});

// ── C: the worker's own view of Tripo's concurrent-task pool ─────────────────

Deno.test("item C: MAX_ACTIVE_TRIPO active jobs -> the pool guard waits, before even calling Tripo's balance endpoint", async () => {
  const statuses: Job["status"][] = ["generating", "converting_map", "converting_hero"];
  const fillers = Array.from({ length: MAX_ACTIVE_TRIPO }, (_, i) => newJob(`filler-${i}`, { status: statuses[i % 3], next_run_at: "2026-09-03T00:00:00Z" }));
  const w = world({ jobs: [...fillers, newJob(SCAN)] });
  const t = w.tripo as FakeTripo;
  await tick1(w.deps(), { tickId: "t0" }); // queued -> fetching
  w.advance(61);
  const r = await tick1(w.deps(), { tickId: "t1" });
  assertEquals(r.to, "fetching", `${r.from}->${r.to} ${r.detail ?? r.error}`);
  assertEquals(w.job(SCAN).reason, "wait:tripo-pool");
  assertEquals(t.calls.filter((c) => c.method.includes("balance")).length, 0, "pool guard is DB-only and runs before the Tripo balance() call");
  assertEquals(t.calls.filter((c) => c.method.includes("multiview")).length, 0);
  assertEquals(w.job(SCAN).credits_spent, 0);
  const waited = new Date(w.job(SCAN).next_run_at).getTime() - w.clock.getTime();
  assertEquals(waited, POLL_S * 1000, "pool-full waits one poll interval, not the 5 min guard wait");
});

Deno.test("item C: MAX_ACTIVE_TRIPO - 1 active jobs clears the guard and proceeds to generate", async () => {
  const fillers = Array.from({ length: MAX_ACTIVE_TRIPO - 1 }, (_, i) => newJob(`filler-${i}`, { status: "generating", next_run_at: "2026-09-03T00:00:00Z" }));
  const w = world({ jobs: [...fillers, newJob(SCAN)] });
  await tick1(w.deps(), { tickId: "t0" });
  w.advance(61);
  const r = await tick1(w.deps(), { tickId: "t1" });
  assertEquals(r.to, "generating", `${r.from}->${r.to} ${r.detail ?? r.error}`);
});

// ── D/E: server-issued scan slots — identity, consumption, the transition flag ─

Deno.test("item E: a server-issued slot supplies identity — handle + user_id come from the slot, not the manifest — and is consumed exactly once", async () => {
  const w = world({ slots: { [SCAN]: newSlot(SCAN, { user_id: "acct-1", handle: "SlotHandle" }) } });
  assertEquals(w.slots.get(SCAN)!.consumed_at, null);
  const r = await tick1(w.deps(), { tickId: "t" });
  assertEquals(r.to, "fetching", `${r.from}->${r.to} ${r.detail ?? r.error}`);
  assertEquals(r.detail, "slot=1 user=acct-1 handle=SlotHandle shots=front,right,rear,left photos=468700/790526/835831/640865");
  assertEquals(w.job(SCAN).handle, "SlotHandle", "identity is the SLOT's handle, not the manifest's ('tester')");
  assertEquals(w.job(SCAN).user_id, "acct-1");
  assert(w.slots.get(SCAN)!.consumed_at, "consumeSlot was called");
});

Deno.test("item E: a slot with no handle snapshot falls back to the normalised manifest handle", async () => {
  const w = world({ slots: { [SCAN]: newSlot(SCAN, { user_id: "acct-2", handle: null }) } });
  const r = await tick1(w.deps(), { tickId: "t" });
  assertEquals(r.to, "fetching");
  assertEquals(w.job(SCAN).handle, "tester", "normaliseHandle(manifest.handle) — the manifest's handle is 'tester' for this scan id");
  assertEquals(w.job(SCAN).user_id, "acct-2");
});

Deno.test("item E: no slot + require_slot=false -> legacy path, unchanged behaviour, user_id stays null", async () => {
  const w = world();
  const r = await tick1(w.deps(), { tickId: "t" });
  assertEquals(r.to, "fetching");
  assertEquals(r.detail, "slot=0 legacy=1 handle=tester shots=front,right,rear,left photos=468700/790526/835831/640865");
  assertEquals(w.job(SCAN).handle, "tester");
  assertEquals(w.job(SCAN).user_id, null);
});

Deno.test("item E: no slot + require_slot=true -> skipped slot-required, never spends", async () => {
  const w = world({ flags: { ...DEFAULT_FLAGS, require_slot: true } });
  const r = await tick1(w.deps(), { tickId: "t" });
  assertEquals(r.to, "skipped");
  assertEquals(w.job(SCAN).reason, "slot-required");
  assertEquals(w.job(SCAN).credits_spent, 0);
  assertEquals((w.tripo as FakeTripo).calls.length, 0);
});

Deno.test("item E: a RELEASED slot is refused even with a complete folder — skipped slot-released, never resumed", async () => {
  const w = world({ slots: { [SCAN]: newSlot(SCAN, { user_id: "acct-3", released_at: FAKE_EPOCH }) } });
  const r = await tick1(w.deps(), { tickId: "t" });
  assertEquals(r.to, "skipped");
  assertEquals(w.job(SCAN).reason, "slot-released");
  assertEquals(w.job(SCAN).user_id, null, "never consumed — the released slot is refused before consumeSlot is called");
});

// ── F: the per-user cap keys on user_id when the job has a slot ──────────────

Deno.test("item F: per-user cap counts by user_id when the job has a slot — NOT by handle, and a different account sharing the handle does not count", async () => {
  const w = world({
    slots: { [SCAN]: newSlot(SCAN, { user_id: "acct-1", handle: "slotHandle" }) },
    jobs: [
      newJob("other-1", { handle: "different-handle", user_id: "acct-1", status: "done", credits_spent: 50 }),
      newJob("other-2", { handle: "slotHandle", user_id: "acct-1", status: "done", credits_spent: 50 }),
      newJob("other-3", { handle: "slotHandle", user_id: "acct-9", status: "done", credits_spent: 50 }), // same handle, DIFFERENT account
      newJob(SCAN),
    ],
  });
  await tick1(w.deps(), { tickId: "t0" }); // queued -> fetching: consumes the slot, sets user_id
  assertEquals(w.job(SCAN).user_id, "acct-1");
  w.advance(61);
  const r = await tick1(w.deps(), { tickId: "t1" });
  assertEquals(r.to, "fetching");
  assertEquals(w.job(SCAN).reason, "wait:user-cap", "acct-1 already has 2 spent renders (other-1, other-2) — other-3 shares the handle but not the account, so it must NOT count");
});

// ── G: a FAILED render releases its slot; a SKIPPED one never does ───────────

Deno.test("item G: a job that fails AFTER consuming a slot gets it released, with a breadcrumb; the ledger stays as spent", async () => {
  const w = world({ slots: { [SCAN]: newSlot(SCAN, { user_id: "acct-1" }) } });
  const t = w.tripo as FakeTripo;
  t.failGenerateStatus = "failed";
  await drain(w, 10);
  assertEquals(w.job(SCAN).status, "failed");
  assertEquals(w.job(SCAN).reason, "gen-failed");
  assertEquals(w.job(SCAN).user_id, "acct-1", "the slot WAS consumed before the failure");
  assert(w.slots.get(SCAN)!.released_at, "releaseSlot was called");
  assert(w.breadcrumbs.some((b) => b.message.includes("slot released reason=gen-failed")));
});

Deno.test("item G: the 5-strikes generic-error path also releases a consumed slot (doesn't only go through fail())", async () => {
  const w = world({ slots: { [SCAN]: newSlot(SCAN, { user_id: "acct-1", consumed_at: FAKE_EPOCH }) } }, { user_id: "acct-1" });
  const dead = { ...w.deps(), listScan: () => Promise.reject(new Error("storage 503")) };
  for (let i = 1; i <= 5; i++) {
    await tick1(dead, { tickId: `e${i}` });
    w.advance(600);
  }
  assertEquals(w.job(SCAN).status, "failed");
  assertEquals(w.job(SCAN).reason, "errors:queued");
  assert(w.slots.get(SCAN)!.released_at, "released even though this path never calls Tick.fail()");
  assert(w.breadcrumbs.some((b) => b.message.includes("slot released reason=errors:queued")));
});

Deno.test("item G: skip() NEVER releases a slot, even when the job already holds a consumed one", async () => {
  const w = world(
    { slots: { [SCAN]: newSlot(SCAN, { user_id: "acct-1", consumed_at: FAKE_EPOCH }) }, models: { [`scan_${SCAN}_map.glb`]: new Uint8Array(3) } },
    { status: "generating", user_id: "acct-1", tripo_gen_task: "gen-x", generate_submitted_at: FAKE_EPOCH },
  );
  const r = await tick1(w.deps(), { tickId: "t" });
  assertEquals(r.to, "skipped");
  assertEquals(w.job(SCAN).reason, "manual-in-progress");
  assertEquals(w.slots.get(SCAN)!.released_at, null, "skip must never release the slot");
  assert(!w.breadcrumbs.some((b) => b.message.includes("slot released")));
});
