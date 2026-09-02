// worker.ts — the scan state machine. One tick advances ONE job by ONE state.
//
// Everything that touches the outside world comes in through `Deps`, so the exact
// same code runs (a) in the edge function with Supabase + Tripo behind it, (b) under
// `deno test` with in-memory fakes, and (c) in the dry run against the Tripo stub.
//
// STATES   queued -> fetching -> generating -> converting_map -> converting_hero -> done
// TERMINAL done | failed | skipped
// SPEND    generate 30 · map convert 10 · hero convert 10 = 50 credits ($0.50) per car.
//          The ONLY path above 50 is ONE extra convert (+10): a re-convert after an
//          expired model URL, OR one retry after a convert POST whose reply was lost.
//          Both share `convert_retries` (max 1), so 60 is the ceiling. A generate is
//          NEVER bought twice, whatever happens.
//
// MONEY RULES (each one is a guard in code, not a comment):
//   - pipeline_flags.enabled is read at the top of every tick and again right before
//     the generate POST; unreadable == disabled.
//   - INTENT BEFORE SPEND: every paid POST is preceded by ONE row update that records
//     `paid_call` + `paid_call_started_at` and adds the credits to the ledger. The
//     marker is cleared in the same update that stores the task id. A tick that dies
//     (edge wall clock, abort, network) between the two leaves the marker set, and the
//     next tick NEVER re-POSTs: a generate fails `gen-submit-unknown` (runbook: recover
//     by hand from Tripo's dashboard), a convert gets its single bounded retry. Only a
//     DEFINITE rejection (Tripo's application layer answered with an error code — no
//     task was created) rolls the ledger back and re-enters the generic retry policy.
//   - a generate is submitted in exactly one transition, guarded by tripo_gen_task IS
//     NULL, and is NEVER auto-resubmitted.
//   - pre-flight on every tick: both models published -> done (0 credits); a twin the
//     worker did not publish -> skipped 'manual-in-progress' (hands off a hand-run). A
//     twin whose sha256 equals the job's `twin_pending_sha256` IS ours (the tick died
//     after the upload) and is reclaimed, never skipped.
//   - the twin's ownership (`twin_published_at`) is persisted BEFORE the hero convert is
//     bought, so no crash between the two can strand a live twin as "manual".
//   - publish is upsert:false; a 409 is resolved by sha256 (equal -> continue,
//     different -> failed, never delete).
//   - the hero convert (10) is only bought after the twin passed every Mapbox gate and
//     its public round trip hashed equal.
//   - timeouts are counted in POLLS, not wall-clock seconds, so time spent with the
//     kill switch off (or the cron unscheduled) never expires a paid job.

import { checkFolder, heroName, isJunkScanId, mapShotsToViews, normaliseHandle, parseManifest, SHOT_FILE, SHOT_IDS, twinName } from "./manifest.ts";
import type { FolderEntry, ShotId, TripoView } from "./manifest.ts";
import { finishMaterial, MAX_BYTES, qcHero, qcTwin, sha256Hex } from "./glb.ts";
import type { QcReport } from "./glb.ts";
import { HERO_CONVERT, InsufficientCredits, isDefiniteRejection, isRateLimited, modelUrlOf, retryAfterSeconds, TWIN_CONVERT } from "./tripo.ts";
import type { TripoApi } from "./tripo.ts";

export type JobStatus = "queued" | "fetching" | "generating" | "converting_map" | "converting_hero" | "done" | "failed" | "skipped";

export const TERMINAL: readonly JobStatus[] = ["done", "failed", "skipped"];

/** Which paid Tripo POST a job is inside of (or lost the reply to). */
export type PaidCall = "gen" | "map" | "hero";

export type Job = {
  scan_id: string;
  handle: string | null;
  /** Backend account id, from the server-issued scan slot (part 2). null on a legacy
   *  slot-less job (require_slot was off) or a hand-seeded row. Doubles as "did this job
   *  ever consume a slot" for the release-on-failure rule (item G) — a slot is only ever
   *  consumed in the same commit that sets this. */
  user_id: string | null;
  status: JobStatus;
  /** shots[] from manifest.json, persisted at queued->fetching so the view mapping never depends on a literal. */
  shots: string[] | null;
  tripo_file_tokens: Partial<Record<TripoView, string>> | null;
  tripo_gen_task: string | null;
  tripo_map_task: string | null;
  tripo_hero_task: string | null;
  credits_spent: number;
  convert_retries: number;
  attempts: number;
  waits: number;
  /** Polls spent in the current state (reset on every transition); bounds Tripo waits without a wall clock. */
  state_polls: number;
  next_run_at: string;
  lease_until: string | null;
  locked_by: string | null;
  /** Intent marker: set in the row update immediately BEFORE a paid POST, cleared with the task id. */
  paid_call: PaidCall | null;
  paid_call_started_at: string | null;
  /** sha256 of the twin bytes we are about to upload; lets a later tick recognise its own upload. */
  twin_pending_sha256: string | null;
  twin_sha256: string | null;
  hero_sha256: string | null;
  twin_published_at: string | null;
  hero_published_at: string | null;
  last_error: string | null;
  reason: string | null;
  generate_submitted_at: string | null;
  map_submitted_at: string | null;
  hero_submitted_at: string | null;
  created_at: string;
  updated_at: string;
};

export type Flags = {
  enabled: boolean;
  daily_credit_cap: number;
  per_user_cap: number;
  min_balance: number;
  paused_reason: string | null;
  /** Transition switch (part 2, migration 20260902002000_scan_slots.sql): while testers
   *  are still on JS that never requests a slot, a slot-less folder still renders (the
   *  legacy manifest-handle path). Flip AFTER the OTA carrying the slot request ships —
   *  from then on a slot-less scan_id is refused by register-scan AND here. */
  require_slot: boolean;
};

export type JobPatch = Partial<Omit<Job, "scan_id" | "created_at">>;

/** A row from `public.scan_slots` — the backend-issued grant that binds a scan_id to an
 *  account. See supabase/migrations/20260902002000_scan_slots.sql. */
export type ScanSlot = {
  scan_id: string;
  user_id: string;
  handle: string | null;
  tier: string | null;
  consumed_at: string | null;
  released_at: string | null;
};

