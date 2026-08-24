<!-- ═════════ RULE #1 — READ THIS BEFORE ANYTHING ELSE ═════════ -->
# 🛑 NO GUESSING. NO THEORIZING. NO HALLUCINATING.

**Every claim is VERIFIED, or the word HYPOTHESIS is said out loud. No exceptions.**

- **VERIFIED** = I ran the query · read the file · measured it · asked Jeff — and I can show the receipt.
- Reading code and reasoning about it is **NOT** verification. Neither is *"it would explain the symptom."*
- **Never** state a root cause, a fix, or a conclusion I have not tested. Not even a likely-sounding one.
- **Check the instrumentation that ALREADY EXISTS** before inventing an explanation. It usually answers it.
- Separate cleanly: *what the data shows* vs *what I don't know*. Put the unknowns in writing.
- **"I don't know — here is the ONE check that would settle it"** is a GOOD answer.
  A confident wrong answer costs a day and burns trust.

> Jeff, 2026-08-21, in caps: **"ABSOLUTLEY STOP GUESSING, NO THEORYIZING, NO HALLUCENATIONS."**
> Trigger: I declared `ADVANCE_THRESHOLD_M = 25` the root cause of a stuck step index — from a code read alone,
> presented as a finding. The `turn=` breadcrumb, **already in the logs**, refuted it in a single query.
> The instrumentation existed. I guessed instead of reading it. Then I did it again with the timezone.
<!-- ═════════ END RULE #1 ═════════ -->

# 3D car capture — photo → GLB pipeline

**Scope:** turning Jeff's own photos of his GR Corolla widebody into a game-ready GLB for the
Garage 3D viewer and (eventually) the car map marker. Written 2026-08-22 after the 8-photo
session. Everything below was measured; where it wasn't, it says so.

**Where the files live:** `~/Documents/hairpin-3d/` (NOT in git — 615 MB).
Scratchpad copies are gone. This directory is the only surviving copy.

```
~/Documents/hairpin-3d/
  models/    TRIPO10g.glb          ← THE DELIVERABLE (look-approval build)
             TRIPO10c.glb          ← same, without the point-7 smoothing pass
             tripo_RAW_untouched.glb  ← Tripo's original download, never modified
             tripo_cut_noplate.glb    ← raw + plate slab removed, original texture
             tripo10_albedo_8k.png    ← the finished 8192² albedo
  photos/    IMG_6909…6916.JPG     ← the 8 golden-hour source photos
  renders/   BEFORE_AFTER.jpg  MASKVIS.jpg  SMOOTHCMP.jpg  SLABCHECK.jpg  FLAT10g.jpg  …
  scripts/   masks.py apply10b.py cutslab.py swaptex.py smooth7.py qc4.py flat.py
  work/      the exact directory layout the scripts expect (mv/, tri/, final/)
```

Scripts read their base dir from `$HP3D_WORK`, defaulting to `~/Documents/hairpin-3d/work`.
They need **Pillow 12.3.0 + numpy 2.5.2** and **Blender** at
`/Applications/Blender.app/Contents/MacOS/Blender`. The venv they were built with lived in the
session scratchpad and is **gone** — recreate with `python3 -m venv` + `pip install pillow numpy`.

---

## Current state — what is done and what is not

**DONE (verified by render + measurement):** Jeff's 10-point spec is fully applied to the Tripo
base. See the table under "The 10 points" for the per-point measured before → after.

## ✅ PICK #1 CHOSEN — TRIPO — 2026-08-23

**Jeff's words: "this current widebody is by far the best… this is the #1 pick so far."**

**The vendor is TRIPO and the question is CLOSED** — Jeff, 2026-08-23:
*"we are working with Tripo now."* Do not benchmark other modelers, re-open a
comparison, or suggest an alternative unless he asks for one.

The approved asset and its irreplaceable source generation are saved outside git at
**`~/Documents/hairpin-3d/PICKS/`** — see `PICKS/MANIFEST.md` for the full recipe,
every measured number, and the traps. Verify against `PICKS/CHECKSUMS.txt`.

