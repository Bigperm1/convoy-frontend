# THE SCAN PIPELINE — photos → your car, everywhere

**This is the pipeline.** Four photos from the app become the Garage hero and the 3D map
marker through **Tripo and nothing else** — no Blender, no manual mesh work, no bench
step. Every number in here was measured on real scans (`jeff-20260829-141551` on
2026-08-29, `enablewhore-20260901-185736` on 2026-09-01), not read off documentation.

Status: **LIVE — `pipeline_flags.enabled = true` since 2026-09-02 00:21 PT.** The first
unattended tester render (`enablewhore-20260901-210315`, Olaf) went photos → twin → hero
with no hands on it: flip 00:21:48 → `fetching` 00:22:18 → `generating` 00:22:48 →
`converting_map` 00:26:20 → twin published 00:27:21 → hero published 00:29:21 → `done`
→ **Olaf's iPhone logged `carscan-ready hero=1 map=1` at 03:47:51** (the Garage-screen poll,
the moment he next opened it — the return leg to the sending device is proven, not assumed).
**7 min 47 s, 50 credits, 0 retries, 0 errors** (receipts: `car_scan_jobs`,
`crash_reports platform='worker'`, `net._http_response`; the public bytes were
re-downloaded and re-inspected with `tools/glb-pipeline/glbinfo.py` — twin 15,096 v / u16 /
1.9097 m, hero 88,192 v / 1.9101 m, sha256 == the worker's ledger). The automation is
`supabase/functions/scan-worker/` + three migrations; runbook `supabase/SCAN-WORKER-DEPLOY.md`
(now ONE human paste — `TRIPO_API_KEY`; the worker reads `scan_worker_key` from Vault itself).
"By hand" below is the fallback and the reference the worker was measured against.

**v3 — launch sizing, LIVE 2026-09-02 08:15 PT** (`scan-worker` version 4, cron 15 s, caps 6000/day):
supervised run `qa-20260902-081500` through the NEW server-issued-slot path — slot consumed
08:15:20, generate bought 08:15:35, twin 08:19:24, hero 08:20:53, `done` 50 credits, 0 errors,
**5 min 46 s** (polls every 30 s instead of 60). Public bytes re-hashed == ledger. App OTA
group `0a6ea103…` makes the phone ask the backend for its slot (`POST /api/scan/slot`);
`pipeline_flags.require_slot` stays FALSE until testers are on that JS, then flips.

Jeff, 2026-09-01: *"this pipeline is not suppose to have any manual input, it is suppose
to be all automatic from the photos sent to the delivery of the 3d image and 2d twin back
to the device it was sent from."*

---

## The chain

```
app capture (4 shots)                       app/(app)/garage-capture.tsx · src/carScan.ts
  └─ car-scans/<scanId>/01-front.jpg 02-right.jpg 03-rear.jpg 04-left.jpg + manifest.json
     (bucket: WRITE-ONLY to the app. The scanId is MINTED BY THE BACKEND:
      POST /api/scan/slot -> public.scan_slots, bound to the signed-in ACCOUNT)
       └─ DB trigger car_scan_enqueue  (INSERT of …/manifest.json)  → car_scan_jobs row
            └─ pg_cron every 15 s → scan_worker_tick() → edge fn scan-worker  (up to 25 jobs/tick)
                 ├─ queued        folder complete? manifest sane? SLOT looked up ->
                 │                identity = slot.user_id (legacy: manifest.handle)
                 ├─ fetching      4 photos → Tripo file tokens · SPEND GUARDS · generate   30 credits
                 ├─ generating    poll → convert twin (20000 faces / 1024 / -x / 1.9101)   10 credits
                 ├─ converting_map    poll → download → QC GATES → material pass →
                 │                    publish models/scan_<scanId>_map.glb  ← FIRST
                 │                    → convert hero (150000 / 2048 / -x / 1.9101)        10 credits
                 ├─ converting_hero   poll → download → QC → material pass →
                 │                    publish models/scan_<scanId>.glb      ← LAST
                 └─ done  (breadcrumb 'carscan-worker … done credits=50')
                      └─ app polls (HEAD) → Garage hero + map marker on
                         phone / CarPlay / Android Auto — live, no restart
```

**Cost per finished car: 50 credits = $0.50.** 1 credit = $0.01, pay-as-you-go.
Failed Tripo tasks auto-refund. The worker never resubmits a generate; the only path
above 50 is ONE extra convert (+10) — a re-convert after an expired download URL, or one
retry after a convert POST whose reply was lost — so 60 is the ceiling per scan.

## Live configuration — and how to check it

**Verified 2026-09-02 18:28 PT.** The row is the source of truth; this table is a snapshot.

| flag (`public.pipeline_flags`, id = 1) | value | meaning |
|---|---|---|
| `enabled` | **true** | the kill switch. false = nothing spends, within one tick |
| `require_slot` | **false** | transition switch — see below. Flip only after the OTA is picked up |
| `daily_credit_cap` | **6000** | 100 cars per rolling 24 h ($60/day ceiling) |
| `per_user_cap` | **2** | the two scans included with Ultra |
| `min_balance` | **300** | never buy below this + 60 |
| `paused_reason` | null | set to `tripo-credits` by an out-of-credits generate; clears itself on top-up |

Also live: pg_cron `scan-worker-tick` **every 15 s** (jobid 2) - edge fn `scan-worker`
**version 4** - `register-scan` **version 3** - worker-side `MAX_ACTIVE_TRIPO` = 8.

```sql
-- health, one query
select enabled, require_slot, daily_credit_cap, per_user_cap, min_balance, paused_reason
  from public.pipeline_flags where id = 1;

-- a scan's life
select scan_id, status, reason, credits_spent, user_id, twin_published_at, hero_published_at
  from public.car_scan_jobs order by updated_at desc limit 10;

-- what the worker did (breadcrumbs land under the TESTER's handle)
select created_at, handle, message from public.crash_reports
 where platform = 'worker' order by created_at desc limit 40;

-- every tick's JSON verdict (idle:disabled | idle:empty | jobs:[...])
select created, status_code, left(content::text, 160) from net._http_response
 order by created desc limit 20;
```

**The off switch - one line, takes effect within one tick:**
```sql
update public.pipeline_flags set enabled=false, paused_reason='manual', updated_at=now() where id=1;
```
Heartbeat off entirely: `select cron.unschedule('scan-worker-tick');`

**The one flip still owed.** `require_slot=false` lets a slot-less folder render on the
legacy manifest-handle path, so testers on JS older than OTA `0a6ea103...` keep working.
Flip it to `true` **only once every active tester is on that OTA or newer** - check first,
because a stranded tester (CarPlay-first launch, `launch_kind='unknown'`) is still on the
embedded bundle and their scans would be skipped, never rendered:
```sql
select handle, count(distinct instance_id) sessions, max(created_at) last_seen
  from public.crash_reports
 where launch_kind = 'unknown' and created_at > now() - interval '3 days'
 group by 1 order by sessions desc;   -- must be EMPTY before flipping
```

## Automation — how the worker behaves

**Launch sizing v3 (2026-09-02, throughput + spend safety — 170 Ultra members × 2 scans):**

- **Several jobs per tick.** `runTick` loops claim → pre-flight/advance → claim again,
  until claim() has nothing left, a soft work budget (`TICK_WORK_BUDGET_MS`, 100 s of the
  130 s tick budget) is spent, or a hard cap (`MAX_JOBS_PER_TICK`, 25) is hit. Each job
  keeps its own try/catch — one job's error never stops the rest of the tick. The old
  "one job per tick" meant a burst of N scans made the Nth wait ~N × 30 s; a burst now
  drains at up to 25 jobs/tick instead. The single-lease rule in `claim_scan_job` is
  unchanged (it serialises the BUY step, not the tick) — polls of other states already
  ran in parallel and still do.
- **Faster polls.** Cron tightened from every 30 s to every **15 s**
  (`supabase/ops/scan_worker_cron_15s.sql`) and `POLL_S` from 30 to **20**. The old
  POLL_S(30) == cron-interval(30) pairing raced on pg_cron's fixed wall-clock grid — a row
  due a few hundred ms after a grid mark missed it and waited a full extra cycle (observed
  live: one generate polled at 00:24:19 and 00:25:19, a dead 60 s apart, with an
  `idle:empty` tick between, despite POLL_S=30). Timeouts stay fixed in wall-clock seconds
  (30 min generate, 15 min convert); the poll-COUNT that bounds them is re-derived from
  `POLL_S` (now 90 / 45, was 60 / 30) so the real waiting time they allow is unchanged.
- **Kill switch**: `public.pipeline_flags.enabled` (default false). `update … set
  enabled=false` stops all spend within 30 s. Read at the top of every tick AND re-read by
  every paid call (`paidSubmit`) right before its intent write — not just the generate —
  because a multi-job tick shares one `flags` snapshot across every job it advances; the
  re-read is what stops a LATER job in the same tick spending on stale information after
  an earlier job (or an operator) changes it mid-tick. Unreadable == disabled.
- **Guards before a paid POST reserve `MAX_CREDITS_PER_JOB` (60 — one generate + two
  converts + one retry), not the optimistic `CREDITS_PER_CAR` (50, kept only for
  docs/breadcrumbs)**: per-handle cap (`per_user_cap`, 2 — same number as register-scan;
  keyed on the manifest's handle, i.e. client-supplied, so a courtesy cap), rolling-24 h
  cap (`daily_credit_cap`, 6000 = 100 cars/day at launch sizing) and Tripo balance ≥
  `min_balance` + 60 — those two are the real ceiling. `paidSubmit` also asserts the
  ceiling directly (`credits_spent + credits > MAX_CREDITS_PER_JOB` → `failed ceiling`,
  no spend) as a structural invariant, independent of the guards that are meant to prevent
  it ever tripping. A guard failing waits 5 min. Claims are serialised so only one job is
  ever in `fetching` with a live lease: the cap reads cannot race another job's generate.
- **Abort/budget defers a paid call, never spends it.** Before a paid POST's intent write
  (and between each of the four photo uploads), if the tick's own AbortSignal is set or
  under `PAID_CALL_RESERVE_MS` (25 s) of tick budget remains, the job **waits** instead —
  zero ledger change, already-uploaded file tokens stay on the row, and the next tick
  resumes exactly where this one deferred. This is what stops the wall-clock kill from
  ever landing mid-POST, which is otherwise indistinguishable from a lost reply.
- **Tripo 5xx is ambiguous, even with a parsed error code.** A sub-500 status with a JSON
  error code is a DEFINITE rejection (Tripo's app layer ran and refused it — no task, no
  charge, ledger rolled back). A 5xx can carry a well-formed envelope that describes a
  proxy failure, not Tripo's own considered answer — the task may exist anyway — so it
  falls through to the same lost-response handling as a network timeout (one bounded
  retry for a convert, never a re-POST for a generate).
- **Insufficient Tripo credits pauses the JOB, not the pipeline.** `enabled` is left
  untouched (item 7, launch sizing v3 — was a full pipeline disable); only
  `pipeline_flags.paused_reason='tripo-credits'` is set and the job waits 10 min
  (`CREDITS_PAUSE_S`, was 60). The balance guard in `fetching` re-checks Tripo's live
  balance every cycle and clears `paused_reason` the moment it passes — a human top-up
  resumes rendering with no flip of any switch, and every OTHER job keeps spending
  normally the whole time.
- **Intent before spend**: each paid POST is preceded by one row update that records
  `paid_call` + `paid_call_started_at` and adds the credits to the ledger; the task id's
  update clears it. A tick that dies inside the POST (edge wall clock, abort, network)
  leaves the marker, and the next tick never re-POSTs: a generate fails
  `gen-submit-unknown` (recovered by hand from Tripo's dashboard — there is no task-list
  API), a convert gets one bounded retry. Only a definite Tripo rejection (its own error
  envelope, sub-500, no task created) rolls the ledger back and retries normally.
- **QC before spend**: the hero convert is only bought after the twin passed every
  Mapbox gate below, its public round trip hashed equal, AND `twin_published_at` is on the
  row (so a crash between the two never strands a live twin as "manual"). A bad
  reconstruction costs 40. The hero's own gate is ≤ 30 MB + parseable, as this doc says;
  its extent / grounding / centre and a missing MR texture are breadcrumb warnings.
- **Idempotent with hand renders**: on every tick, both files live → `done` (0 credits);
  a twin the worker did not publish → `skipped manual-in-progress` (never resumes a
  human's render); a twin whose bytes hash to the job's `twin_pending_sha256` is the
  worker's own (tick died after the upload) and is reclaimed. Publishes are
  `upsert:false`; a 409 is settled by sha256; nothing is ever deleted.
- **Observability**: `car_scan_jobs` is the state of record; every transition also drops
  a `carscan-worker id=<scan> <from>-><to> …` row into `crash_reports` under the tester's
  handle, so `where message like 'carscan-%'` shows register → worker → ready → delivered.
  A tick that advances MORE THAN ONE job also drops one summary breadcrumb,
  `carscan-worker tick jobs=N ms=…` (handle null) — a single-job tick stays exactly as
  quiet as before (no breadcrumb for a poll `wait`, same as always).
- **Secrets logging (index.ts)**: every tick logs which source each secret resolved from
  (`vault` / `env` / `missing`), never the value; a `misconfigured` 500 names which of the
  two was missing. No isolate-lifetime cache — a rotated Vault secret or edge secret takes
  effect on the very next tick, not the next redeploy. Vault/env values are `.trim()`'d.
- **Verify without spending**: `tools/glb-pipeline/scan_worker_dryrun.sh` (deno tests +
  a local Tripo stub + read-only probes of the real buckets).

**Launch sizing v3 part 2 (2026-09-02, Tripo rate limits + server-issued scan slots):**

- **Tripo rate limiting is handled, not just documented.** The multiview-to-model
  endpoint shares a pool of **10 concurrent tasks per account**; over it, task creation
  returns code 2000 ("exceeded the limit of generation") or 1007, with a Retry-After
  header, and creates/charges nothing. `paidSubmit` treats this exactly like a definite
  rejection (rolls the intent + credits back) but **waits the server-told Retry-After**
  (default 30 s if the header is absent) instead of the generic 5-strike retry policy —
  no `attempts++`, no throw, one breadcrumb per occurrence (`wait:tripo-rate`).
- **A worker-side pool guard (`MAX_ACTIVE_TRIPO`, 8) runs before every generate buy**,
  ahead of the Tripo `balance()` call — a DB-only count of jobs in `generating` /
  `converting_map` / `converting_hero` (converts occupy a Tripo task slot too, which is
  why the cap is 8, not the documented 10 — headroom for a task Tripo still considers
  live that a lagging poll hasn't reflected here yet). Pool-full waits one poll interval
  (`wait:tripo-pool`), not the 5 min guard wait. This is a courtesy that keeps the
  2000/1007 rejection rare; `paidSubmit`'s handling above is what actually survives it.
- **Server-issued scan slots replace the manifest handle as identity.** The backend
  mints the scan id and writes `public.scan_slots` (user_id, handle/tier snapshots,
  service-role only) after checking the account's slot count — the account is the thing
  the client cannot forge, unlike a manifest-supplied handle. `stepQueued` looks the
  slot up by scan_id: a live (unreleased) slot supplies `handle`/`user_id` for the job
  and is marked consumed in the same commit that moves `queued -> fetching`
  (breadcrumb `slot=1 user=<id>`); a **released** slot is refused outright
  (`skipped slot-released`) — no reclaiming a render an operator already refunded. The
  per-user cap (`countUserRenders`) keys on `user_id` when the job has one, falling back
  to `handle` only for legacy slot-less jobs — a courtesy cap, same as before.
- **`pipeline_flags.require_slot` is the transition switch** (migration
  `20260902002000_scan_slots.sql`, default **false**). While off, a slot-less folder
  still renders on the manifest-handle path (breadcrumb `slot=0 legacy=1`) — testers on
  JS that predates the slot request keep working. Once on, a slot-less scan_id is
  refused (`skipped slot-required`, never spends) by both `register-scan` and here.
  **Flip it AFTER the OTA carrying the slot request (`POST /api/scan/slot`) is out**,
  not before — flipping early strands anyone still on the old JS with a folder the
  worker will only ever skip.
- **A FAILED render gives its slot back; a SKIPPED one never does.** Any terminal
  `failed` — through `Tick.fail()` or the 5-strike generic-error path, both check the
  same `job.user_id` (set only when a slot was consumed) — calls `releaseSlot` and drops
  a `slot released reason=<why>` breadcrumb, so a bad render never burns one of the
  account's two included scans (Jeff's product rule). `skip()` (junk id, a manifest the
  app itself reported incomplete, `manual-in-progress`, `slot-required`,
  `slot-released`) never releases a slot — none of those are the worker's own render
  failing, and in practice they can only fire before a slot is ever consumed anyway.

## By hand — when the worker is down

The worker executes exactly these commands' REST equivalents. Run them yourself only
when the pipeline is disabled or a job is `failed`; a hand-published twin makes the
worker step aside for that scan.

```bash
# 0. PHOTOS — through the ONE door out (300 s signed URLs)
curl -s -X POST "https://pgtbjiszjglznjagolse.supabase.co/functions/v1/fetch-scan?scan=<scanId>" \
  -H "Authorization: Bearer <anon>" -H "apikey: <anon>" -H "x-publish-key: $(cat ~/.hairpin/publish-model.key)"

# 1. GENERATE — name the files by VIEW; the CLI assigns views from filename hints
#    (front/back/left/right). Our bucket names 03-rear.jpg — "rear" is NOT a hint, so
#    rename it to back.jpg (or pass front, left, back, right positionally). See trap 1.
tripo generate multiview-to-model front.jpg left.jpg back.jpg right.jpg --json --yes

# 2. MAP TWIN — must satisfy the Mapbox gates below
tripo model convert @<task> --format GLTF --face-limit 20000 --texture-size 1024 \
  --export-orientation -x --scale-factor 1.9101 --pivot-to-center-bottom --json --yes

# 3. HERO — WebView-rendered, so the Mapbox gates do not apply
tripo model convert @<task> --format GLTF --face-limit 150000 --texture-size 2048 \
  --export-orientation -x --scale-factor 1.9101 --pivot-to-center-bottom --json --yes

# 4. MATERIAL PASS — on BOTH files (the worker does the same)
python3 tools/glb-pipeline/scan_finish.py map/model.glb scan_<scanId>_map.glb
python3 tools/glb-pipeline/scan_finish.py hero/model.glb scan_<scanId>.glb

# 5. QC, then PUBLISH twin FIRST, hero LAST — through the ONE door in
python3 tools/glb-pipeline/glbinfo.py scan_<scanId>_map.glb scan_<scanId>.glb
tools/glb-pipeline/publish_model.sh scan_<scanId>_map.glb
tools/glb-pipeline/publish_model.sh scan_<scanId>.glb
```

Auth: `tripo login --region ov` (device flow, headless-safe) or `TRIPO_API_KEY=tsk_…`.

## ⚠ The four traps — each one verified the expensive way

1. **Views are NAMED, never positional.** Tripo's endpoint takes `front / left / back /
   right`. The app writes `01-front, 02-right, 03-rear, 04-left` and lists
   `shots: ["front","right","rear","left"]` in `manifest.json` (there is **no `slot`
   field** — an earlier version of this doc said there was). Feeding the files in
   filename order builds the car **mirrored, with no error**. The worker maps by shot id
   (`rear → back`) — `supabase/functions/scan-worker/manifest.ts`. The CLI's positional
   order is front, left, back, right and it only recognises the filename hints
   front/back/left/right — "rear" is not one. Mirroring is only provable by rendering the
   front and reading the licence plate.
2. **Tripo's nose is 180° off our fleet convention.** `--export-orientation -x` fixes
   it. Verified by comparing end-view renders against the shipped `GRC2_map1.glb`.
3. **A high face limit silently produces u32 indices** (150k faces → 85–90k verts in
   one primitive → u32), and **u32 is invisible on Mapbox** — no error, no car. The
   map twin must stay ≤20,000 faces, which lands ~14–16k verts and u16.
4. **Never `--quad`** — it silently forces FBX output; quads cannot exist in glTF. The
   worker's Tripo client refuses the parameter outright.

## Fleet convention (the target every model must hit)

Read off the shipped fleet twin, and enforced by the convert flags above:

| property | value |
|---|---|
| length | **1.9101** along X |
| up axis | Y, resting on **Y = 0** (grounded) |
| centred | X and Z |
| indices | **u16** (map twin) |

## QC gates — enforced by the worker before every publish

Map twin: **u16 indices · < 25,000 verts · < 65,536 verts/mesh · ≤ 30 MB · length
1.9101 ± 0.05 · minY ± 0.005 · centre X/Z < 0.01 · a metallicRoughness texture present**.
Hero: ≤ 30 MB + parseable, nothing more (the WebView tolerates u32 and any vertex count);
the worker only WARNS in the breadcrumb (`warn=`) if its length / minY / centre drift, so a
hero can never fail after the twin from the same generate is already live. Code:
`supabase/functions/scan-worker/glb.ts`; Python twin for humans:
`tools/glb-pipeline/glbinfo.py`. Then **look at it** — render front + top; a metric once
passed a visually destroyed model. The front render is also the mirror check (trap 1).

Measured on the delivered scans (the last four are the AUTOMATED recipe, worker-published):

| file | faces | verts | idx | bytes (raw → finished) |
|---|---|---|---|---|
| enablewhore twin (the recipe) | 20,000 | 14,201 | u16 | 1,146,948 → 1,061,704 (worker) / 1,419,852 (scan_finish.py) |
| enablewhore hero | 150,000 | 85,856 | u32 | 6,244,500 → 5,926,480 |
| jeff twin (**40k evaluation build**, not the recipe) | 40,000 | 28,367 | u16 | 2,113,332 — **fails the <25,000-vert gate** |
| **olaf twin — first AUTOMATED render** | 20,000 | 15,096 | u16 | 1,135,212 (length 1.9097, minY 0, centred) |
| **olaf hero — first AUTOMATED render** | 150,000 | 88,192 | u32 | 6,143,712 (length 1.9101) |
| **qa twin — v3 slot path** | 20,000 | 15,546 | u16 | 1,203,652 (length 1.9103) |
| **qa hero — v3 slot path** | 150,000 | 89,493 | u32 | 6,409,644 (length 1.9101) |

The published jeff twin is the 40k-face evaluation build from "Open quality work"; the
automated recipe is 20k. If 40k wins, the gate becomes <35,000 verts (still u16) and this
table changes with it — Jeff's call.

## Material pass — on BOTH files

Tripo ships one material whose metallicRoughness texture is taken raw (factors default
to 1.0), and body panels read as chrome under Mapbox lighting. The fix is a remap of
the texture itself: `roughness' = 0.35 + 0.65·roughness`, `metallic' = 0.85·metallic`
(`tools/glb-pipeline/scan_finish.py`, ported 1:1 to `glb.ts` — pixel-for-pixel parity is
a test). Both delivered scans had it on the twin **and** the hero. The worker's port also
rebuilds the BIN chunk, so the original MR bytes are dropped instead of left orphaned
(scan_finish.py leaves +24 % on the twin / +13 % on the hero — measured).

## Publish order — twin FIRST, hero LAST

`checkScanReady` (`src/carScan.ts`) treats the **hero** as the completion signal and
reads the twin in the same pass; the app writes both URLs once and flips to `ready`.
Publishing the hero first with the twin missing permanently strands the map marker on
the fleet car. Publishes never overwrite (409 forever per name) — a re-render is a
**new scanId**, never a rewrite.

## How it reaches the driver (wired 2026-08-29)

- **Garage** polls on every focus + a 20 s interval while a scan is building — the
  clock-countdown page (`src/ScanHero.tsx`, 6-minute promise). No force-quit, ever.
- The `ready` flip is one settings write; `map.tsx`, `carStore.ts` (CarPlay/AA) and the
  Garage all subscribe, so the car lands on **every surface in the same instant**.
- Model id on the map is **`scan_<scanId>`** — per-attempt unique, so Mapbox's
  cache-by-id can never pin a stale car and rescans swap live.
- **A scan has no `_lit` night twin.** The lit branch is bypassed for scanned cars on
  every surface; night legibility comes from `CAR_EMISSIVE_BY_MODE` like any model.
  (Requesting a `_lit` URL that doesn't exist renders an *invisible* car.)
- **Failed renders are invisible to the tester today** — `carScanStatus:'failed'` exists
  in settings.ts but nothing sets it. Open item in SCAN-WORKER-DEPLOY.md.

## Storage security — do not weaken these

- `car-scans` is **write-only to the world**: its single RLS policy is INSERT for anon.
  Reads happen ONLY through the `fetch-scan` edge function (humans) or the worker's
  service role (server-side). Never add an anon SELECT policy — the app's key ships to
  every device, and these are photos of people's cars at their homes.
- `models` is public-read; its writers are `publish-model` (humans) and the worker
  (service role, `upsert:false`). `car_scan_jobs` / `pipeline_flags` have RLS with no
  anon policies; the worker's RPCs are SECURITY DEFINER with EXECUTE revoked from anon.
- ⚠ A hero texture CAN carry a legible plate (seen on the jeff hero, 2026-09-01) and
  the bucket is public. Automation publishes every tester's with nobody looking — open
  decision for Jeff, listed in the runbook.

## Open quality work

- **Panel bumpiness** — decimation artefacts at 20k faces; the 40k-face twin (28,367
  verts, still u16) is under evaluation (see the table above).
- ~~**6-minute promise** — re-measure after the first automated scans.~~ **MEASURED, twice:**
  **7 m 47 s** (`enablewhore-20260901-210315`, v2 — 30 s cron, one job per tick) and
  **5 m 46 s** (`qa-20260902-081500`, v3 — 15 s cron, POLL_S 20). Both 50 credits, 0 retries,
  0 errors. The promise holds with headroom; what remains is Tripo's own generate (~3.5 min)
  plus two converts, which no amount of tick tuning can compress.

## History

The authored-fleet toolkit under `tools/glb-pipeline/` predates this pipeline and is
for fleet authoring only (paint variants, sprites). `HANDOFF-3D.md` is the historical
log of that era — none of it is on the scan path. `scan_finish.py`, `glbinfo.py`,
`tripo_stub.py` and `scan_worker_dryrun.sh` are the scan-path tools.