export interface Deps {
  now(): Date;
  /** null == unreadable == disabled (fail closed). */
  flags(): Promise<Flags | null>;
  setFlags(patch: Partial<Flags>): Promise<void>;
  /** FOR UPDATE SKIP LOCKED claim with a 170 s lease; `scan` pins one job. At most ONE
   *  job may hold a live lease in `fetching` at a time (claims are serialised in SQL), so
   *  the cap reads in stepFetching cannot interleave with another job's spend. */
  claim(tickId: string, scan?: string): Promise<Job | null>;
  updateJob(scanId: string, patch: JobPatch): Promise<void>;
  /** Courtesy/real per-user render cap. Keyed on `userId` (server-issued slot identity)
   *  when the job has one; falls back to `handle` (client-supplied, a courtesy cap only)
   *  for legacy slot-less jobs — see item F. */
  countUserRenders(handle: string, excludeScan: string, userId?: string | null): Promise<number>;
  creditsLast24h(): Promise<number>;
  breadcrumb(handle: string | null, message: string): Promise<void>;
  listScan(scanId: string): Promise<FolderEntry[]>;
  downloadScanFile(path: string): Promise<Uint8Array>;
  modelExists(name: string): Promise<boolean>;
  uploadModel(name: string, bytes: Uint8Array): Promise<"ok" | "duplicate">;
  fetchModelPublic(name: string): Promise<Uint8Array | null>;
  /** Download a Tripo model URL. 403/404 == the 5-minute URL expired. */
  download(url: string, signal?: AbortSignal): Promise<Uint8Array | "expired">;
  /** The server-issued slot for this scan_id, or null if none was ever issued (legacy
   *  path, subject to `flags.require_slot`). */
  getSlot(scanId: string): Promise<ScanSlot | null>;
  /** Marks the slot consumed (consumed_at = now() where still null) — called once, in
   *  the same transition that moves queued -> fetching under a slot. */
  consumeSlot(scanId: string): Promise<void>;
  /** Gives the slot back (released_at = now()) so it no longer counts against the
   *  account's two included scans. Called ONLY on a terminal `failed` — never `skipped`
   *  (item G: a FAILED render must not burn one of the two included scans). */
  releaseSlot(scanId: string): Promise<void>;
  /** Jobs currently occupying a Tripo task slot (generating + both converts). Tripo's
   *  account-wide pool is 10 concurrent tasks; converts occupy it too, so the worker caps
   *  its own view below that (MAX_ACTIVE_TRIPO) rather than relying on Tripo's 2000/1007
   *  rejection alone. */
  countActiveTripo(): Promise<number>;
  tripo: TripoApi;
  log(msg: string): void;
}

export type TickResult = {
  ok: boolean;
  idle?: "disabled" | "empty";
  scan?: string;
  from?: JobStatus;
  to?: JobStatus;
  detail?: string;
  error?: string;
};

// ── tunables (all in one place) ──────────────────────────────────────────────
// The claim lease is 170 s — see claim_scan_job() in the SQL migration (not duplicated
// here as a constant: nothing in worker.ts computes with it, and a stale copy would drift).
export const POLL_S = 20;
// FASTER POLLS (2026-09-02, launch sizing v3): the cron interval moves to 15 s
// (supabase/ops/scan_worker_cron_15s.sql) and POLL_S drops from 30 to 20. The old
// POLL_S(30) == cron-interval(30) pairing raced: pg_cron's '30 seconds' schedule fires on
// a fixed wall-clock grid (…:00, :30, :00…), not "30 s after the row became due". A row
// whose `next_run_at` landed a few hundred ms AFTER a grid mark (typical, since the tick
// that set it also spent time doing the actual work) missed that mark by an epsilon and
// had to wait a full extra cron cycle — observed live: a generate polled at 00:24:19 and
// 00:25:19, a dead 60 s apart, with an `idle:empty` tick in between, despite POLL_S=30.
// A 15 s grid with POLL_S=20 (not a multiple of the grid) bounds the worst case to one
// skipped mark (~15 s) instead of one skipped cycle (~30 s) — halving typical poll latency.
// GEN_TIMEOUT_S / CONVERT_TIMEOUT_S stay fixed in WALL-CLOCK seconds; MAX_POLLS is
// re-derived from POLL_S below so the real waiting time they bound does not change.
export const INCOMPLETE_WAIT_S = 60;
export const INCOMPLETE_MAX_WAITS = 20; // ≈ 20 min of photos-still-arriving
export const GUARD_WAIT_S = 5 * 60;
// NO SELF-DISABLE on InsufficientCredits (item 7): was 60 min disable-the-whole-pipeline;
// now a 10 min per-job wait while `pipeline_flags.enabled` stays untouched — the balance
// guard in stepFetching re-checks Tripo's balance on every cycle, so a human top-up
// resumes rendering with no flip of any switch.
export const CREDITS_PAUSE_S = 10 * 60;
export const MAX_ATTEMPTS = 5;
export const GEN_TIMEOUT_S = 30 * 60;
export const CONVERT_TIMEOUT_S = 15 * 60;
/** Timeouts are enforced as a poll COUNT (one poll per POLL_S at the fastest), so a
 *  pause of the pipeline — kill switch, cron unscheduled, Tripo unreachable — costs no
 *  budget. GEN_MAX_POLLS polls of a still-running generate ≈ GEN_TIMEOUT_S of actual
 *  waiting, whatever POLL_S is currently tuned to. */
export const GEN_MAX_POLLS = GEN_TIMEOUT_S / POLL_S;
export const CONVERT_MAX_POLLS = CONVERT_TIMEOUT_S / POLL_S;
export const CREDITS_GENERATE = 30;
export const CREDITS_CONVERT = 10;
/** Documentation/breadcrumb figure only ("50 credits = $0.50 per car") — the guards below
 *  reserve against MAX_CREDITS_PER_JOB, the real worst case including one retry. */
export const CREDITS_PER_CAR = CREDITS_GENERATE + 2 * CREDITS_CONVERT;
/** The real per-job ceiling: one generate + two converts + ONE extra convert retry
 *  (lost-reply or a bounded reconvert; `convert_retries` caps at 1). Guards reserve this
 *  much headroom, not the optimistic 50, and `paidSubmit` refuses to spend past it —
 *  a structural invariant check, not an operational guard (see item 5). */
