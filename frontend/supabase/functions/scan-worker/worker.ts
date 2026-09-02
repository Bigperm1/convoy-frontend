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

import { checkFolder, heroName, isJunkScanId, mapShotsToViews, parseManifest, SHOT_FILE, SHOT_IDS, twinName } from "./manifest.ts";
import type { FolderEntry, ShotId, TripoView } from "./manifest.ts";
import { finishMaterial, MAX_BYTES, qcHero, qcTwin, sha256Hex } from "./glb.ts";
import type { QcReport } from "./glb.ts";
import { HERO_CONVERT, InsufficientCredits, isDefiniteRejection, modelUrlOf, TWIN_CONVERT } from "./tripo.ts";
import type { TripoApi } from "./tripo.ts";

export type JobStatus = "queued" | "fetching" | "generating" | "converting_map" | "converting_hero" | "done" | "failed" | "skipped";

export const TERMINAL: readonly JobStatus[] = ["done", "failed", "skipped"];

/** Which paid Tripo POST a job is inside of (or lost the reply to). */
export type PaidCall = "gen" | "map" | "hero";

export type Job = {
  scan_id: string;
  handle: string | null;
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
};

export type JobPatch = Partial<Omit<Job, "scan_id" | "created_at">>;

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
  countUserRenders(handle: string, excludeScan: string): Promise<number>;
  creditsLast24h(): Promise<number>;
  breadcrumb(handle: string | null, message: string): Promise<void>;
  listScan(scanId: string): Promise<FolderEntry[]>;
  downloadScanFile(path: string): Promise<Uint8Array>;
  modelExists(name: string): Promise<boolean>;
  uploadModel(name: string, bytes: Uint8Array): Promise<"ok" | "duplicate">;
  fetchModelPublic(name: string): Promise<Uint8Array | null>;
  /** Download a Tripo model URL. 403/404 == the 5-minute URL expired. */
  download(url: string, signal?: AbortSignal): Promise<Uint8Array | "expired">;
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
export const LEASE_S = 170;
export const POLL_S = 30;
export const INCOMPLETE_WAIT_S = 60;
export const INCOMPLETE_MAX_WAITS = 20; // ≈ 20 min of photos-still-arriving
export const GUARD_WAIT_S = 5 * 60;
export const CREDITS_PAUSE_S = 60 * 60;
export const MAX_ATTEMPTS = 5;
export const GEN_TIMEOUT_S = 30 * 60;
export const CONVERT_TIMEOUT_S = 15 * 60;
/** Timeouts are enforced as a poll COUNT (one poll per POLL_S at the fastest), so a
 *  pause of the pipeline — kill switch, cron unscheduled, Tripo unreachable — costs no
 *  budget. 60 polls of a still-running generate ≈ 30 min of actual waiting. */
export const GEN_MAX_POLLS = GEN_TIMEOUT_S / POLL_S;
export const CONVERT_MAX_POLLS = CONVERT_TIMEOUT_S / POLL_S;
export const CREDITS_GENERATE = 30;
export const CREDITS_CONVERT = 10;
export const CREDITS_PER_CAR = CREDITS_GENERATE + 2 * CREDITS_CONVERT;

const iso = (d: Date) => d.toISOString();
const plus = (d: Date, s: number) => new Date(d.getTime() + s * 1000);

type Transition = { to: JobStatus; patch: JobPatch; detail: string; resetAttempts?: boolean };

const CLEAR_PAID: JobPatch = { paid_call: null, paid_call_started_at: null };

class Tick {
  constructor(readonly deps: Deps, readonly job: Job, readonly flags: Flags, readonly signal?: AbortSignal) {}

