# scan-worker — the automatic photo → car pipeline

Jeff, 2026-09-01: *"this pipeline is not suppose to have any manual input, it is suppose
to be all automatic from the photos sent to the delivery of the 3d image and 2d twin
back to the device it was sent from."*

This edge function is that automation. **It is not deployed by anything in this repo** —
see `supabase/SCAN-WORKER-DEPLOY.md` for the runbook the maintainer runs.

## Shape

```
app upload  car-scans/<scanId>/01-front … 04-left.jpg + manifest.json
   └─ trigger car_scan_enqueue (storage.objects INSERT of …/manifest.json)
        └─ public.car_scan_jobs row, status queued
pg_cron every 30 s ─► public.scan_worker_tick() ─► net.http_post ─► scan-worker
   ├─ x-worker-key == SCAN_WORKER_KEY ? else 401
   ├─ pipeline_flags.enabled ? else {idle:'disabled'}       (kill switch, fail closed)
   ├─ claim_scan_job()  one job, FOR UPDATE SKIP LOCKED, 170 s lease
   ├─ pre-flight: both models live → done (0 credits) · twin-only not ours → skipped
   └─ advance ONE state:
        queued ──► fetching ──► generating ──► converting_map ──► converting_hero ──► done
        (folder+   (upload 4    (poll; then    (poll; download; QC;   (poll; download; QC;
        manifest    photos;      convert twin)  finish; publish TWIN;  finish; publish HERO)
        gates)      guards;                      convert hero)
                    GENERATE 30)                 10                     10
```

Delivery is already wired in the app: `src/carScan.ts checkScanReady` HEADs the hero
then the twin and flips the Garage/map/CarPlay/AA to the new car. The worker therefore
publishes the **twin first and the hero last**, always.

## Files

| file | what |
|---|---|
| `index.ts` | `Deno.serve` handler: auth, env, the 130 s budget — wiring only |
| `deps.ts` | the REAL `Deps` over supabase-js (service role) + fetch; unit-tested in `deps_test.ts`, never yet run against the live project (runbook step 4b) |
| `worker.ts` | the state machine (`runTick`), every spend guard, the error policy |
| `tripo.ts` | the four Tripo REST calls, payloads copied from `tripo history --json` |
| `glb.ts` | GLB parse/write, the Mapbox QC gates, the material pass (scan_finish.py port) |
| `manifest.ts` | scan-id rules, manifest parsing, **shot → Tripo view mapping** |
| `fakes.ts` | in-memory `Deps` for tests + the dry run |
| `*_test.ts` | `deno test` — 52 tests, incl. pixel parity with `scan_finish.py` on the real files, lost-reply / crash-between-writes / pause / claim-serialisation cases |
| `dryrun.ts` | end-to-end proof against the Tripo stub with 0 credits / 0 writes |

## Secrets (names only — values live in Supabase, never here)

| where | name | used for |
|---|---|---|
| edge function secret | `TRIPO_API_KEY` | Tripo REST (`tsk_…`) |
| edge function secret | `SCAN_WORKER_KEY` | `x-worker-key` the cron caller must present (`openssl rand -hex 32`) |
| edge function secret (optional) | `TRIPO_BASE_URL` | the local stub for `functions serve`; unset in prod |
| platform-injected | `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` | read `car-scans`, write `models`, tables |
| Vault | `project_url`, `anon_key`, `scan_worker_key` | read by `scan_worker_tick()` at call time |

The `x-publish-key` used by `fetch-scan` / `publish-model` is **not** involved: the
worker holds the service role and reads/writes the buckets directly.

## Money rules (each is code, not a comment)

- `pipeline_flags.enabled` (default **false**) read at the top of every tick and again
  right before the generate POST; unreadable == disabled.
- One generate per scan: `scan_id` is the PK, the trigger is `on conflict do nothing`,
  the POST happens once guarded by `tripo_gen_task is null`, never auto-resubmitted.