export const MAX_CREDITS_PER_JOB = 60;
// ── launch sizing v3: throughput + spend safety (2026-09-02) ─────────────────
/** Wall-clock budget for the whole tick's WORK loop, under index.ts's TICK_BUDGET_MS
 *  (130 s, itself under Supabase's 150 s free-plan function wall clock). Leaves ~30 s of
 *  headroom for a job already mid-flight when the soft budget is hit. */
export const TICK_BUDGET_MS = 130_000;
export const TICK_WORK_BUDGET_MS = 100_000;
/** Hard cap on distinct jobs advanced in one tick, independent of the time budget. */
export const MAX_JOBS_PER_TICK = 25;
/** A paid POST is never started with less than this much tick budget left — better to
 *  defer to the next tick (zero ledger change; already-uploaded file tokens are kept)
 *  than to risk the tick's wall clock killing the request mid-flight, which is exactly
 *  the ambiguous "lost reply" case every paid call is otherwise built to avoid. */
export const PAID_CALL_RESERVE_MS = 25_000;
// ── launch sizing v3 part 2: Tripo rate limits + server-issued scan slots (2026-09-02) ──
/** Tripo's account-wide pool is 10 CONCURRENT TASKS (platform.tripo3d.ai/docs/limit).
 *  A generate occupies one slot for its ~30 min lifetime; EACH CONVERT ALSO OCCUPIES ONE
 *  (a job in `converting_map` or `converting_hero` still has a live Tripo task) — so with
 *  several jobs per tick (launch sizing v3 part 1) the worker's own view of "how many
 *  tasks are in flight right now" (generating + converting_map + converting_hero) must
 *  stay under 10, not just count generates. 8, not 10, leaves headroom for a task Tripo
 *  considers still-running that a lagging poll hasn't reflected here yet — the worker's
 *  own guard is a courtesy that avoids spending into the 2000/1007 rejection in the
 *  common case; isRateLimited/paidSubmit is what actually survives Tripo saying no. */
export const MAX_ACTIVE_TRIPO = 8;

const iso = (d: Date) => d.toISOString();
const plus = (d: Date, s: number) => new Date(d.getTime() + s * 1000);

type Transition = { to: JobStatus; patch: JobPatch; detail: string; resetAttempts?: boolean };

const CLEAR_PAID: JobPatch = { paid_call: null, paid_call_started_at: null };

class Tick {
  /** `deadlineMs` is an absolute epoch-ms timestamp (tick start + TICK_WORK_BUDGET_MS),
   *  shared across every job this tick advances — see `remainingMs()`. Defaults to
   *  Infinity so nothing outside `runTick` (e.g. a future direct Tick construction) is
   *  ever budget-limited by accident. */
  constructor(readonly deps: Deps, readonly job: Job, readonly flags: Flags, readonly signal?: AbortSignal, readonly deadlineMs: number = Infinity) {}

  get now(): Date {
    return this.deps.now();
  }

  /** Budget left in this TICK (not this job) before a paid POST should defer instead of
   *  risking the wall-clock kill mid-flight. See PAID_CALL_RESERVE_MS. */
  remainingMs(): number {
    return this.deadlineMs - this.now.getTime();
  }

  private crumb(msg: string, handle: string | null = this.job.handle) {
    return this.deps.breadcrumb(handle, `carscan-worker id=${this.job.scan_id} ${msg}`);
  }

  /** Terminal or state-changing commit: one UPDATE + one breadcrumb. */
  async commit(t: Transition): Promise<TickResult> {
    const from = this.job.status;
    const patch: JobPatch = {
      ...t.patch,
      status: t.to,
      lease_until: null,
      locked_by: null,
      updated_at: iso(this.now),
    };
    if (t.to !== from) {
      patch.state_polls = 0;
      if (t.resetAttempts !== false) {
        patch.attempts = 0;
        if (!("last_error" in t.patch)) patch.last_error = null;
      }
    }
    await this.deps.updateJob(this.job.scan_id, patch);
    await this.crumb(`${from}->${t.to} ${t.detail}`, t.patch.handle ?? this.job.handle);
    this.deps.log(`[${this.job.scan_id}] ${from}->${t.to} ${t.detail}`);
    return { ok: true, scan: this.job.scan_id, from, to: t.to, detail: t.detail };
  }

  /** Same state, later: NOT a transition, NO breadcrumb (idle polls are silent). */
  async wait(seconds: number, patch: JobPatch = {}, detail = "wait"): Promise<TickResult> {
    await this.deps.updateJob(this.job.scan_id, {
      ...patch,
      next_run_at: iso(plus(this.now, seconds)),
      lease_until: null,
      locked_by: null,
      updated_at: iso(this.now),
    });
    this.deps.log(`[${this.job.scan_id}] ${this.job.status} ${detail} (+${seconds}s)`);
    return { ok: true, scan: this.job.scan_id, from: this.job.status, to: this.job.status, detail };
  }

  /** A poll of a still-running Tripo task: counts toward the state's poll budget. */
  private poll(maxPolls: number, timeoutReason: string, detail: string): Promise<TickResult> {
    const polls = (this.job.state_polls ?? 0) + 1;
    if (this.job.state_polls >= maxPolls) return this.fail(timeoutReason, { last_error: `${this.job.state_polls} polls in ${this.job.status}` });
    return this.wait(POLL_S, { state_polls: polls }, `${detail} poll=${polls}/${maxPolls}`);
  }

  async fail(reason: string, extra: JobPatch = {}): Promise<TickResult> {
    // Item G: a FAILED render must not burn one of the account's two included scans.
    // `user_id` is only ever set in the same commit that consumes the slot (stepQueued),
    // so its presence IS "this job holds a consumed slot" — never released on `skip()`.
    if (this.job.user_id) {
      await this.deps.releaseSlot(this.job.scan_id);
      await this.crumb(`slot released reason=${reason}`);
    }
    return this.commit({ to: "failed", patch: { reason, ...extra }, detail: `FAILED ${reason}` });
  }

  skip(reason: string): Promise<TickResult> {
    return this.commit({ to: "skipped", patch: { reason }, detail: `skipped ${reason}` });
  }

