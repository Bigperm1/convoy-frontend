// worker_test.ts — the state machine, every money rule, on in-memory fakes.

import { assert, assertEquals } from "jsr:@std/assert@1";
import { CONVERT_MAX_POLLS, CREDITS_PER_CAR, GEN_MAX_POLLS, runTick } from "./worker.ts";
import type { Job } from "./worker.ts";
import { FakeTripo, FakeWorld, makeTestGlb, newJob, seedFolder } from "./fakes.ts";
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

/** Tick until nothing is claimable (idle) or `max` ticks, advancing the clock past next_run_at. */
async function drain(w: FakeWorld, max = 30, scan?: string) {
  const results = [];
  for (let i = 0; i < max; i++) {
    const r = await runTick(w.deps(), { tickId: `t${i}`, scan });
    if (r.idle) break;
    results.push(r);
    w.advance(61);
  }
  return results;
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
  const w = world({ flags: { enabled: false, daily_credit_cap: 300, per_user_cap: 2, min_balance: 100, paused_reason: "test" } });
  assertEquals(await runTick(w.deps(), { tickId: "t" }), { ok: true, idle: "disabled" });
  const w2 = world({ flags: null });
  assertEquals(await runTick(w2.deps(), { tickId: "t" }), { ok: true, idle: "disabled" });
  assertEquals(w2.job(SCAN).locked_by, null);
});

Deno.test("idempotency: both models already published -> done with 0 credits, no Tripo call", async () => {
  const w = world({ models: { [`scan_${SCAN}_map.glb`]: new Uint8Array(3), [`scan_${SCAN}.glb`]: new Uint8Array(3) } });
  const r = await runTick(w.deps(), { tickId: "t" });
  assertEquals(r.to, "done");
  assertEquals(w.job(SCAN).credits_spent, 0);
  assertEquals(w.job(SCAN).reason, "already-published");
  assertEquals((w.tripo as FakeTripo).calls.length, 0);
});

Deno.test("idempotency: a twin the worker did not publish -> skipped manual-in-progress, even mid-flight", async () => {
  const w = world({ models: { [`scan_${SCAN}_map.glb`]: new Uint8Array(3) } }, { status: "generating", tripo_gen_task: "gen-x", generate_submitted_at: new Date().toISOString() });
  const r = await runTick(w.deps(), { tickId: "t" });
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
  const r = await runTick(w.deps(), { tickId: "t" });
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
    const r = await runTick(w.deps(), { tickId: `t${i}` });
    assertEquals(r.to, "queued");
    w.advance(61);
  }
  assertEquals(w.job(SCAN).waits, 19);
  assertEquals(w.breadcrumbs.length, 0);
  const r = await runTick(w.deps(), { tickId: "last" });
  assertEquals(r.to, "failed");
  assertEquals(w.job(SCAN).reason, "incomplete-upload");
});

Deno.test("photos before manifest: a job enqueued early waits, then proceeds once the manifest lands", async () => {
  const folder = seedFolder(SCAN);
  const manifest = folder[`${SCAN}/manifest.json`];
  delete folder[`${SCAN}/manifest.json`];
  const w = world({ carScans: folder });
  assertEquals((await runTick(w.deps(), { tickId: "t0" })).to, "queued");
  w.carScans.set(`${SCAN}/manifest.json`, manifest);
  w.advance(61);
  assertEquals((await runTick(w.deps(), { tickId: "t1" })).to, "fetching");
});

Deno.test("a lap the app reported incomplete (uploaded=3) is skipped, never rendered", async () => {
  const folder = seedFolder(SCAN);
  const m = JSON.parse(new TextDecoder().decode(folder[`${SCAN}/manifest.json`]));
  m.uploaded = 3;
  m.failed = ["Rear"];
  folder[`${SCAN}/manifest.json`] = new TextEncoder().encode(JSON.stringify(m));
  const w = world({ carScans: folder });
  const r = await runTick(w.deps(), { tickId: "t" });
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
  await runTick(w.deps(), { tickId: "t0" }); // queued -> fetching
  w.advance(61);
  const r1 = await runTick(w.deps(), { tickId: "t1" });
  assertEquals(r1.to, "fetching");
  assertEquals(w.job(SCAN).reason, "wait:user-cap");
  w.advance(5 * 60 + 1);
  const r2 = await runTick(w.deps(), { tickId: "t2" });
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
  await runTick(w.deps(), { tickId: "t0" });
  w.advance(61);
  const r = await runTick(w.deps(), { tickId: "t1" });
  assertEquals(r.to, "fetching");
  assertEquals(w.job(SCAN).reason, "wait:daily-cap");
  assertEquals(t.calls.filter((c) => c.method.includes("multiview")).length, 0);
  w.advance(24 * 3600);
  const r2 = await runTick(w.deps(), { tickId: "t2" });
  assertEquals(r2.to, "generating");
});

