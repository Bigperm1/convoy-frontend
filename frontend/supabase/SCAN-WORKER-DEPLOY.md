# scan-worker — deploy runbook

Project `pgtbjiszjglznjagolse`. Everything below is run by the maintainer after Jeff's
go; nothing in this repo deploys itself. Order matters: the kill switch stays OFF until
the last step, so every earlier step is reversible and spends nothing.

Rollback at ANY step: `update public.pipeline_flags set enabled=false, paused_reason='rollback';`
(instant, ≤30 s to take effect) — or `select cron.unschedule('scan-worker-tick');`.
A pause never expires a paid job: timeouts are counted in polls, not minutes (worker.ts
`GEN_MAX_POLLS` / `CONVERT_MAX_POLLS`), so re-enabling hours later resumes where it stopped.

## What is already true (verified 2026-09-01, receipts in the workflow report)

- `pg_cron 1.6.4` and `pg_net 0.20.0` are available and NOT installed; Postgres 17.6.
- Vault is installed with 0 secrets; `vault.create_secret` exists.
- `postgres` holds TRIGGER on `storage.objects` (two Supabase triggers already exist there).
- Live migration ledger (`list_migrations`, 2026-09-01): eight 14-digit versions,
  `20260717220432` … `20260821191321`, `20260824032822 car_scans_bucket_insert_only`.
  The repo file for that last one is now named to match
  (`supabase/migrations/20260824032822_car_scans_bucket_insert_only.sql`); the only NEW
  migration is `20260902000100_car_scan_jobs.sql`. The cron schedule is deliberately
  NOT a migration (`supabase/ops/scan_worker_cron.sql`) — see step 6 for why.
- `car-scans` holds: `jeff-20260829-141551` (delivered), `enablewhore-20260901-185736`
  (delivered by hand), **`enablewhore-20260901-210315` (COMPLETE, 4 photos + manifest,
  NOT rendered — see step 8)**, plus junk `_selftest`, `claudetest-*`.
- `models` holds both files for jeff + enablewhore-185736, and a twin-only
  `scan_claudetest-20260821-000001_map.glb` (the worker skips it: `manual-in-progress`).