  // ── pre-flight: runs on EVERY tick before any state logic, spends nothing ──
  async preflight(): Promise<TickResult | null> {
    const j = this.job;
    const [hero, twin] = await Promise.all([this.deps.modelExists(heroName(j.scan_id)), this.deps.modelExists(twinName(j.scan_id))]);
    if (hero && twin) {
      return this.commit({ to: "done", patch: { ...CLEAR_PAID, reason: "already-published" }, detail: "done already-published credits=0" });
    }
    if (twin && !hero && !j.twin_published_at) {
      // A twin in the bucket that this job never recorded as published. Either a human
      // is mid-render (never resume it), or OUR tick died between the upload and the
      // row update — in which case its bytes hash to the sha we wrote beforehand.
      const reclaimed = j.twin_pending_sha256 ? await this.reclaimTwin(j.twin_pending_sha256) : false;
      if (!reclaimed) return this.skip("manual-in-progress");
    }
    // A paid POST was started and its reply never stored: the previous tick died inside it.
    if (j.paid_call_started_at) return this.lostResponse(j.paid_call ?? "gen", `marker from ${j.paid_call_started_at}`);
    return null;
  }

  private async reclaimTwin(pendingSha: string): Promise<boolean> {
    const back = await this.deps.fetchModelPublic(twinName(this.job.scan_id));
    const sha = back ? await sha256Hex(back) : null;
    if (sha !== pendingSha) return false;
    const stamp = iso(this.now);
    await this.deps.updateJob(this.job.scan_id, { twin_sha256: sha, twin_published_at: stamp, updated_at: stamp });
    this.job.twin_sha256 = sha;
    this.job.twin_published_at = stamp;
    await this.crumb(`twin reclaimed sha=${sha.slice(0, 12)} (tick died after the upload)`);
    return true;
  }

  /** The reply to a paid POST never reached us. Never re-POST a generate; a convert gets
   *  the one bounded retry that `convert_retries` allows. The credits stay in the ledger
   *  either way (conservative: Tripo may well have created the task). */
  private async lostResponse(kind: PaidCall, why: string): Promise<TickResult> {
    const j = this.job;
    const reason = `${kind}-submit-unknown`;
    if (kind === "gen" || j.convert_retries >= 1) {
      return this.fail(reason, { last_error: `${why}; credits kept in ledger; see runbook 'lost response'`.slice(0, 300) });
    }
    await this.crumb(`LOST ${kind} reply (${why}); retrying once, convert_retries=1`);
    return this.wait(POLL_S, { ...CLEAR_PAID, convert_retries: j.convert_retries + 1, last_error: `${reason}; retried once` }, `lost ${kind} reply`);
  }

  /** INTENT BEFORE SPEND. Records the paid call + credits in the row, then POSTs.
   *  Returns the task id, or a TickResult when the job must stop here.
   *
   *  Three guards run BEFORE the intent write, in this order:
   *   1. CEILING (item 5) — a structural invariant, not an operational guard: this job
   *      would exceed MAX_CREDITS_PER_JOB. Should never trip in normal operation (the
   *      generic retry policy and convert_retries already bound spend to 60); tripping it
   *      means something upstream is wrong, so it fails outright rather than waiting.
   *   2. BUDGET/ABORT (item 3) — the tick's soft work budget is nearly spent, or the
   *      whole tick was already aborted (index.ts's wall-clock guard). Deferring here
   *      costs nothing: no intent has been written yet, and any file tokens already
   *      uploaded (stepFetching) stay persisted for the next tick to resume from.
   *   3. KILL SWITCH RE-READ (item 6) — `flags` on this Tick is a SNAPSHOT taken once at
   *      the top of the tick (runTick) and shared across every job the tick advances. In
   *      a multi-job tick, an earlier job's InsufficientCredits pause (or an operator
   *      disabling mid-tick) would otherwise be invisible to a LATER job in the same
   *      tick, which would still see the stale enabled:true and spend anyway. Re-reading
   *      here catches that race for every paid call, not just the generate (stepFetching
   *      already re-read before this method existed; this generalises it to map/hero). */
  private async paidSubmit(kind: PaidCall, credits: number, pre: JobPatch, call: () => Promise<string>): Promise<string | TickResult> {
    const j = this.job;
    if (j.credits_spent + credits > MAX_CREDITS_PER_JOB) {
      return this.fail("ceiling", { last_error: `credits_spent=${j.credits_spent}+${credits} > MAX_CREDITS_PER_JOB=${MAX_CREDITS_PER_JOB}` });
    }
    if (this.signal?.aborted || this.remainingMs() < PAID_CALL_RESERVE_MS) {
      return this.wait(POLL_S, {}, `defer ${kind}: budget`);
    }
    const freshFlags = await this.deps.flags();
    if (!freshFlags || !freshFlags.enabled) {
      return this.wait(GUARD_WAIT_S, { reason: "wait:disabled" }, "guard disabled");
    }
    const rollback: JobPatch = { ...CLEAR_PAID, credits_spent: j.credits_spent };
    for (const k of Object.keys(pre) as (keyof JobPatch)[]) (rollback as Record<string, unknown>)[k] = j[k];
    const stamp = iso(this.now);
    await this.deps.updateJob(j.scan_id, { ...pre, paid_call: kind, paid_call_started_at: stamp, credits_spent: j.credits_spent + credits, updated_at: stamp });
    Object.assign(j, pre, { paid_call: kind, paid_call_started_at: stamp, credits_spent: j.credits_spent + credits });
    try {
      return await call();
    } catch (e) {
      const msg = String((e as Error)?.message ?? e).slice(0, 200);
      if (e instanceof InsufficientCredits) {
        // NO SELF-DISABLE (item 7): `enabled` is untouched — only `paused_reason` is set,
        // so other jobs' generates/converts keep running normally. This job itself waits
        // CREDITS_PAUSE_S, then re-enters stepFetching's guards; the balance guard there
        // re-checks Tripo's live balance every cycle and clears paused_reason the moment
        // it passes, so a human top-up resumes rendering with no flip of any switch.
        await this.deps.updateJob(j.scan_id, { ...rollback, updated_at: iso(this.now) });
        Object.assign(j, rollback);
        await this.deps.setFlags({ paused_reason: "tripo-credits" });
        await this.crumb(`PAUSED tripo-credits on ${kind}: ${msg}`);
        return this.wait(CREDITS_PAUSE_S, { reason: "wait:tripo-credits", last_error: msg }, "paused tripo-credits");
      }
      if (isRateLimited(e)) {
        // Tripo's pool of 10 concurrent tasks (or the other documented retryable, 1007)
        // is full: no task was created, no charge — roll back exactly like a definite
        // rejection, but wait the SERVER-TOLD backoff instead of the generic 5-strike
        // retry policy (no attempts++, no throw: this is expected traffic shaping, not
        // an error). MAX_ACTIVE_TRIPO is a courtesy guard that should keep this rare.
        await this.deps.updateJob(j.scan_id, { ...rollback, updated_at: iso(this.now) });
        Object.assign(j, rollback);
        const retryAfterS = retryAfterSeconds(e);
        await this.crumb(`WAIT tripo-rate on ${kind}: ${msg} retryAfterS=${retryAfterS}`);
        return this.wait(retryAfterS, { reason: "wait:tripo-rate" }, `tripo rate-limited ${kind}`);
      }
      if (isDefiniteRejection(e)) {
        // Tripo answered with an error envelope: no task, no charge. Roll the ledger
        // back and let the generic 5-strike policy retry (re-POSTing costs nothing).
        await this.deps.updateJob(j.scan_id, { ...rollback, updated_at: iso(this.now) });
        Object.assign(j, rollback);
        throw e;
      }
      return this.lostResponse(kind, msg);
    }
  }