| | the pick |
|---|---|
| file | `PICK1_grc_widebody_tripo_2026-08-23.glb` |
| size | 6,784,496 B = **6.47 MB** (fleet budget 4.8–6.5 MB) |
| triangles | 190,000 · **uint16** · 4 chunks, largest 38,556 verts |
| textures | 2048² base colour + normal + remapped roughness |
| generation | Tripo v3.1 Best Quality, multi-view 4 views, Ultra Mesh, 4K texture, PBR, 55 credits |

**Still NOT done:** not uploaded to the Supabase `models` bucket and not referenced in
`vehicleAssets.ts`. Mapbox caches by URL, so any rebake needs a NEW filename.

### The three findings that produced the pick

**1. The albedo comes back ~2× too bright.** The car's real paint measures
RGB **86,87,87** (value 0.345) across all eight photos; the generation returned 0.67–0.72.
That is golden-hour sun baked into the texture. A hue-preserving value curve anchored on
the measurement pulls it back (now 0.373).

**2. Tripo's metallic-roughness map is a mirror — remap it, don't delete it.**
Measured roughness p50 **0.039**, where car paint should sit near 0.23. Deleting the map
kills the chrome but also every bit of material variation, leaving flat clay. Stretching it
into 0.14–0.62 (p50 → 0.257) with metallic forced to 0 restores real paint/plastic/glass
separation. This is what closed most of the remaining visual gap.

**3. The body-panel warping was OUR decimation, not Tripo.** Adjacent-face angle p50:
raw 1.97M = **2.30°**, our 190k collapse = **8.58°**, an authored fleet car at 149,968 tris
= **3.88°**. Fixed with `WEIGHTED_NORMAL` — recomputes vertex normals only.

> 🛑 **A metric passed a destroyed model.** `CORRECTIVE_SMOOTH` measured 8.58° → **3.36°**,
> *better than the authored fleet*, while visibly shredding the mesh into inverted faces and
> scrambled UVs. The number would have shipped it; the render caught it.
> **Never move vertices to fix decimation waviness, and never trust a smoothing metric
> without a rear + raking-light panel render.** Any smoothing must also run BEFORE the
> uint16 split — smoothing across chunk seams tears them.

### ⛔ The vendor comparison that used to live here has been REMOVED

It held head-to-head results for competing modelers and a protocol for re-running the
comparison. **Jeff closed that on 2026-08-23** — *"we are working with Tripo now"* — and asked
for the alternatives to be taken out so they cannot resurface as a suggestion. They are gone
deliberately. Do not rebuild the table, do not benchmark alternatives, do not name other
modelers.

What carried forward from it, because it is about **Tripo** and still binding:

- **Tripo Multi-view takes exactly 4 views, and wants them ORTHOGONAL** — front / left /
  right / back, straight-on. Three-quarter views pushed into those slots reconstruct worse.
  Its Multi-view entry is the **2nd** toolbar icon; the 3rd is batch mode, which makes four
  separate single-image models and costs 4×.
- **A UI slot existing is not a run completing.** I once told Jeff, from a screenshot rather
  than a test, that 8 photos were accepted. Test the real limit before quoting it.
- **Build for the input shape the shipping pipeline consumes.** Repeated on 2026-08-23 by
  padding the in-app capture to 8 stations for a hypothetical future vendor; Jeff caught it and
  it is back to 4. Add more only when something shipping actually reads them.
- **Tripo emits uint32** — an extra conversion step every time, and Mapbox drops uint32
  silently (see the split-for-uint16 stage in `shipify.py`).
- **It hallucinated the licence plate as protruding GEOMETRY**, not texture. Masking failed 4×;
  the fix was cutting the triangles.

**Spend:** Tripo Professional $19.90 was already Jeff's; PICK 1 cost 55 credits, the ALT V3
retopology run another 55. Ask his credit budget before spending on further generations.

---

## What shipping still takes (vendor and look are both approved — this is the remaining work)

`TRIPO10g.glb` is a **look-approval build, not a shippable asset.**

| | TRIPO10g | what ships today (`out_jeff_widebody3.glb`) |
|---|---|---|
| triangles | 1,886,793 | — (the shipped widebody bake) |
| albedo | 8192² PNG | 2K |
| file size | **90,219,512 B = 86.0 MB** | **6,814,544 B = 6.5 MB** (verified by live HEAD request) |
| indices | **uint32 (5125)** | uint16 |