- **Intent before spend**: every paid POST is preceded by one row update recording
  `paid_call` + `paid_call_started_at` and the credits; the task id's update clears it. A
  tick that dies inside the POST leaves the marker, and the next tick never re-POSTs: a
  generate fails `gen-submit-unknown` (manual recovery, runbook), a convert gets ONE
  bounded retry (`convert_retries`, shared with the expired-URL re-convert). Ceiling per
  job: 60 credits. A DEFINITE Tripo rejection (error envelope with a code) rolls the
  ledger back and takes the ordinary 5-strike retry.
- Claims are serialised: at most one `fetching` job holds a live lease, so the cap reads
  cannot race another job's generate. `per_user_cap` keys on the manifest's handle
  (client-supplied) — a courtesy cap; `daily_credit_cap` + `min_balance` are the ceiling.
- Per-user cap (`per_user_cap`, 2), rolling-24 h cap (`daily_credit_cap`, 300 = 6 cars),
  balance floor (`min_balance` + 50). A guard failing **waits** (5 min); only the user
  cap becomes a `failed user-cap` after one wait. Tripo code 2010 (insufficient credits)
  flips `enabled=false, paused_reason='tripo-credits'`.
- Hero convert (10) is only bought after the twin passed every gate, its public round
  trip hashed equal, AND `twin_published_at` is on the row — so no crash between the two
  can strand a live twin as "manual". A bad reconstruction costs 40, not 50, and never
  reaches a device. The hero gate is the spec's (≤ 30 MB, parseable); geometry
  deviations and a missing MR texture are `warn=` in the breadcrumb, never failures.
- Timeouts are poll counts (`state_polls`), not wall-clock: the kill switch never expires a paid job.
- Publish is `upsert:false`; 409 → sha256 compare (equal: continue, different: `failed
  *-conflict`). Nothing is ever deleted.
- Idempotent against hand renders: both files live → `done` (0 credits); a twin the
  worker did not publish → `skipped manual-in-progress`. A twin whose bytes hash to the
  job's `twin_pending_sha256` (written before the upload) is reclaimed as ours.

## Observability

`car_scan_jobs` is the state of record. Every transition also inserts one row into
`public.crash_reports` as `carscan-worker id=<scan> <from>-><to> <detail>` with the
tester's handle — the same table `carscan-registered` / `carscan-ready` /
`carscan-delivered` already use, so one query shows the whole timeline:

```sql
select created_at, handle, message from public.crash_reports
 where message like 'carscan-%' order by created_at desc limit 50;
```

Idle polls write nothing. `cron.job_run_details` and `net._http_response` carry the
per-tick HTTP result for free.

## Local verification (no Docker needed)

```bash
tools/glb-pipeline/scan_worker_dryrun.sh --render-dir <a manual tripo-<scan> dir>
# or with prebuilt fixtures:
tools/glb-pipeline/scan_worker_dryrun.sh --fixtures <dir with raw_twin.glb raw_hero.glb>
```

That runs `deno check`, `deno lint`, `deno test` (52), starts
`tools/glb-pipeline/tripo_stub.py`, and ticks the state machine to `done` against it
while probing the real `car-scans` (through the read-only `fetch-scan` door) and the
public `models` bucket with HEAD/GET only. `deno` is not installed on the Mac; the script
falls back to `npx --yes deno@2.6.4`.

What the dry run does NOT exercise: `deps.ts` (the real storage/DB calls) — see the
runbook's step 4b integration probe — and rendering the produced bytes on a device (4c).

## Known gaps (see SCAN-WORKER-DEPLOY.md "Open questions")

- Failed renders are invisible to the tester (the app has no failure signal yet).
- The `models` bucket is public and a plate can be legible in a hero texture.
- Twin recipe is 20k faces (doc + last delivery); Jeff's own delivered twin is the 40k build.