  // ── queued -> fetching ─────────────────────────────────────────────────────
  async stepQueued(): Promise<TickResult> {
    const j = this.job;
    if (isJunkScanId(j.scan_id)) return this.skip("junk");
    const entries = await this.deps.listScan(j.scan_id);
    const check = checkFolder(entries);
    if (entries.length === 0) return this.skip("junk");
    if (!check.complete) {
      const waits = (j.waits ?? 0) + 1;
      if (waits >= INCOMPLETE_MAX_WAITS) {
        return this.fail("incomplete-upload", { waits, last_error: `missing=${check.missing.join(",")} small=${check.small.join(",")} manifest=${check.hasManifest}` });
      }
      return this.wait(INCOMPLETE_WAIT_S, { waits }, `incomplete missing=${check.missing.join(",")} small=${check.small.join(",")} manifest=${check.hasManifest}`);
    }
    const text = new TextDecoder().decode(await this.deps.downloadScanFile(`${j.scan_id}/manifest.json`));
    const parsed = parseManifest(text, j.scan_id);
    if (!parsed.ok) return this.skip(parsed.reason);
    // Throws if not all four views map — a manifest that passed parseManifest always does.
    mapShotsToViews(parsed.manifest.shots);
    const photos = entries.filter((e) => e.name.endsWith(".jpg")).map((e) => e.size).join("/");
    // Item E: identity comes from a server-issued slot when one exists — the account the
    // client cannot forge — never from the manifest alone. See
    // supabase/migrations/20260902002000_scan_slots.sql / 20260902003000_car_scan_jobs_user_id.sql.
    const slot = await this.deps.getSlot(j.scan_id);
    if (slot && slot.released_at) return this.skip("slot-released");
    if (slot) {
      const handle = slot.handle ?? normaliseHandle(parsed.manifest.handle);
      await this.deps.consumeSlot(j.scan_id);
      return this.commit({
        to: "fetching",
        patch: { handle, shots: parsed.manifest.shots, user_id: slot.user_id },
        detail: `slot=1 user=${slot.user_id} handle=${handle} shots=${parsed.manifest.shots.join(",")} photos=${photos}`,
      });
    }
    // No slot. Allowed only while the transition flag is off — same rule register-scan
    // enforces on the upload side (flip AFTER the OTA carrying the slot request ships).
    if (this.flags.require_slot) return this.skip("slot-required");
    return this.commit({
      to: "fetching",
      patch: { handle: parsed.handle, shots: parsed.manifest.shots },
      detail: `slot=0 legacy=1 handle=${parsed.handle} shots=${parsed.manifest.shots.join(",")} photos=${photos}`,
    });
  }