Peers for scale, same bucket: `out_heavy_metal.glb` **4.8 MB**, `out_gravel3.glb` **4.8 MB**.
**Budget: ~5–7 MB.** TRIPO10g is **13.2×** over.

Two hard blockers:

1. **uint32 indices are silently dropped by Mapbox's renderer.** A uint32 GLB on the car map
   renders as *nothing* — no error, no warning. Must be converted to uint16 (5123), which means
   splitting into ≤65,535-vertex primitives (`tools/glb-pipeline/split_u16.py` exists for this).
2. **86 MB is far too heavy** for either the garage viewer or an OTA. Target ~200k tris and a
   2–4K texture.

**Quality can regress in that decimation step.** Get Jeff's yes on the look *first*, then decimate,
then re-run the QC render and compare against `renders/BEFORE_AFTER.jpg`.

**Hosting is already solved — use the existing pipeline.** Every vehicle model is served from the
Supabase public bucket:

```
https://pgtbjiszjglznjagolse.supabase.co/storage/v1/object/public/models/out_<key>.glb
```

`src/vehicleAssets.ts` holds 42 such URLs; `src/classModels.ts:99` holds one more
(`out_class_muscle2.glb`). A `_lit` (headlights-on) variant is **derived at runtime** by
`getVehicleModelUrl()` string-replacing `.glb` → `_lit.glb` — so if you upload a model that needs a
lit state, upload **both files** or the lit lookup 404s.

⚠️ **Never bundle a GLB over OTA via a `file:/` URI** — Mapbox's Cronet loader rejects them and you
get a **black map on Android**. `metro.config.js` does register `glb` as an asset extension, but
**nothing in `src/` require()s a .glb** — every vehicle model is https-hosted precisely because of
this constraint. Keep it that way.

⚠️ **Mapbox caches models by URL.** A rebake must get a **new filename** (`out_x2.glb`,
`out_x3.glb` …) or devices keep serving the old mesh. This is why the shipped names carry numeric
revision suffixes.

---

## The 10 points (Jeff's spec, 2026-08-21) — measured results

Applied to the Tripo base. RGB values are the mean of the affected texels in the 8K albedo.

| # | Instruction | Measured |
|---|---|---|
| 1 | anything black → black, always | `[58,59,62]` → **`[19,21,22]`** (40.5% of covered atlas) |
| 2 | never tint headlights / taillights / wheels / tyres | **21.9% wheels + 0.67% lamps left as generated.** Only baked white glare above v>0.72 pulled down, hue preserved — that removes a highlight, it is not a tint |
| 3 | plate black, covering only the white part | front slab **cut from the mesh** (43,171 tris); rear plate → `[9,9,9]`, **0.17%** of atlas |
| 4 | windows / windshield near-black | `[108,112,117]` → **`[21,23,25]`** |
| 5 | roof a light shade of black | `[116,126,138]` → **`[35,37,39]`** |
| 6 | anything red stays red | kept + deepened `[146,68,72]` → `[146,55,57]` |
| 7 | imperfections out, keep the lines/edges | proxy-normal pass, **geometry never moved** (see below) |
| 8 | high 4K detail | **8192² albedo**, PNG, uncompressed |
| 9 | detailed rims / brakes / tyre rubber | untouched |
| 10 | very detailed front and back | untouched — 1.89M tris |

**Final verification (flat-albedo render, lighting removed entirely):**
near-white = **0.04–0.11%** of car pixels, value p50 **0.35–0.40**, p95 **0.53**.
The texture is uniform Heavy Metal with no blowouts left.

Any bright streaks still visible in model-viewer are **the environment reflecting off panel
creases** — lighting, not the model. Real paint does this. To soften: `roughnessFactor` 0.52 → 0.62.

---

## The architecture that finally worked

This took several wrong turns. The shape that works:

> **Geometry masks come from vertices. Colour masks come from texels. Never mix them.**

Classifying paint-vs-black *per vertex* and splatting the result into UV space produces a
**camouflage speckle** — neighbouring texels land in different classes and half the panel keeps its
original blown-white colour. This is what "the whole car looks like snakeskin" was.

