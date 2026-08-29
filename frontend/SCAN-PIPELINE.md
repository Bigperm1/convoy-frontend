# THE SCAN PIPELINE — photos → your car, everywhere

**This is the pipeline.** Four photos from the app become the Garage hero and the 3D map
marker through the **Tripo CLI and nothing else** — no Blender, no manual mesh work, no
bench step. Every number in here was measured on the first real scan
(`jeff-20260829-141551`, 2026-08-29), not read off documentation.

Status: **manual-run today, automation next.** The recipe below is what the worker will
execute verbatim.

---

## The chain

```
app capture (4 shots)                       app/(app)/garage-capture.tsx
  └─ car-scans/<scanId>/01-front.jpg … 04-left.jpg + manifest.json   (bucket: WRITE-ONLY)
       └─ fetch-scan edge fn  → 300 s signed URLs                    (the ONE door out)
            └─ tripo generate multiview-to-model                     30 credits
                 └─ tripo model convert  ×2  (map twin + hero)       10 + 10 credits
                      └─ publish-model edge fn                       (the ONE door in)
                           ├─ models/scan_<scanId>_map.glb   ← publish FIRST
                           └─ models/scan_<scanId>.glb       ← publish LAST
                                └─ app polls (HEAD) → Garage hero + map marker on
                                   phone / CarPlay / Android Auto — live, no restart
```

**Cost per finished car: 50 credits = $0.50.** 1 credit = $0.01, pay-as-you-go.
Failed Tripo tasks auto-refund (exit code 6).

## The commands

```bash
# 1. GENERATE — the view order is Tripo's, NOT filename order (see trap 1)
tripo generate multiview-to-model front.jpg rear.jpg left.jpg right.jpg --json --yes

# 2. MAP TWIN — must satisfy the Mapbox gates below
tripo model convert @<task> --format GLTF --face-limit 20000 --texture-size 1024 \
  --export-orientation -x --scale-factor 1.9101 --pivot-to-center-bottom --json --yes

# 3. HERO — WebView-rendered, so the Mapbox gates do not apply
tripo model convert @<task> --format GLTF --face-limit 150000 --texture-size 2048 \
  --export-orientation -x --scale-factor 1.9101 --pivot-to-center-bottom --json --yes
```

Auth: `tripo login --region ov` (device flow, headless-safe) or `TRIPO_API_KEY=tsk_…`.

## ⚠ The four traps — each one verified the expensive way

1. **View order is `front back left right`.** Our bucket files are numbered
   `01-front, 02-right, 03-rear, 04-left` — feeding them in filename order builds the
   car **mirrored, with no error**. Map by the manifest's `slot` field
   (`Front/Right/Back/Left`, from `SCAN_SHOTS` in `src/carScan.ts`), never by filename.
   Mirroring is only provable by rendering the front and reading the licence plate.
2. **Tripo's nose is 180° off our fleet convention.** `--export-orientation -x` fixes
   it. Verified by comparing end-view renders against the shipped `GRC2_map1.glb`.
3. **A high face limit silently produces u32 indices** (150k faces → 90,427 verts in
   one primitive → u32), and **u32 is invisible on Mapbox** — no error, no car. The
   map twin must stay ≤20,000 faces, which lands ~16k verts and u16.
4. **Never `--quad`** — it silently forces FBX output; quads cannot exist in glTF.

## Fleet convention (the target every model must hit)

Read off the shipped fleet twin, and enforced by the convert flags above:

| property | value |
|---|---|
| length | **1.9101** along X |
| up axis | Y, resting on **Y = 0** (grounded) |
| centred | X and Z |
| indices | **u16** (map twin) |

## QC gates — run before every publish

Map twin: **u16 indices · < 25,000 verts · < 65,536 verts/mesh · ≤ 30 MB · length
1.9101 ± 0.05 · minY ≈ 0 · centred**. Hero: ≤ 30 MB only (WebView tolerates the rest).
Then **look at it** — render front + top; a metric once passed a visually destroyed
model. The front render is also the mirror check (trap 1).

Measured result vs the authored fleet twin: **1.27 MB / 15,923 verts** against
2.31 MB / 48,760 — smaller, lighter, and cleaner panels.

## Publish order — twin FIRST, hero LAST

`checkScanReady` (`src/carScan.ts`) treats the **hero** as the completion signal and
reads the twin in the same pass; the app writes both URLs once and flips to `ready`.
Publishing the hero first with the twin missing permanently strands the map marker on
the fleet car. `publish-model` never overwrites (409 forever per name) — a re-render is
a **new scanId**, never a rewrite.

## How it reaches the driver (wired 2026-08-29)

- **Garage** polls on every focus + a 20 s interval while a scan is building — the
  clock-countdown page (`src/ScanHero.tsx`). No force-quit, ever.
- The `ready` flip is one settings write; `map.tsx`, `carStore.ts` (CarPlay/AA) and the
  Garage all subscribe, so the car lands on **every surface in the same instant**.
- Model id on the map is **`scan_<scanId>`** — per-attempt unique, so Mapbox's
  cache-by-id can never pin a stale car and rescans swap live.
- **A scan has no `_lit` night twin.** The lit branch is bypassed for scanned cars on
  every surface; night legibility comes from `CAR_EMISSIVE_BY_MODE` like any model.
  (Requesting a `_lit` URL that doesn't exist renders an *invisible* car.)

## Storage security — do not weaken these

- `car-scans` is **write-only to the world**: its single RLS policy is INSERT for anon.
  Reads happen ONLY through the `fetch-scan` edge function (service role server-side,
  gated by the same `x-publish-key` secret as `publish-model`, 300 s signed URLs).
  Never add an anon SELECT policy — the app's key ships to every device, and these are
  photos of people's cars at their homes.
- `models` is public-read; its only writer is the `publish-model` edge function.

## Open quality work

- **Panel bumpiness** — decimation artefacts at 20k faces; a 40k-face twin
  (~32k verts, still u16) is under evaluation.
- **Reflection too strong** — the Tripo material ships a metallicRoughness texture
  with default factors (1.0). Fix is a pure-Python MR channel remap
  (`tools/glb-pipeline/scan_finish.py`), part of this pipeline, not a bench step.

## History

The authored-fleet toolkit under `tools/glb-pipeline/` predates this pipeline and is
for fleet authoring only (paint variants, sprites). `HANDOFF-3D.md` is the historical
log of that era — none of it is on the scan path.
