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

Jeff, 2026-09-01: *"this pipeline is not suppose to have any manual input, it is suppose
to be all automatic from the photos sent to the delivery of the 3d image and 2d twin back
to the device it was sent from."*

---

## The chain

```
app capture (4 shots)                       app/(app)/garage-capture.tsx · src/carScan.ts
  └─ car-scans/<scanId>/01-front.jpg 02-right.jpg 03-rear.jpg 04-left.jpg + manifest.json
     (bucket: WRITE-ONLY to the app; register-scan caps uploads at 2 per handle)
       └─ DB trigger car_scan_enqueue  (INSERT of …/manifest.json)  → car_scan_jobs row
            └─ pg_cron every 30 s → scan_worker_tick() → edge fn scan-worker  (ONE step per tick)
                 ├─ queued        folder complete? manifest sane? handle = manifest.handle
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

## Automation — how the worker behaves

- **Kill switch**: `public.pipeline_flags.enabled` (default false). `update … set
  enabled=false` stops all spend within 30 s. Read at the top of every tick and again
  right before the generate POST; unreadable == disabled.
- **Guards before the only paid POST**: per-handle cap (`per_user_cap`, 2 — same number
  as register-scan; keyed on the manifest's handle, i.e. client-supplied, so a courtesy
  cap), rolling-24 h cap (`daily_credit_cap`, 300 = 6 cars) and Tripo balance ≥
  `min_balance` + 50 — those two are the real ceiling. A guard failing waits 5 min; Tripo
  "insufficient credits" (code 2010) pauses the whole pipeline (`paused_reason='tripo-credits'`).
  Claims are serialised so only one job is ever in `fetching` with a live lease: the cap
  reads cannot race another job's generate.
- **Intent before spend**: each paid POST is preceded by one row update that records
  `paid_call` + `paid_call_started_at` and adds the credits to the ledger; the task id's
  update clears it. A tick that dies inside the POST (edge wall clock, abort, network)
  leaves the marker, and the next tick never re-POSTs: a generate fails
  `gen-submit-unknown` (recovered by hand from Tripo's dashboard — there is no task-list
  API), a convert gets one bounded retry. Only a definite Tripo rejection (its own error
  envelope, no task created) rolls the ledger back and retries normally.
- **Timeouts are poll counts** (60 polls of a generate, 30 of a convert), reset on every
  transition — a paused pipeline never expires a paid job.
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
- **Verify without spending**: `tools/glb-pipeline/scan_worker_dryrun.sh` (deno tests +
  a local Tripo stub + read-only probes of the real buckets).

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

Measured on the delivered scans:

| file | faces | verts | idx | bytes (raw → finished) |
|---|---|---|---|---|
| enablewhore twin (the recipe) | 20,000 | 14,201 | u16 | 1,146,948 → 1,061,704 (worker) / 1,419,852 (scan_finish.py) |
| enablewhore hero | 150,000 | 85,856 | u32 | 6,244,500 → 5,926,480 |
| jeff twin (**40k evaluation build**, not the recipe) | 40,000 | 28,367 | u16 | 2,113,332 — **fails the <25,000-vert gate** |

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
- **6-minute promise** — automated critical path ≈ manual 5.5 min + ~5 tick latencies;
  re-measure from `car_scan_jobs` timestamps after the first automated scans.

## History

The authored-fleet toolkit under `tools/glb-pipeline/` predates this pipeline and is
for fleet authoring only (paint variants, sprites). `HANDOFF-3D.md` is the historical
log of that era — none of it is on the scan path. `scan_finish.py`, `glbinfo.py`,
`tripo_stub.py` and `scan_worker_dryrun.sh` are the scan-path tools.