The working pipeline (`scripts/masks.py` → `apply10b.py` → `cutslab.py` → `swaptex.py` → `smooth7.py`):

1. **Sample the albedo per vertex** (`vcol.npy`) so 3D position and colour can be reasoned about together.
2. **Splat smooth attribute maps** — vertex height `h` and normal-Y — into a 4K buffer, dilate,
   upsample to 8K. These are *continuous*, so they stay spatially coherent.
3. **Splat boolean geometry masks only**: wheels, front lamp units, plate box, plate slab.
4. **Do every colour decision in texture space**, using the per-texel albedo plus the smooth
   height/normal maps. No speckle is possible because the texture's own structure drives it.
5. **Cut geometry** where the scan hallucinated it (the plate slab).
6. **Smooth normals only** — never move a vertex.

### Model axes (Tripo output, verified)

```
Y = up      0     → 0.346     h = Y/0.346
Z = length -0.491 → +0.491    +Z = FRONT (low hood), −Z = REAR (tall hatch)
X = width  -0.231 → +0.231
```

Height bands separate the car cleanly:

| band | contents | albedo v p50 |
|---|---|---|
| h < 0.38 | black plastic — bumpers, skirts, valance | 0.27 |
| h 0.38 – 0.68 | silver body panels | 0.71 – 0.76 |
| h 0.63 – 0.90, ny < 0.55 | greenhouse / glass | 0.40 |
| h > 0.795, ny > 0.58 | roof | — |

Wheels are found by **vertex-density spikes**, not colour: front axle **z = +0.300**, rear
**z = −0.310**, hub height **y = 0.078**. Mask = `|x| ∈ (0.115, 0.215)` and within radius **0.076**
of the hub centre.

> Radius 0.086 is **too big** — it swallows the wheel-arch lips, which then keep their baked white
> glare and read as bright rings around the wheels. 0.076 is the measured value.

### Always visualise a mask before applying it

`masks.py` writes `maskvis.png` — each mask flat-coloured onto the atlas — which is then rendered
on the model (`renders/MASKVIS.jpg`). **This caught every mask bug in one look**, including the
rear-bumper corners being wrongly protected as "lights". Earlier in the same session a rim mask
that grabbed 29.3% of the texture turned all the blacks blue and made the wheels cartoon-blue,
because nobody looked at it first. Do not skip this step.

---

## Root causes found (each one cost real time)

**1. The white/chrome blotches were never in the albedo.**
Tripo's metallic-roughness map measures **roughness p50 = 0.01, 88.4% of the car below 0.25** —
that is a mirror. Two full rounds of albedo editing changed nothing because the albedo was never
the problem. **Fix: drop `metallicRoughnessTexture` entirely**, set `metallicFactor: 0`,
`roughnessFactor: ~0.52`. Keep the normal map.

> `roughnessFactor` **multiplies** the map, it does not replace it. Setting it to 0.55 against a
> 0.01 median still leaves a mirror. The texture reference has to go.

**2. The license plate was geometry, not texture.**
Tripo modelled the front plate as a **slab protruding off the bumper**. It is present in the
untouched raw download. Painting it black four separate times only ever made the wrong-shaped
thing more obvious. **Fix: cut the triangles** — `z > 0.478 & |x| < 0.105 & h ∈ (0.07, 0.36)`,
remove any triangle whose *three* vertices are all inside (43,171 tris, 2.24%). Verified first by
rendering the candidate set in magenta (`renders/SLABCHECK.jpg`) before cutting anything.

**3. Over-smoothing destroys the detail Jeff asked to keep.**
Proxy-normal smoothing at **factor 0.85 × 28 iterations mangles** the front bumper, tail lights and
diffuser — the relaxed proxy no longer matches high-curvature detail. **factor 0.42 × 6 iterations**
is the measured sweet spot: hood and roofline visibly cleaner, lamp and bumper lines intact.
Three-way comparison in `renders/SMOOTHCMP.jpg`. Runs in 8 s on 1.9M tris.

**4. Golden-hour sun is baked into the albedo.**
The paint region's value median is **0.86** — near-white. "Make it Heavy Metal" is not a recolour,
it is *undoing the sun*. Remap by percentile rank so spatial ordering survives:
`HM_normalised × (0.34 + 0.22·t)` where `t` = the texel's brightness rank within the paint mask.
Result `[203,208,209]` → `[108,115,119]`.