  get now(): Date {
    return this.deps.now();
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

  fail(reason: string, extra: JobPatch = {}): Promise<TickResult> {
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
   *  Returns the task id, or a TickResult when the job must stop here. */
  private async paidSubmit(kind: PaidCall, credits: number, pre: JobPatch, call: () => Promise<string>): Promise<string | TickResult> {
    const j = this.job;
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
        await this.deps.updateJob(j.scan_id, { ...rollback, updated_at: iso(this.now) });
        Object.assign(j, rollback);
        await this.deps.setFlags({ enabled: false, paused_reason: "tripo-credits" });
        await this.crumb(`PAUSED tripo-credits on ${kind}: ${msg}`);
        return this.wait(CREDITS_PAUSE_S, { reason: "wait:tripo-credits", last_error: msg }, "paused tripo-credits");
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
    return this.commit({
      to: "fetching",
      patch: { handle: parsed.handle, shots: parsed.manifest.shots },
      detail: `handle=${parsed.handle} shots=${parsed.manifest.shots.join(",")} photos=${entries.filter((e) => e.name.endsWith(".jpg")).map((e) => e.size).join("/")}`,
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
      const shot: ShotId = views[view];
      const bytes = await this.deps.downloadScanFile(`${j.scan_id}/${SHOT_FILE[shot]}`);
      tokens[view] = await this.deps.tripo.uploadFile(bytes, SHOT_FILE[shot]);
      await this.deps.updateJob(j.scan_id, { tripo_file_tokens: tokens, updated_at: iso(this.now) });
    }
    // (b) SPEND GUARDS — in this order, all must pass, else the job WAITS. The claim
    //     serialises `fetching` (one live lease at a time), so these reads cannot race
    //     another job's generate. NOTE: `handle` is the manifest's, i.e. client-supplied —
    //     per_user_cap is a courtesy cap; daily_credit_cap + min_balance are the ceiling.
    const fresh = await this.deps.flags();
    if (!fresh || !fresh.enabled) return this.wait(GUARD_WAIT_S, { reason: "wait:disabled" }, "guard disabled");
    const others = await this.deps.countUserRenders(handle, j.scan_id);
    if (others >= fresh.per_user_cap) {
      if (j.reason === "wait:user-cap") return this.fail("user-cap", { last_error: `handle=${handle} renders=${others} cap=${fresh.per_user_cap}` });
      await this.crumb(`WAIT user-cap handle=${handle} renders=${others} cap=${fresh.per_user_cap}`);
      return this.wait(GUARD_WAIT_S, { reason: "wait:user-cap" }, "guard user-cap");
    }
    const spent24h = await this.deps.creditsLast24h();
    if (spent24h + CREDITS_PER_CAR > fresh.daily_credit_cap) {
      await this.crumb(`WAIT daily-cap spent24h=${spent24h} cap=${fresh.daily_credit_cap}`);
      return this.wait(GUARD_WAIT_S, { reason: "wait:daily-cap" }, "guard daily-cap");
    }
    const balance = await this.deps.tripo.balance();
    if (balance < fresh.min_balance + CREDITS_PER_CAR) {
      await this.crumb(`WAIT balance=${balance} floor=${fresh.min_balance + CREDITS_PER_CAR}`);
      return this.wait(GUARD_WAIT_S, { reason: "wait:balance" }, "guard balance");
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

/** One cron tick: flags -> claim -> pre-flight -> one step, with the generic error policy. */
export async function runTick(deps: Deps, opts: TickOptions): Promise<TickResult> {
  const flags = await deps.flags();
  if (!flags || !flags.enabled) return { ok: true, idle: "disabled" };
  const job = await deps.claim(opts.tickId, opts.scan);
  if (!job) return { ok: true, idle: "empty" };
  const tick = new Tick(deps, job, flags, opts.signal);
  try {
    const pre = await tick.preflight();
    if (pre) return pre;
    return await tick.advance();
  } catch (e) {
    // Only reached by errors OUTSIDE a paid POST (or a definite rejection, whose ledger
    // entry was already rolled back): retrying here never buys anything twice.
    const msg = String((e as Error)?.message ?? e).slice(0, 300);
    const attempts = (job.attempts ?? 0) + 1;
    const now = deps.now();
    deps.log(`[${job.scan_id}] ${job.status} ERROR attempt=${attempts} ${msg}`);
    if (attempts >= MAX_ATTEMPTS) {
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