Deno.test("balance floor: below min_balance + 50 -> wait, no generate", async () => {
  const w = world();
  (w.tripo as FakeTripo).balanceValue = 120;
  await runTick(w.deps(), { tickId: "t0" });
  w.advance(61);
  const r = await runTick(w.deps(), { tickId: "t1" });
  assertEquals(r.to, "fetching");
  assertEquals(w.job(SCAN).reason, "wait:balance");
  assertEquals(w.job(SCAN).credits_spent, 0);
});

Deno.test("Tripo says insufficient credits -> pipeline paused (enabled=false), job waits an hour", async () => {
  const w = world();
  const t = w.tripo as FakeTripo;
  t.failNextGenerate = new InsufficientCredits("Insufficient credits", 400);
  await runTick(w.deps(), { tickId: "t0" });
  w.advance(61);
  const r = await runTick(w.deps(), { tickId: "t1" });
  assertEquals(r.to, "fetching");
  assertEquals(w.flags!.enabled, false);
  assertEquals(w.flags!.paused_reason, "tripo-credits");
  assertEquals(w.job(SCAN).reason, "wait:tripo-credits");
  assertEquals(w.job(SCAN).credits_spent, 0, "a definite rejection rolls the intent ledger back");
  assertEquals(w.job(SCAN).paid_call, null);
  assertEquals(w.job(SCAN).generate_submitted_at, null);
  assert(w.breadcrumbs.some((b) => b.message.includes("PAUSED tripo-credits")));
  // and the next tick is idle: disabled
  w.advance(3601);
  assertEquals((await runTick(w.deps(), { tickId: "t2" })).idle, "disabled");
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
  assertEquals((await runTick(w.deps(), { tickId: "again" })).idle, "empty");
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
    const r = await runTick(flaky, { tickId: `e${i}` });
    assertEquals(r.ok, false);
    assertEquals(w.job(SCAN).attempts, i);
    assertEquals(w.job(SCAN).status, "queued");
    w.advance(600);
  }
  boom = false;
  const r = await runTick(flaky, { tickId: "ok" });
  assertEquals(r.to, "fetching");
  assertEquals(w.job(SCAN).attempts, 0);
  // and a 5th consecutive failure is terminal
  const w2 = world();
  const dead = { ...w2.deps(), listScan: () => Promise.reject(new Error("storage 503")) };
  for (let i = 1; i <= 5; i++) {
    await runTick(dead, { tickId: `e${i}` });
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
  assertEquals((await runTick(w.deps(), { tickId: "paused" })).idle, "disabled");
  w.flags!.enabled = true;
  const r = await runTick(w.deps(), { tickId: "resumed" });
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
    const r = await runTick(w.deps(), { tickId: `p${i}` });
    assertEquals(r.to, "generating");
    w.advance(31);
  }
  assertEquals(w.job(SCAN).state_polls, GEN_MAX_POLLS);
  const r = await runTick(w.deps(), { tickId: "last" });
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
    await runTick(w2.deps(), { tickId: `c${i}` });
    w2.advance(31);
  }
  assertEquals((await runTick(w2.deps(), { tickId: "last" })).to, "failed");
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
  assertEquals((await runTick(w.deps(), { tickId: "again" })).idle, "empty");
});

Deno.test("LOST generate reply with the tick killed outright (marker on the row, no catch ran): next tick fails without re-POSTing", async () => {
  // Simulate the edge wall-clock kill: the pre-POST row update landed, nothing after it.
  const w = world({}, { status: "fetching", handle: "tester", credits_spent: 30, paid_call: "gen", paid_call_started_at: "2026-09-02T11:58:00Z", generate_submitted_at: "2026-09-02T11:58:00Z" });
  const t = w.tripo as FakeTripo;
  const r = await runTick(w.deps(), { tickId: "t" });
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
  assertEquals((await runTick(w2.deps(), { tickId: "again" })).idle, "empty");
});

// ── the twin is published, then something goes wrong before the hero is bought ──

Deno.test("twin published, then the hero convert reply is LOST: the twin stays OURS (never manual-in-progress), one retry, done", async () => {
  const w = world();
  const t = w.tripo as FakeTripo;
  await drain(w, 3);
  assertEquals(w.job(SCAN).status, "converting_map");
  t.loseNextConverts = 1; // the NEXT convert is the hero
  const r = await runTick(w.deps(), { tickId: "lost" });
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
  const r = await runTick(w.deps(), { tickId: "rejected" });
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
  const r = await runTick(w2.deps(), { tickId: "t" });
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
  assertEquals((await runTick(w3.deps(), { tickId: "t" })).to, "skipped");
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
  const r = await runTick(w.deps(), { tickId: "t", scan: "b-2" });
  assertEquals(r.scan, "b-2");
  assertEquals(w.job("a-1").status, "queued");
  assertEquals(w.job("b-2").status, "fetching");
});

Deno.test("lease is released after every tick", async () => {
  const w = world();
  await runTick(w.deps(), { tickId: "t" });
  assertEquals(w.job(SCAN).lease_until, null);
  assertEquals(w.job(SCAN).locked_by, null);
});