**5. Blender's Base Color link, not `bpy.data.images[1]`.**
An early flat-albedo test grabbed the *normal map* by index and rendered a flat lavender car, which
would have "proved" the texture was fine when nothing had been tested. Always walk the node tree
from the Principled BSDF's Base Color input.

---

## Dead ends — do not repeat these

**Tripo v3.1 Multi-view takes 4 views. Verified by testing, 2026-08-21.**

I told Jeff 8 photos were accepted, from a UI screenshot rather than a test run — exactly the
Rule #1 failure. **Test the real limit before telling Jeff what it can do**, and remember that a
UI slot existing is not a run completing. Repeated in a different shape on 2026-08-23, when I
padded the in-app capture to 8 stations for a hypothetical: **build for the input shape the
shipping pipeline actually consumes.**

**Also worth knowing:**

- The $19.90 receipt (#2147-7158) is a *Tripo AI Professional Plan*.
- **The plate must be masked black in the source photos before any third-party upload.**
  Masks must be pure `(0,0,0)` and plate-tight. Detecting a plate *after* generation, in the UV
  atlas, failed four times — it catches window glass or nothing. Fix it at the source.
  Do NOT mask at capture time: a blacked-out plate also destroys the rear-panel geometry the
  reconstruction needs.

---

## Where the model is used in the app

- `src/CarViewer3D.tsx` — react-native-webview + **model-viewer 3.5.0** (from ajax.googleapis.com),
  rendered at `baseUrl https://localhost`.
  **Measured orbits:** `325deg` = nose-left driver side (this is the hero angle),
  `215deg` = front-right, `35deg`/`145deg` = rear quarters.
  Live settings: `camera-orbit "325deg 76deg 100%"`, orbit clamps `auto 55deg auto` →
  `auto 92deg auto`, FOV clamped 18°–42°, **exposure 1.05**, **shadow-intensity 0.9**,
  **shadow-softness 0.7**, auto-rotate 8°/s after a 1200 ms delay, background `#0B0C0E`.
  No `environment-image` / `skybox-image` is set — it uses model-viewer's default neutral IBL,
  which is why the app view is dimmer and flatter than the Blender QC rig.
- `app/(app)/garage.tsx` — the hero tap opens the viewer. The wrapper **must carry
  `style={{ flex: 1 }}`**; `heroBg` is `flex: 1`, and an unsized wrapper collapses the hero to
  0 px height (cost a whole debugging round on 2026-08-20).
- `src/vehicleAssets.ts:426` — `grc_widebody` points at **`out_jeff_widebody3.glb`** (full mesh +
  2K texture, Heavy Metal tint baked in) — the pre-Tripo asset still live on the map today.
  Its map-marker tint entry is `{ color: "#6B6E72", mix: 0.9 }` at line 352.
  It was moved to widebody4 and **reverted in `c5fa646`**: widebody4 does not render on the car map.
  **The cause was never established.** It is uint16 and structurally identical to widebody3, and it
  renders fine in Mapbox GL JS on desktop. This is still open.

> ⚠️ `draw-cmp` telemetry reports the position handed to the marker — **not whether the model
> actually rendered.** During the widebody4 incident it read healthy while Jeff's car was invisible
> mid-drive. Do not use it to conclude a marker is fine.

---

## QC gate before any model ships

1. Render 4 views with `scripts/qc4.py` and compare against `renders/BEFORE_AFTER.jpg`.
2. Render the **flat albedo** with `scripts/flat.py` (lighting removed) and measure near-white %.
   Anything above ~1% means blowouts are still in the texture, not the lighting.
3. Render the **mask visualisation** if any mask changed.
4. Load in model-viewer at the real hero orbit — the QC rig is deliberately over-lit and will
   always look brighter than the app.
5. **Pixel-sample the render, don't eyeball greys.** "Looks identical to heavy metal" was once
   literally true — a missing resolver alias meant gravel silently fell back to heavy_metal and
   was never rendered at all.
6. Confirm **uint16 indices** and file size before wiring it into `vehicleAssets.ts`.
7. After any map-affecting OTA, verify on the simulator — a black map is the failure mode.