  // ── fetching -> generating (the ONLY generate submit; 30 credits) ──────────
  async stepFetching(): Promise<TickResult> {
    const j = this.job;
    if (j.tripo_gen_task) {
      // Task id stored but the transition never landed. Never resubmit; move on.
      return this.commit({ to: "generating", patch: { ...CLEAR_PAID }, detail: `resume gen=${j.tripo_gen_task}` });
    }
    const handle = j.handle ?? "anon";
    // (a) photos -> Tripo file tokens. Tokens are persisted as they land so a crash
    //     mid-upload never re-uploads (uploads are free). The token map is keyed by
    //     VIEW, mapped from the manifest's shot ids persisted at queued->fetching
    //     (`rear` -> `back`); never by filename position — that is the mirror trap.
    const views = mapShotsToViews(j.shots ?? SHOT_IDS);
    const tokens: Partial<Record<TripoView, string>> = { ...(j.tripo_file_tokens ?? {}) };
    for (const view of ["front", "left", "back", "right"] as TripoView[]) {
      if (tokens[view]) continue;
      // Same budget check as paidSubmit (item 3): a slow upload defers to the next tick
      // rather than risking the wall-clock kill mid-upload. Tokens already persisted
      // above stay on the row, so the next tick resumes from exactly where this left off.
      if (this.signal?.aborted || this.remainingMs() < PAID_CALL_RESERVE_MS) {
        return this.wait(POLL_S, {}, "defer upload: budget");
      }
      const shot: ShotId = views[view];
      const bytes = await this.deps.downloadScanFile(`${j.scan_id}/${SHOT_FILE[shot]}`);
      tokens[view] = await this.deps.tripo.uploadFile(bytes, SHOT_FILE[shot]);
      await this.deps.updateJob(j.scan_id, { tripo_file_tokens: tokens, updated_at: iso(this.now) });
    }
    // (b) SPEND GUARDS — in this order, all must pass, else the job WAITS. The claim
    //     serialises `fetching` (one live lease at a time), so these reads cannot race
    //     another job's generate. NOTE: `handle` is the manifest's, i.e. client-supplied —
    //     per_user_cap is a courtesy cap; daily_credit_cap + min_balance are the ceiling.
    //     Both reserve MAX_CREDITS_PER_JOB (60, the real worst case with one retry), not
    //     the optimistic CREDITS_PER_CAR (50) — item 5.
    const fresh = await this.deps.flags();
    if (!fresh || !fresh.enabled) return this.wait(GUARD_WAIT_S, { reason: "wait:disabled" }, "guard disabled");
    // Item F: keyed on the SLOT's user_id when this job has one (the identity that
    // cannot be forged), else on the manifest's handle as before (hand-seeded rows and
    // legacy slot-less jobs — a courtesy cap only).
    const others = await this.deps.countUserRenders(handle, j.scan_id, j.user_id ?? null);
    if (others >= fresh.per_user_cap) {
      if (j.reason === "wait:user-cap") return this.fail("user-cap", { last_error: `handle=${handle} user=${j.user_id ?? "-"} renders=${others} cap=${fresh.per_user_cap}` });
      await this.crumb(`WAIT user-cap handle=${handle} user=${j.user_id ?? "-"} renders=${others} cap=${fresh.per_user_cap}`);
      return this.wait(GUARD_WAIT_S, { reason: "wait:user-cap" }, "guard user-cap");
    }
    const spent24h = await this.deps.creditsLast24h();
    if (spent24h + MAX_CREDITS_PER_JOB > fresh.daily_credit_cap) {
      await this.crumb(`WAIT daily-cap spent24h=${spent24h} cap=${fresh.daily_credit_cap}`);
      return this.wait(GUARD_WAIT_S, { reason: "wait:daily-cap" }, "guard daily-cap");
    }
    // Item C: the worker's own view of Tripo's 10-concurrent-task pool (converts occupy
    // it too — see MAX_ACTIVE_TRIPO). DB-only, so it runs before the Tripo balance() call.
    const active = await this.deps.countActiveTripo();
    if (active >= MAX_ACTIVE_TRIPO) {
      return this.wait(POLL_S, { reason: "wait:tripo-pool" }, `guard pool active=${active} cap=${MAX_ACTIVE_TRIPO}`);
    }
    const balance = await this.deps.tripo.balance();
    if (balance < fresh.min_balance + MAX_CREDITS_PER_JOB) {
      await this.crumb(`WAIT balance=${balance} floor=${fresh.min_balance + MAX_CREDITS_PER_JOB}`);
      return this.wait(GUARD_WAIT_S, { reason: "wait:balance" }, "guard balance");
    }
    // Item 7: the balance guard just passed. If InsufficientCredits paused the pipeline
    // earlier (paused_reason set, `enabled` never touched), this is the moment a human
    // top-up becomes visible — clear it here, once, with no separate resume step.
    if (fresh.paused_reason === "tripo-credits") {
      await this.deps.setFlags({ paused_reason: null });
      await this.crumb(`RESUMED balance=${balance}`);
    }
    // (c) the one and only generate submit — intent recorded first (see paidSubmit).
    const genTask = await this.paidSubmit(
      "gen",
      CREDITS_GENERATE,
      { tripo_file_tokens: tokens, generate_submitted_at: iso(this.now) },
      () => this.deps.tripo.generateMultiview(tokens as Record<TripoView, string>),
    );
    if (typeof genTask !== "string") return genTask;
    return this.commit({
      to: "generating",
      patch: { ...CLEAR_PAID, tripo_gen_task: genTask, next_run_at: iso(plus(this.now, 60)), reason: null },
      detail: `gen=${genTask} credits=${j.credits_spent} balance=${balance}`,
    });
  }

  // ── generating -> converting_map (10 credits) ──────────────────────────────
  async stepGenerating(): Promise<TickResult> {
    const j = this.job;
    if (!j.tripo_gen_task) return this.fail("gen-task-missing");
    const task = await this.deps.tripo.getTask(j.tripo_gen_task);
    if (task.status === "queued" || task.status === "running") {
      return this.poll(GEN_MAX_POLLS, "gen-timeout", `poll gen ${task.status} ${task.progress ?? ""}%`);
    }
    if (task.status !== "success") {
      return this.fail(`gen-${task.status}`, { last_error: "gen-failed-refund-expected" });
    }
    const mapTask = await this.paidSubmit("map", CREDITS_CONVERT, { map_submitted_at: iso(this.now) }, () => this.deps.tripo.convert(j.tripo_gen_task!, TWIN_CONVERT));
    if (typeof mapTask !== "string") return mapTask;
    return this.commit({
      to: "converting_map",
      patch: { ...CLEAR_PAID, tripo_map_task: mapTask, next_run_at: iso(plus(this.now, POLL_S)) },
      detail: `map=${mapTask} credits=${j.credits_spent}`,
    });
  }

  // ── converting_map -> converting_hero (10 credits; the heavy tick) ─────────
  async stepConvertingMap(): Promise<TickResult> {
    const j = this.job;
    if (j.twin_published_at) {
      // The twin is ours and live (a tick died after publishing it, or the runbook's
      // hero-only retry). Buy ONLY the hero; never re-download or re-QC the twin.
      return this.buyHero(`twin=live sha=${(j.twin_sha256 ?? "?").slice(0, 12)}`);
    }
    if (!j.tripo_map_task) return this.fail("map-task-missing");
    const task = await this.deps.tripo.getTask(j.tripo_map_task);
    if (task.status === "queued" || task.status === "running") {
      return this.poll(CONVERT_MAX_POLLS, "map-timeout", `poll map ${task.status}`);
    }
    if (task.status !== "success") return this.fail(`map-convert-${task.status}`);
    const url = modelUrlOf(task);
    if (!url) return this.fail("map-no-model-url");
    const raw = await this.deps.download(url, this.signal);
    if (raw === "expired") return this.reconvert("map");
    if (raw.byteLength > MAX_BYTES) return this.fail("qc-bytes", { last_error: `raw twin ${raw.byteLength} B` });
    const qc = qcTwin(raw);
    if (!qc.pass) return this.fail(`qc-${qc.failures[0].split(" ")[0]}`, { last_error: qc.failures.join("; ") });
    const fin = finishMaterial(raw);
    const sha = await sha256Hex(fin.bytes);
    const published = await this.publish(twinName(j.scan_id), fin.bytes, sha, "twin");
    if (published !== "ok") return published;
    // OWNERSHIP BEFORE THE NEXT SPEND: from here on, a crash can never make this twin
    // look like a human's (pre-flight's manual-in-progress rule keys on this stamp).
    const stamp = iso(this.now);
    await this.deps.updateJob(j.scan_id, { twin_sha256: sha, twin_published_at: stamp, twin_pending_sha256: null, updated_at: stamp });
    j.twin_sha256 = sha;
    j.twin_published_at = stamp;
    j.twin_pending_sha256 = null;
    return this.buyHero(`twin=${fin.bytes.byteLength}B verts=${qc.metrics.totalVerts} idx=${qc.metrics.indexTypes.join("/")} finishMs=${fin.report.cpuMs}${warn(qc)}`);
  }