- Edge functions `register-scan`, `fetch-scan`, `publish-model` exist with `verify_jwt=true`.
- The `supabase` CLI (2.109.0) is installed but **not logged in**; Docker is not installed.
- **What has NOT run anywhere yet** (HYPOTHESIS until the step named): the SQL migration
  (step 4), the `storage.objects` trigger firing on a Storage-API upload (step 4),
  the real Supabase I/O layer `deps.ts` against the live project (step 4b — the dry run
  drives the state machine through in-memory fakes + a Tripo stub; `deps.ts` has only
  unit tests against duck-typed supabase-js shapes), `npm:pngjs`/`jpeg-js` on the hosted
  edge runtime (step 9's first `finishMs=` breadcrumb), and **worker-produced GLB bytes
  loaded in the app on a device/sim (step 4c)**.

## 0. Tooling

```bash
cd /Users/jeffmorton/convoy-frontend/frontend
supabase --version                       # 2.109.0 on this Mac
supabase login                           # browser flow; or export SUPABASE_ACCESS_TOKEN=…
supabase link --project-ref pgtbjiszjglznjagolse
git check-ignore -v supabase/.env.local  # MUST print a match before step 2 writes a value
```

If the CLI is not wanted, every step has a dashboard/MCP equivalent noted inline.

## 1. Vault secrets (SQL editor, as postgres)

```sql
select vault.create_secret('https://pgtbjiszjglznjagolse.supabase.co', 'project_url');
select vault.create_secret('<the anon JWT — the eyJ… string in src/supabase.ts>', 'anon_key');
select vault.create_secret('<openssl rand -hex 32>', 'scan_worker_key');
select name, created_at from vault.secrets order by name;   -- expect the three rows
```

Keep the `scan_worker_key` value for step 2 (it must match `SCAN_WORKER_KEY` exactly).

## 2. Edge-function secrets

```bash
cp supabase/.env.local.example supabase/.env.local     # gitignored (checked in step 0)
# fill TRIPO_API_KEY=tsk_… and SCAN_WORKER_KEY=<same hex as the Vault value>; leave TRIPO_BASE_URL empty
supabase secrets set --env-file supabase/.env.local --project-ref pgtbjiszjglznjagolse
supabase secrets list --project-ref pgtbjiszjglznjagolse   # names only: TRIPO_API_KEY, SCAN_WORKER_KEY
```

Dashboard alternative: Edge Functions → Secrets. Names must not start with `SUPABASE_`.

## 3. Deploy the function (verify_jwt stays true)

```bash
supabase functions deploy scan-worker --project-ref pgtbjiszjglznjagolse
supabase functions list --project-ref pgtbjiszjglznjagolse   # scan-worker ACTIVE, verify_jwt true
```

MCP alternative: `deploy_edge_function` with the six files under
`supabase/functions/scan-worker/` (`index.ts` entrypoint; `deps.ts`, `worker.ts`,
`tripo.ts`, `glb.ts`, `manifest.ts`; `deno.json` for the import map). Do not upload the
tests/fakes/dryrun.

## 4. Migration — tables, RPC, trigger, seeds (flags DISABLED)

`supabase db push` applies **every** file under `supabase/migrations/` whose 14-digit
version is not yet in `supabase_migrations.schema_migrations`, in version order, and it
cannot apply "just one". That is why the cron schedule is not a migration and why the
plan is printed first:

```bash
supabase db push --project-ref pgtbjiszjglznjagolse --dry-run
```

Expected plan: **exactly one** file, `20260902000100_car_scan_jobs.sql`. If the plan also
lists `20260824032822_car_scans_bucket_insert_only.sql`, the ledger row and the file name
disagree — do NOT let it re-run (its `create policy` would abort the push against the
policy that already exists). Reconcile the ledger instead, then re-check the plan:

```bash
supabase migration list --linked                                   # compare local vs remote versions
supabase migration repair --status applied 20260824032822 --linked # only if the plan listed it
supabase db push --project-ref pgtbjiszjglznjagolse --dry-run      # must now show the one file
supabase db push --project-ref pgtbjiszjglznjagolse
```

SQL-editor / MCP alternative: paste `supabase/migrations/20260902000100_car_scan_jobs.sql`
into `apply_migration` (name `car_scan_jobs`) — then ALSO run
`supabase migration repair --status applied <the version apply_migration recorded> --linked`
or a later `db push` will try the file again. Verify:

```sql
select enabled, daily_credit_cap, per_user_cap, min_balance from public.pipeline_flags;   -- false, 300, 2, 100
select scan_id, status, reason, credits_spent from public.car_scan_jobs order by scan_id;
-- jeff… done · enablewhore-…185736 done · claudetest-* skipped   (nothing else yet)
select tgname from pg_trigger where tgrelid='storage.objects'::regclass and tgname='car_scan_enqueue';
select proname, prosecdef from pg_proc where proname in ('claim_scan_job','car_scan_enqueue');   -- both security definer
```

Trigger proof (HYPOTHESIS until this runs — Supabase's webhook docs say webhooks are
trigger wrappers on this table, but a Storage-API upload firing a user trigger has not
been observed here yet):

```bash
# upload a probe manifest with the shipped anon key (INSERT is allowed; content is junk on purpose)
curl -s -X POST "https://pgtbjiszjglznjagolse.supabase.co/storage/v1/object/car-scans/_selftest/$(date +%s)/manifest.json" \
  -H "Authorization: Bearer <anon>" -H "apikey: <anon>" -H "Content-Type: application/json" --data '{"probe":true}'
```
```sql
select scan_id, status from public.car_scan_jobs where scan_id='_selftest';   -- expect: _selftest | queued
```
If no row appears, the trigger did not fire: fall back to the manual enqueue in step 8
for every scan (and open a follow-up to poll the bucket from the tick instead).

## 4b. Integration probe — the REAL I/O layer, service role, ZERO credits

`deps.ts` (supabase-js storage list/download/upload, the `claim_scan_job` RPC, row
updates, breadcrumb inserts, public-bucket HEAD) has never executed against the live
project. This step runs every read path and every row write with the daily cap at 0, so
the generate guard blocks before the only paid POST. It needs `TRIPO_API_KEY` set (step
2): the four photo uploads to Tripo are free and are part of the probe.

```bash
TS=$(date +%Y%m%d-%H%M%S); SCAN="probe-$TS"
# four REAL JPEGs > 100 KB each (any phone photos; content is irrelevant, size is gated) + a manifest that parses
for f in 01-front 02-right 03-rear 04-left; do
  curl -s -X POST "https://pgtbjiszjglznjagolse.supabase.co/storage/v1/object/car-scans/$SCAN/$f.jpg" \
    -H "Authorization: Bearer <anon>" -H "apikey: <anon>" -H "Content-Type: image/jpeg" --data-binary @/path/to/any-photo.jpg
done
curl -s -X POST "https://pgtbjiszjglznjagolse.supabase.co/storage/v1/object/car-scans/$SCAN/manifest.json" \
  -H "Authorization: Bearer <anon>" -H "apikey: <anon>" -H "Content-Type: application/json" \
  --data "{\"handle\":\"probe\",\"platform\":\"runbook\",\"scanId\":\"$SCAN\",\"uploaded\":4,\"failed\":[],\"shots\":[\"front\",\"right\",\"rear\",\"left\"]}"
```
```sql
-- the trigger (step 4) should have enqueued it; if not, insert it by hand:
insert into public.car_scan_jobs (scan_id, status) values ('<SCAN>', 'queued') on conflict do nothing;
-- open the switch with the spend guard shut: cap 0 blocks the generate AFTER the uploads
update public.pipeline_flags set enabled=true, daily_credit_cap=0, paused_reason='probe' where id=1;
```
```bash
# two pinned ticks: queued->fetching, then fetching -> uploads -> guard daily-cap -> wait
for i in 1 2; do curl -s -X POST "https://pgtbjiszjglznjagolse.supabase.co/functions/v1/scan-worker" \
  -H "Authorization: Bearer <anon>" -H "x-worker-key: <scan_worker_key>" -H "Content-Type: application/json" \
  -d "{\"scan\":\"$SCAN\",\"source\":\"probe\"}"; echo; done
# 1st: {"ok":true,"scan":"probe-…","from":"queued","to":"fetching","detail":"handle=probe shots=front,right,rear,left photos=…"}
# 2nd: {"ok":true,"scan":"probe-…","from":"fetching","to":"fetching","detail":"guard daily-cap"}
```
```sql
select status, handle, shots, tripo_file_tokens is not null as tokens, credits_spent, reason, last_error, attempts
  from public.car_scan_jobs where scan_id='<SCAN>';
-- fetching | probe | {front,right,rear,left} | true | 0 | wait:daily-cap | null | 0
select created_at, handle, message from public.crash_reports where message like 'carscan-worker id=probe-%' order by created_at;
-- queued->fetching …   then   WAIT daily-cap spent24h=… cap=0
-- then close the probe and the switch:
update public.car_scan_jobs set status='skipped', reason='probe', lease_until=null where scan_id='<SCAN>';
update public.pipeline_flags set enabled=false, daily_credit_cap=300, paused_reason=null where id=1;
```

Any `"ok":false` / `ERROR attempt=` breadcrumb here is a real-I/O bug (list/download/
RPC/update/insert) found for $0 — fix it before step 6. Not covered by the probe: the
`models` bucket upload + public round trip (`uploadModel`/`fetchModelPublic`); those are
unit-tested against storage-js's documented 409 shapes (`deps_test.ts`) and first run for
real on the first automated scan, twin first — a failure there costs at most 40 credits
and never reaches a device.

## 4c. Load worker-made bytes in the app on the sim (GLB QC rule)

The worker's material pass rebuilds the BIN chunk (orphaned MR bytes dropped), so its
output is a byte shape no device has rendered yet: `worker_twin.glb` (1,061,704 B,
sha256 `48759082…`) vs the delivered `scan_enablewhore…_map.glb` (1,419,852 B). Both
validate clean under `gltf-transform validate`, but the repo rule is **GLB QC = load it
in the app on the sim**, so before step 9:

1. Publish the two review artefacts under a junk id (the worker skips `claudetest-`):
   `tools/glb-pipeline/publish_model.sh` → `scan_claudetest-<ts>_map.glb` then
   `scan_claudetest-<ts>.glb` (from the workflow scratchpad `review-out/worker_twin.glb`
   / `worker_hero.glb`, or regenerate: `deno run` `finishMaterial` over the raw converts).
2. On the iOS sim (`./scripts/sim-ios.sh`, `/verify-carplay` for the CarPlay window) and
   the Android emulator (`/verify-android`), set the test install's
   `carScanId='claudetest-<ts>'`, `carScanStatus='submitted'` (`src/settings.ts`); the
   Garage poll flips to `ready` on its own and `carScanMapUrl` / `carScanModelUrl` point
   at the two files. Confirm: the car draws on the phone map, on CarPlay, on Android
   Auto (`carStore.selfScanMapUrl`), and in the Garage hero (`CarHero3D`).
3. Record the receipt (screenshots + the two URLs) here before flipping the switch.

## 5. Smoke the function — expect `idle: disabled`

```bash
curl -s -X POST "https://pgtbjiszjglznjagolse.supabase.co/functions/v1/scan-worker" \
  -H "Authorization: Bearer <anon>" -H "x-worker-key: <scan_worker_key>" \
  -H "Content-Type: application/json" -d '{"source":"smoke"}'
# {"tick":"…","source":"smoke","ok":true,"idle":"disabled"}
# wrong/missing x-worker-key -> 401 "unauthorized"; missing secrets -> 500 {"error":"misconfigured"}
```

## 6. The heartbeat — pg_cron + pg_net + the schedule (NOT a migration)

```bash
supabase db query --linked -f supabase/ops/scan_worker_cron.sql
```

(or paste it into the SQL editor / MCP `execute_sql`). It is idempotent and lives outside
`migrations/` on purpose: a `db push` must never start the schedule before steps 3–5 have
passed. Verify after ~90 s:

```sql
select jobid, jobname, schedule, active from cron.job where jobname='scan-worker-tick';
select start_time, status, return_message from cron.job_run_details
 where jobid=(select jobid from cron.job where jobname='scan-worker-tick') order by start_time desc limit 3;
select id, status_code, left(content,80) from net._http_response order by created desc limit 3;
-- expect 200s whose content is {"ok":true,"idle":"disabled",…}
```

## 7. Decide the twin recipe and the plate question (Jeff)

Both are open questions in the workflow report. Defaults shipped: 20k-face twin,
public `models` bucket unchanged. Change nothing here unless Jeff says so.

## 8. The scan that is waiting RIGHT NOW

`enablewhore-20260901-210315` is complete in `car-scans` (3.4/2.7/3.1/2.5 MB + manifest,
uploaded 2026-09-02 04:03 UTC, registered `used=2/2`) and has **no models**. Once the
trigger exists it will NOT be enqueued retroactively (the manifest INSERT already
happened). Pick one:

- **Let it be the first automated scan** (recommended — it is the live test):
  `insert into public.car_scan_jobs (scan_id, status) values ('enablewhore-20260901-210315','queued') on conflict do nothing;`
  It is enablewhore's second render → the per-user cap (2) allows it.
- **Render it by hand first** (SCAN-PIPELINE.md "By hand"): publish twin then hero; the
  worker's pre-flight then marks it `done already-published` for 0 credits if it is ever enqueued.

## 9. Enable — the one step that spends

```sql
update public.pipeline_flags set enabled=true, paused_reason=null, updated_at=now() where id=1;
```

Watch, from another SQL tab, for ~8 minutes:

```sql
select created_at, handle, message from public.crash_reports
 where message like 'carscan-%' order by created_at desc limit 30;
select scan_id, status, credits_spent, attempts, state_polls, paid_call, reason, last_error, next_run_at from public.car_scan_jobs
 where status not in ('done','skipped') or updated_at > now() - interval '1 hour';
```

Expected sequence for one scan: `queued->fetching` → `fetching->generating gen=… credits=30`
→ (silent polls) → `generating->converting_map … credits=40` → `converting_map->converting_hero
twin=… verts=… idx=u16 finishMs=… credits=50` → `converting_hero->done`. Then the app's own
`carscan-ready` / `carscan-delivered` rows follow on the tester's next Garage poll (≤20 s).
A `warn=` suffix on a transition is informational (hero geometry / missing MR texture).

Confirm the bytes:
```bash
curl -sI https://pgtbjiszjglznjagolse.supabase.co/storage/v1/object/public/models/scan_<id>_map.glb | head -1
curl -s  https://pgtbjiszjglznjagolse.supabase.co/storage/v1/object/public/models/scan_<id>_map.glb -o /tmp/t.glb && python3 tools/glb-pipeline/glbinfo.py /tmp/t.glb
```

## 10. Only then: the garage-capture copy OTA

`app/(app)/garage-capture.tsx` still says *"Your car is built by hand right now, so give
it a day or two"*. After the first automated scan lands, change it to match
`src/ScanHero.tsx`'s 6-minute countdown and ship via `/ship-ota`. Not before.

## Money model — what the caps do and do not bound

- **Intent before spend.** Every paid Tripo POST is preceded by one row update that sets
  `paid_call` (`gen`/`map`/`hero`) + `paid_call_started_at` and adds the credits to
  `credits_spent`; the update that stores the task id clears the marker. A row with the
  marker set and no task id means the tick died inside the POST. The worker then NEVER
  re-POSTs a generate (`failed gen-submit-unknown`, ledger keeps the 30 — recover by
  hand below); a convert gets one bounded retry (shares `convert_retries`, max 1, so a
  job's ceiling is 60 credits). A DEFINITE rejection (Tripo's own error envelope with a
  code — no task created) rolls the ledger back and takes the ordinary 5-strike retry.
- **`per_user_cap` keys on the handle from `manifest.json` — client-supplied.** It stops
  a tester's own third render; it does not stop someone writing a fresh handle into the
  manifest. `daily_credit_cap` (300 = $3/day, rolling 24 h) and `min_balance` + 50 are the
  real ceiling, and both count the conservative ledger (lost replies included).
- **Claims are serialised**: `claim_scan_job` hands out at most one `fetching` row with a
  live lease (advisory lock), so the cap reads and the generate of one job never
  interleave with another's. Polls of the other states run in parallel as before.
- **Timeouts are poll counts** (`state_polls`: 60 for a generate ≈ 30 min, 30 for a
  convert ≈ 15 min), reset on every transition. The kill switch, an unscheduled cron or an
  unreachable Tripo never burn a job's budget.

## Operations

| need | do |
|---|---|
| stop all spend now | `update public.pipeline_flags set enabled=false, paused_reason='<why>' where id=1;` (safe for any length of time — no job expires while paused) |
| stop the heartbeat | `select cron.unschedule('scan-worker-tick');` (re-run `supabase/ops/scan_worker_cron.sql` to restore) |
| re-trigger a scan | `insert into public.car_scan_jobs(scan_id,status) values('<id>','queued') on conflict do nothing;` |
| retry a failed job at its state | `update public.car_scan_jobs set status='<state>', attempts=0, state_polls=0, lease_until=null, next_run_at=now() where scan_id='<id>';` (only when `paid_call` is null — see the next two rows) |
| hero-only failure (twin live) | `update … set status='converting_map', attempts=0, state_polls=0, paid_call=null, paid_call_started_at=null, lease_until=null, next_run_at=now()` — `twin_published_at` is set, so the worker buys ONLY the hero (+10, explicit human action) |
| push one job now | `curl … /functions/v1/scan-worker -d '{"scan":"<id>"}'` (same headers as step 5) |
| `failed gen-submit-unknown` (lost generate reply) | Tripo dashboard / `tripo task <id>`: find a multiview task created at `paid_call_started_at` for that account. **Task exists** → `update … set tripo_gen_task='<task>', status='generating', paid_call=null, paid_call_started_at=null, attempts=0, state_polls=0, next_run_at=now()`. **No task** → `update … set status='fetching', paid_call=null, paid_call_started_at=null, credits_spent=credits_spent-30, generate_submitted_at=null, attempts=0, next_run_at=now()` (the ledger was conservative). There is no Tripo API to list tasks, so this stays manual. |
| `failed map-submit-unknown` / `hero-submit-unknown` | the bounded retry was already used; same two branches as above with the convert task, `status='converting_map'`/`'converting_hero'`, and `credits_spent-10` if no task exists |
| rotate the worker key | new hex → Vault `vault.update_secret` + `supabase secrets set SCAN_WORKER_KEY=…` |
| raise/lower caps | `update public.pipeline_flags set daily_credit_cap=…, per_user_cap=…, min_balance=…;` |

## Open questions (not decided by this deploy)

1. **Plate privacy** — the public hero texture can carry a legible plate; automation
   publishes every tester's with nobody looking. Accept / private bucket + signed URLs
   (app change) / mask step. Jeff's call before step 9.
2. **Twin faces 20k vs 40k** — worker hard-codes 20k (doc + last delivery). 40k needs the
   vert gate raised to <35,000 and the doc changed.
3. **Failed renders are invisible to the tester** — `carScanStatus:'failed'` exists in
   settings.ts but nothing sets it; the register-scan slot stays burned. Follow-up OTA.
4. **Trigger on `storage.objects` from Storage-API uploads** — HYPOTHESIS until step 4's probe.
5. **npm:pngjs / jpeg-js under the Supabase edge runtime** — VERIFIED under Deno 2.6.4 on
   the Mac (twin 29–37 ms, hero 86–97 ms); HYPOTHESIS on the hosted runtime until step 9's
   first `converting_map->converting_hero` breadcrumb shows a `finishMs=`.
6. **6-minute promise** — automated critical path ≈ manual 5.5 min + ~5 tick latencies.
   Re-measure from `car_scan_jobs` timestamps after the first three scans; tighten the
   cron to `'15 seconds'` if needed (`select cron.alter_job(job_id := …, schedule := '15 seconds');`).
7. **The SQL has not been executed anywhere** (no Docker → no local stack; the live
   project is off-limits to this workflow). `supabase db push --dry-run` + step 4 settle
   it; the file fails loudly on a re-run (`create type` / `create table`) instead of doing harm.
8. **Worker-made GLB bytes on a device** — HYPOTHESIS until step 4c's receipt exists.