  private async buyHero(detailPrefix: string): Promise<TickResult> {
    const j = this.job;
    if (!j.tripo_gen_task) return this.fail("gen-task-missing");
    const heroTask = await this.paidSubmit("hero", CREDITS_CONVERT, { hero_submitted_at: iso(this.now) }, () => this.deps.tripo.convert(j.tripo_gen_task!, HERO_CONVERT));
    if (typeof heroTask !== "string") return heroTask;
    return this.commit({
      to: "converting_hero",
      patch: { ...CLEAR_PAID, tripo_hero_task: heroTask, next_run_at: iso(plus(this.now, POLL_S)) },
      detail: `${detailPrefix} hero=${heroTask} credits=${j.credits_spent}`,
    });
  }

  // ── converting_hero -> done ────────────────────────────────────────────────
  async stepConvertingHero(): Promise<TickResult> {
    const j = this.job;
    if (!j.tripo_hero_task) return this.fail("hero-task-missing");
    const task = await this.deps.tripo.getTask(j.tripo_hero_task);
    if (task.status === "queued" || task.status === "running") {
      return this.poll(CONVERT_MAX_POLLS, "hero-timeout", `poll hero ${task.status}`);
    }
    if (task.status !== "success") return this.fail(`hero-convert-${task.status}`);
    const url = modelUrlOf(task);
    if (!url) return this.fail("hero-no-model-url");
    const raw = await this.deps.download(url, this.signal);
    if (raw === "expired") return this.reconvert("hero");
    if (raw.byteLength > MAX_BYTES) return this.fail("qc-bytes", { last_error: `raw hero ${raw.byteLength} B` });
    // SCAN-PIPELINE.md: the hero gate is "<= 30 MB + parseable"; geometry deviations are
    // WARNINGS in the breadcrumb (the twin from the same generate already proved them).
    const qc = qcHero(raw);
    if (!qc.pass) return this.fail(`qc-${qc.failures[0].split(" ")[0]}`, { last_error: qc.failures.join("; ") });
    const fin = finishMaterial(raw);
    const sha = await sha256Hex(fin.bytes);
    const published = await this.publish(heroName(j.scan_id), fin.bytes, sha, "hero");
    if (published !== "ok") return published;
    return this.commit({
      to: "done",
      patch: { ...CLEAR_PAID, hero_sha256: sha, hero_published_at: iso(this.now), reason: "published" },
      detail: `done credits=${j.credits_spent} twin=${j.twin_sha256 ? "ok" : "?"} hero=${fin.bytes.byteLength}B verts=${qc.metrics.totalVerts} finishMs=${fin.report.cpuMs}${warn(qc)}`,
    });
  }

  /** One extra convert per job, total (shared with the lost-reply retry). The model URL
   *  lives 5 minutes; if the tick that saw `success` died before downloading, the next
   *  one finds it expired. */
  private async reconvert(which: "map" | "hero"): Promise<TickResult> {
    const j = this.job;
    if (j.convert_retries >= 1) return this.fail(`${which}-url-expired`);
    const pre: JobPatch = { convert_retries: j.convert_retries + 1, ...(which === "map" ? { map_submitted_at: iso(this.now) } : { hero_submitted_at: iso(this.now) }) };
    const task = await this.paidSubmit(which, CREDITS_CONVERT, pre, () => this.deps.tripo.convert(j.tripo_gen_task!, which === "map" ? TWIN_CONVERT : HERO_CONVERT));
    if (typeof task !== "string") return task;
    await this.crumb(`RECONVERT ${which}=${task} credits=${j.credits_spent}`);
    return this.wait(POLL_S, { ...CLEAR_PAID, state_polls: 0, ...(which === "map" ? { tripo_map_task: task } : { tripo_hero_task: task }) }, `reconvert ${which}`);
  }

  /** upsert:false publish + public round trip. Returns "ok" or a terminal TickResult.
   *  For the twin, the sha is written to the row BEFORE the upload so a later tick can
   *  recognise the bytes as ours (pre-flight reclaim) if this one dies right after. */
  private async publish(name: string, bytes: Uint8Array, sha: string, which: "twin" | "hero"): Promise<"ok" | TickResult> {
    if (which === "twin" && this.job.twin_pending_sha256 !== sha) {
      await this.deps.updateJob(this.job.scan_id, { twin_pending_sha256: sha, updated_at: iso(this.now) });
      this.job.twin_pending_sha256 = sha;
    }
    const result = await this.deps.uploadModel(name, bytes);
    const back = await this.deps.fetchModelPublic(name);
    const backSha = back ? await sha256Hex(back) : null;
    if (result === "duplicate") {
      if (backSha === sha) return "ok"; // our own earlier upload (crashed tick) — continue
      return this.fail(`${which}-conflict`, { last_error: `existing sha256 ${backSha ?? "unreadable"} != ${sha}` });
    }
    if (backSha !== sha) return this.fail(`${which}-roundtrip`, { last_error: `public sha256 ${backSha ?? "unreadable"} != ${sha}` });
    return "ok";
  }

  advance(): Promise<TickResult> {
    switch (this.job.status) {
      case "queued":
        return this.stepQueued();
      case "fetching":
        return this.stepFetching();
      case "generating":
        return this.stepGenerating();
      case "converting_map":
        return this.stepConvertingMap();
      case "converting_hero":
        return this.stepConvertingHero();
      default:
        // Terminal rows are never claimed; if one is, release it untouched.
        return this.wait(0, {}, "terminal");
    }
  }
}

function warn(qc: QcReport): string {
  return qc.warnings.length ? ` warn=${qc.warnings.join(",").replace(/\s+/g, "_")}` : "";
}

export type TickOptions = { tickId: string; scan?: string; signal?: AbortSignal };

/** One job's outcome within a tick — the same shape `TickResult` always carried for a
 *  real (non-idle) result, now nested under `jobs[]` since a tick can advance several. */
export type JobResult = { ok: boolean; scan: string; from: JobStatus; to: JobStatus; detail?: string; error?: string };

export type TickSummary = { ok: boolean; idle?: "disabled" | "empty"; jobs: JobResult[] };

/** Claim -> pre-flight -> one step for ONE job, with the generic error policy. Never
 *  throws: every path (success, guard wait, or an exception outside a paid POST) returns
 *  a JobResult, so one job's error can never stop the tick's loop (item 1). */
async function runOneJob(deps: Deps, job: Job, flags: Flags, signal: AbortSignal | undefined, deadlineMs: number): Promise<JobResult> {
  const tick = new Tick(deps, job, flags, signal, deadlineMs);
  try {
    const pre = await tick.preflight();
    const r = pre ?? (await tick.advance());
    return { ok: r.ok, scan: job.scan_id, from: r.from ?? job.status, to: r.to ?? job.status, detail: r.detail, error: r.error };
  } catch (e) {
    // Only reached by errors OUTSIDE a paid POST (or a definite rejection, whose ledger
    // entry was already rolled back): retrying here never buys anything twice.
    const msg = String((e as Error)?.message ?? e).slice(0, 300);
    const attempts = (job.attempts ?? 0) + 1;
    const now = deps.now();
    deps.log(`[${job.scan_id}] ${job.status} ERROR attempt=${attempts} ${msg}`);
    if (attempts >= MAX_ATTEMPTS) {
      // Item G: the 5-strikes path is also a terminal `failed` and does not go through
      // Tick.fail() (the Tick may not even exist yet — e.g. preflight threw) — release
      // the slot here too, same rule (a consumed slot is marked by job.user_id).
      if (job.user_id) {
        await deps.releaseSlot(job.scan_id);
        await deps.breadcrumb(job.handle, `carscan-worker id=${job.scan_id} slot released reason=errors:${job.status}`);
      }
      await deps.updateJob(job.scan_id, { status: "failed", reason: `errors:${job.status}`, last_error: msg, attempts, lease_until: null, locked_by: null, updated_at: now.toISOString() });
      await deps.breadcrumb(job.handle, `carscan-worker id=${job.scan_id} ${job.status}->failed FAILED errors:${job.status} ${msg.slice(0, 120)}`);
      return { ok: false, scan: job.scan_id, from: job.status, to: "failed", error: msg };
    }
    const backoff = Math.min(30 * 2 ** attempts, 300);
    await deps.updateJob(job.scan_id, { last_error: msg, attempts, next_run_at: new Date(now.getTime() + backoff * 1000).toISOString(), lease_until: null, locked_by: null, updated_at: now.toISOString() });
    await deps.breadcrumb(job.handle, `carscan-worker id=${job.scan_id} ${job.status} ERROR attempt=${attempts} retry=${backoff}s ${msg.slice(0, 120)}`);
    return { ok: false, scan: job.scan_id, from: job.status, to: job.status, error: msg };
  }
}

/** One cron tick: flags -> claim (-> pre-flight -> one step) REPEATED, until claim() has
 *  nothing left, the soft work budget is spent, or MAX_JOBS_PER_TICK is hit (item 1 —
 *  "launch sizing": one job per tick meant a burst of N scans made the Nth wait ~N * 30s).
 *
 *  `flags` is read ONCE and shared across every job this tick advances — see paidSubmit's
 *  kill-switch re-read (item 6) for why a stale snapshot here is still safe.
 *
 *  `seen` guards against re-claiming the SAME job twice in one tick: most transitions set
 *  `next_run_at` into the future (a real wait), but `queued->fetching` does not (it never
 *  needed to when only one job moved per tick) — without `seen`, an otherwise-idle tick
 *  with just one due job would claim it, advance it, and immediately re-claim the same
 *  row again since it's still nominally "due", cascading it through several states in one
 *  tick instead of giving OTHER due jobs their turn first. Hitting an already-seen job
 *  means claim() has nothing distinct left to offer this tick; its lease is released
 *  (untouched otherwise) and the loop stops, exactly matching pre-v3 single-job-per-tick
 *  behaviour for the "only one job in the whole queue" case. */
export async function runTick(deps: Deps, opts: TickOptions): Promise<TickSummary> {
  const flags = await deps.flags();
  if (!flags || !flags.enabled) return { ok: true, idle: "disabled", jobs: [] };
  const start = deps.now().getTime();
  const deadlineMs = start + TICK_WORK_BUDGET_MS;
  const jobs: JobResult[] = [];
  const seen = new Set<string>();
  let allOk = true;
  for (let i = 0; i < MAX_JOBS_PER_TICK; i++) {
    if (deps.now().getTime() - start > TICK_WORK_BUDGET_MS) break; // soft budget: jobs may remain for next tick
    const job = await deps.claim(opts.tickId, opts.scan);
    if (!job) break;
    if (seen.has(job.scan_id)) {
      await deps.updateJob(job.scan_id, { lease_until: null, locked_by: null });
      break;
    }
    seen.add(job.scan_id);
    const r = await runOneJob(deps, job, flags, opts.signal, deadlineMs);
    jobs.push(r);
    if (!r.ok) allOk = false;
    if (opts.scan) break; // a pinned tick (runbook smoke test) advances only that one job, one step
  }
  if (jobs.length === 0) return { ok: true, idle: "empty", jobs: [] };
  // Item 9: a tick summary breadcrumb, but only when the tick actually did the NEW thing
  // (advanced more than one distinct job) — a single-job tick stays exactly as observable
  // as before, preserving the "silent idle polls" invariant (a poll is a `wait`, not a
  // breadcrumbed transition; see Tick.poll / the "breadcrumbs: one per transition" tests).
  if (jobs.length > 1) {
    await deps.breadcrumb(null, `carscan-worker tick jobs=${jobs.length} ms=${deps.now().getTime() - start}`);
  }
  return { ok: allOk, jobs };
}
