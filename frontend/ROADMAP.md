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

# ROADMAP — where we are, what ships next

**Written 2026-08-22, shipped-state section refreshed 2026-08-27 (build 74).** Every number below was queried live from EAS / git / the Supabase bucket
at the time of writing, not recalled. Re-verify before acting — this file ages.

**Doc map — read in this order:**

| file | what it is | freshness |
|---|---|---|
| **`RULES.md`** | how to work — the standing rules | current |
| **`ROADMAP.md`** ← you are here | current state + what ships next | **2026-08-22** |
| `HANDOFF-3D.md` | photo → GLB pipeline, the 3D car work | **2026-08-22** |
| `HANDOFF-48H-2026-08-16.md` | the 08-14 → 08-16 window, heat + location regression | 08-16 |
| `HANDOFF.md` | the long chronological log | **STALE at build 70** — history only |
| `CLAUDE.md` | architecture + release rules | current |
| `CARPLAY.md` | the locked CarPlay / Android Auto spec | current |
| `DESIGN.md` | the locked tier visual language (Gold/Silver/H locks) | **2026-08-23** |
| `WHY-IT-HEATS.md` | thermal analysis | current |

> ⚠ `HANDOFF.md`'s own header claims *"Shipped state: build 70 · v3.6.0 · runtime 1.22.0"*.
> **That is three builds and three runtimes out of date.** Its last section is
> *"Build 71 — QUEUED, NOT CUT"*. Treat everything in it as historical reasoning, not as
> current state. Current state is this file.

---

## 1 · Shipped state — VERIFIED 2026-08-27

### 2026-09-02 — the scan pipeline is AUTOMATIC (Supabase `scan-worker`, commits `b4ff998` + `3272eaa`, PUSHED)

Jeff 9/01: *"not suppose to have any manual input… all automatic from the photos sent to the
delivery of the 3d image and 2d twin back to the device."* **VERIFIED live:** Olaf's second
scan (`enablewhore-20260901-210315`) rendered unattended — switch flipped 00:21:48, twin in
the bucket 00:27:21, hero 00:29:21, `done` — **7 min 47 s, 50 credits, 0 errors**. pg_cron
ticks every 30 s → edge fn advances ONE state per tick; spend guards (300 credits/day, 2
renders per handle, balance floor) and a 60-credit ceiling per job. Twin re-inspected with
`glbinfo.py`: 15,096 v / u16 / 1.9097 m — passes every Mapbox gate. The phone flips to
`ready` on its Garage-screen poll (every 20 s), so the tester's `carscan-ready` breadcrumb
lands when they next open the Garage. **Switch left ON.** Off switch:
`update public.pipeline_flags set enabled=false, paused_reason='manual', updated_at=now() where id=1;`
Docs: `SCAN-PIPELINE.md` (status + chain), `supabase/SCAN-WORKER-DEPLOY.md` (one-paste runbook).

**v3 — launch sizing, LIVE 08:15 PT the same day** (commits `afcb2e6` `2a77d16` `8e1cd8e`; backend
`9b5bda2`): 25 cars per tick, 15 s heartbeat, Tripo pool/rate-limit aware, no self-disable on
empty credits, **server-issued scan slots** bound to the signed-in account (RevenueCat is NOT
in the app yet — `SCAN_REQUIRE_TIER` on Render is the enforcement switch, 0 in beta), caps
6000/day. Supervised slot-path run: 5 m 46 s, 50 credits, 0 errors. App OTA `0a6ea103…`.
Open: flip `require_slot` after pickup; Jeff pre-buys ~$170 Tripo credits + raises the alert.

### 2026-09-01 — watchdog kills fixed: per-tick state moved off layer properties (OTA `586e1273`, commit `26b21f4`)
- **What broke:** Jeff's 9 am drive relaunched five times in four minutes at 90–113 km/h. Two `.ips`
  logs: `0x8BADF00D` scene-update watchdog (main thread ≥10 s inside `StyleManager.updateLayer →
  getStyleLayerProperties`) and a 5 s terminate-hang in `MapboxCommon CleanupManager`. Same stall
  under 10 s = "Show map froze phone + CarPlay".
- **Why:** `@rnmapbox` re-applies EVERY layer property and does a full main-thread read-modify-write
  on any `style` content change (no diff). The ribbon pushed `lineTrimOffset` + a gap-baked
  congestion gradient at 12 Hz on three layers per surface; the self-car marker pushed
  `modelRotation`/`iconRotate` every eased frame (2 synchronous RMWs each).
- **Fix:** `src/routeRibbon.ts` — the ribbon is cut GEOMETRY with per-feature colour/alpha, all
  ribbon layers static; marker heading rides its feature (`['get','rot']`). Rule in CLAUDE.md →
  Map rendering. `heatProbe` `main-gap` now reports a ≥2 s stall the moment it ends.
- **Verified:** 12-agent adversarial review (all findings applied); standalone math; simulator
  Release build navigating a real Hwy 1 track at 100 km/h through bends — 8 s / 1 ms stack sample:
  `getStyleLayerProperties` 0, `resolveUpdatedLayerProperties` 0, `addStylesAndUpdate` 0 with the
  map fully active; dtP95 17–23 ms; fade renders as one continuous ramp. Key probe
  `KEY_PRESENT=1` both platforms.
- **Field validation owed (07-31 rule):** one real drive on CarPlay — the head unit cannot be
  driven on the bench (no entitlement in local builds); it runs the same `CarMapView` path.

| | value |
|---|---|
| **Build** | **74** (iOS build number 74 · Android versionCode 74) |
| **runtimeVersion** | **1.26.0** |
| **version** | 3.10.0 |
| **channel** | `mapbox-migration` |
| **cut** | 2026-08-27 (second cut — the first errored, see below) |
| **status** | finished both platforms · **Play internal `completed`** · TestFlight submitted (by Jeff) |

**Runtime parity holds.** iOS 74 and Android 74 are both at runtime **1.26.0**, matching `app.json`.
An OTA to `--branch mapbox-migration` reaches both platforms. First 1.26.0 OTA is already out:
group `96cfc25f` (the gold/silver H-metal fix, commit `4f26aad`).

Receipts: `npx eas build:list` — iOS id `f4a527b3`, Android id `2beda99e`; Play API read live
(track=internal, status=completed, versionCodes=[74]).

**In 74** (announced to the crew 2026-08-27, 3D car scan deliberately excluded): dead-man GPS sweep
(the Rodrigo/Olaf battery drain), the visited-stops reroute fix (`32da873`), the mic arbiter,
marker-size uniformity, app skins (H logo + Arrow/Class/3D sets the look), the GRC2 two-tier car
model, and the full car-scan pipeline (viewfinder, server-side 2-scan cap, return leg to the Garage).

**Moved to build 75** (not in 74): RevenueCat SDK, the `Screen.setMarker` CarPlay patch, the native
AA `isConnected` getter.

⚠ **The trap that errored the first 74 cut:** a density-suffixed require
(`assets/vehicles/v3/heavy_metal@3x.png`) resolves in dev Metro but fails release
`expo export:embed` on both platforms. Require the base asset name; verify by running the failing
export locally before re-cutting a paid build.

> Installs on 73 and below are frozen at their last 1.25.0 OTA until they install 74 from
> TestFlight / Play internal — post-74 OTAs reach only 1.26.0 installs.

### ✅ Android ships through PLAY INTERNAL TESTING — the APK/QR rule is retired

**Corrected 2026-08-26** after Jeff challenged it: *"I THOUGHT ANDROID/AA WAS INTERNAL TESTING ONLY
AND NO APK ANYMORE?"* He was right. This section previously read build 73's missing `.apk` as a
**regression**; it is the **intended state**.

Verified 2026-08-26 (Play API + `eas build:list`):

| | |
|---|---|
| Play **internal** track | **build 73 (3.9.0), status `completed`** — released to testers |
| last sideload `.apk` ever cut | **build 72, runtime 1.24.0, 2026-08-12** (profile `mapbox`) |
| build 73 | `mapbox-android-store` **AAB only** |
| `play-store-service-account.json` | present, added **2026-08-12** — the same day the APKs stopped |
| channel on `mapbox-android-store` | **`mapbox-migration`** — Play installs receive our OTAs normally |

The service-account key is what used to block Play submits. It landed 08-12, and the sideload route
stopped being used that same day. Nobody recorded the change, so the old rule kept propagating.

**Why the APK is not just unnecessary but harmful:** Android Auto never listed sideloads at all
(tester-confirmed, 68 vs 69); a sideload **blocks** the Play update because the two are signed with
different keys, forcing an uninstall that **wipes the tester's local settings**; and it is a second
paid Android build every release.

**The only remaining reason to cut one:** an Android tester who is not on the internal email list
("Android Hairpin Beta Testers", 6 addresses incl. `sayphinl` as of 08-13). **Adding someone to that
list is free — cutting an APK is a paid build.** Check the list first.

---

## 2 · OTA position — VERIFIED 2026-08-22 (73-era snapshot; the branch/channel trap below is still current)

**Nothing is waiting. Git and the published bundle are the same commit.**

- `git rev-parse HEAD` → **`c5fa646`** *"REVERT: Widebody back to widebody3 — widebody4 does not
  render on the car map"*, 2026-08-21 17:50:46 −0700
- Latest update on branch `mapbox-migration` → group `3cadebb3-40d8-4210-a0f5-364a5bab4e7c`,
  *"REVERT: Widebody model back to widebody3 (car marker missing on CarPlay)"*, runtime **1.25.0**,
  **both platforms**, git commit **`c5fa646`**, published **2026-08-22T00:51:14Z** (= 2026-08-21
  17:51 PT)
- `git log origin/mapbox-migration..HEAD` → **empty**. Zero unpushed commits.
- `git status --porcelain` → **26 entries, all untracked (`??`)**. No modified tracked files.

So every committed JS change is live on testers' devices. **There is no OTA backlog.**

All 20 most-recent update groups on `mapbox-migration` are at runtime 1.25.0, both platforms, none
a roll-back-to-embedded.

### The branch/channel trap — do not publish blind

Three branches exist: `mapbox-migration`, `preview`, `production`. Three channels exist, and the
mapping is **not** one-to-one:

| channel | → branch |
|---|---|
| `mapbox-migration` | `mapbox-migration` ✅ |
| `preview` | `preview` |
| **`production`** | **`preview`** ← not `production` |

**The `production` BRANCH has no channel pointing at it.** `eas update --branch production` reaches
**nobody**. Publishing target is always `--branch mapbox-migration`.

Also: `npx eas update:list --limit 20` **fails** in this repo without `--branch`. Always pass it.

The `preview` branch is frozen at runtime **1.13.2** (last update 2026-07-06); `production` branch at
**1.1.11** (2026-06-09). Neither is reachable by a build 73 install.

---

## 3 · What shipped in the last 6 days (OTA, runtime 1.25.0)

`HANDOFF-48H` stops at 2026-08-16. This is the gap. Newest first:

1. REVERT: Widebody model back to widebody3 (car marker missing on CarPlay) — `3cadebb3`
2. Telemetry `handle` + Reset app data — `c588bd79`
3. Nav: stale reroute guard + along-route step anchoring + crumbs — `f3965376`
4. Nav bar: turn-by-turn button beside End (CarPlay/AA attached) — `617047cb`
5. Widebody panels smoothed (widebody4) + new hero — `0a1d2e13` ← **reverted by #1**
6. Garage hero restored (0px wrapper) + 360 viewer front-left — `20fd3b2e`
7. Garage: tap the hero to spin your car in 3D + Widebody hero fixes — `fdaac006`
8. Widebody: nose direction fixed (exporter convention flip) — `76310e38`
9. Widebody fix: 16-bit indices (now visible on map) + hero orientation — `18c206ec`
10. Garage Scan first light: Jeff's Widebody GRC as a pickable colour — `4aacf533`
11. CarPlay/AA sync fix: same-tick position feed + never-rewind gate — `d4990384`
12. Drift instrumentation: drawn-vs-raw breadcrumb + OTA rollback beacon — `2918f0ae`
13–20. S2000 left side · Garage drop (GT3 RS, S2000, M2, LC 500, LFA) · Yaris paint recipes ·
GR Yaris 5 paints + 3D · premium phone pass · candy maneuver squares · premium tab glyphs ·
premium CarPlay glyphs

---

## 4 · Build 75 — CUT 2026-09-02 (record below). Build 76 = widgets/watch + RevenueCat.

### ✅ BUILD 75 — CUT 2026-09-02 22:44 PDT, BOTH PLATFORMS FINISHED (runtime 1.26.0 → **1.27.0**)
- iOS `a65064e0` (profile `mapbox-ios`) finished 22:52 · Android `967a8402` (profile
  `mapbox-android-store`, versionCode 75) finished 22:58 · both **v3.10.0 / build 75 /
  runtime 1.27.0 / channel `mapbox-migration` / distribution store** (verified on the build
  records). Commit `c86a336`. Parity: GOOD.
- **Submits: `eas submit` is blocked for Claude by the auto-mode classifier (as on 74) —
  Jeff runs both:** `eas submit --platform ios --id a65064e0-da9a-4dc7-b75d-a08f68ddcfb3 --profile production`
  and `eas submit --platform android --id 967a8402-9724-48e5-a66d-cf2dfa919ab9 --profile production`
  (Play `internal` track). Until they land, testers stay on 74.
- 🛑 **PLAY REJECTED THE ANDROID 75 AAB — "Target SDK of artifact is too low"** (submission
  `4e8b305b`, 23:10 PDT). Google requires **API 36 (Android 16) for app updates since
  2026-08-31**; build 74 was accepted on 08-27, four days before the deadline. Cause:
  `app.json`'s `expo-build-properties` block **pinned `compileSdkVersion`/`targetSdkVersion` 35**
  (EAS Gradle log for 75: compileSdk 35 / targetSdk 35). Fixed in `f01fa5b` → 36/36, build-tools
  pin dropped, **Android re-cut as versionCode 76** at the SAME runtime 1.27.0 (iOS stays 75 —
  runtime parity is the rule, not build numbers). iOS 75 → TestFlight succeeded (submission
  `f34a5958`, processing at Apple). The EAS log lives behind a brotli-encoded `logsUrl` on the
  GraphQL API — `submission:list` only says "Fastlane supply failed".
- ✅ **Android re-cut FINISHED 23:35 PDT — `421a3691` (`mapbox-android-store`), v3.10.0, versionCode 76,
  runtime 1.27.0, channel `mapbox-migration`, compile/targetSdk 36.** Pair for the crew = **iOS 75
  `a65064e0` + Android 76 `421a3691`, both runtime 1.27.0** (parity GOOD). Play submit for 76 is
  Jeff's to run (classifier): `eas submit --platform android --id 421a3691-3cb8-4cf0-aabc-45aaa7ffb551 --profile production`.
  The rejected 75 AAB (`967a8402`) is dead — never submit it.
- ✅ **Play internal: 76 SUBMITTED by Jeff — submission `fb136a2a` finished 23:40:49, track `internal`,
  release status `completed`.** Internal-testing opt-in link (unchanged since 74):
  https://play.google.com/apps/internaltest/4701493715980602911 — testers already enrolled get 76 via
  Play's normal update; Android Auto is the same app (no separate install). AA code in 76 is byte-
  identical to 74's (`withConvoyAndroidAuto.js` + patches untouched; `AndroidAutoRoot.tsx` diff is the
  `aaMapButtons()` accessor already OTA'd) — the ONLY new variable for AA is targetSdk 36, which is
  UNVERIFIED until Say Phin's first connect on 76.
- 📣 **Crew note SENT 23:47 PDT** (Claude, via the WhatsApp desktop app — Hermes is still unlinked) to
  "Hairpin App Testing": iPhone = TestFlight 3.10.0 (75); Android = Play Store update 3.10.0 (76),
  up to an hour to appear, AA is the same app, internal-test link for newcomers; why (CarPlay-launch
  stranding); the "Starting Hairpin…" placeholder is the fix working; old builds stop receiving
  updates. Rodrigo had already posted "updated to 75" at 23:45. Jeff's own 22:46 note: "I can't push
  a line of OTAs that are staged until everyone has build 75."
- **What 75 carries (over 74):** the CarPlay-first OTA-stranding fix (`CARPLAY-OTA-STRANDING.md`
  B1/B2/B4 — the cold-CarPlay host wait never mints the RN host; placeholder + App Group
  diagnosis + unbounded slow poll; ceiling 20 s → 90 s) · `HairpinSystem.getSharedDefaults/
  removeSharedDefaults` + the `carplay-host-ceiling` next-launch report · `hairpin://` scheme
  ADDED beside `convoy://` · Google Maps SDK dropped at prebuild · `eas.json` mapbox-ios image
  `auto`. JS embedded (all OTA-able): `main-gap` full AppState sequence + `sinceApp=` ·
  `cam-probe` (applied zoom/pitch vs target + speed, on change, ≤1/s) · `route-fetch-fail
  why=` on the `fetchRoutes` catch · updates-log harvest oldest-first with entry timestamps.
- **NOT in 75:** RevenueCat, widgets/watch native, `Screen.setMarker` patch, AA `isConnected`,
  the OTA-able self-heal A1. **Widgets + watchOS = build 76** (no watch target exists; the
  `WIDGETS.md` haptic spike must precede any watch code).
- ⚠ **The runtime bump is a one-way door:** every OTA from now on targets 1.27.0 — a tester
  still on 74 gets nothing further. Sequence: crew installs 75 → then OTAs. Do NOT flip
  `require_slot` until the stranded/74 testers are on 75.
- Pre-flight that earned the green first try: `yarn typecheck` · `expo export` both platforms ·
  a **clean** local `expo prebuild --clean` + Release compile (the first local compile reused a
  stale `ios/` from Aug 14 and proved nothing — check `CarSceneDelegate.swift` carries the new
  constants before trusting BUILD SUCCEEDED).


> ⛔ **SUPERSEDED 2026-09-02 — this section was written for build 74, which CUT and SHIPPED on
> 2026-08-27** (v3.10.0, runtime 1.26.0, both platforms, Play internal complete + TestFlight).
> **The current build-75 backlog is §4 of `HANDOFF-2026-09-02.md`** — read that, not this.
> Everything below is retained as the reasoning that produced 74.

**Historical (2026-08-22): build 74 did not yet exist on either platform.**

74 is the next **native** build, so everything native queues into it. Bumping `runtimeVersion` for
it means **both platforms must be cut in the same batch** or the unbuilt one is stranded from every
later OTA.

Native payload for 74:

- **RevenueCat SDK** — a native module, cannot ride an OTA. Gates the whole monetization sequence.
- **A sync native `isConnected` getter in the react-native-carplay patch** — RNCarPlay.m flips its
  native store false BEFORE the bridge-guarded didDisconnect emit, so a sync getter is ground truth
  the JS events can't fake. Closes the one half of the 8/26 background-GPS leak the OTA dead-man
  switch can't reach (an in-context lost didDisconnect leaves the JS `CarPlay.connected` probe
  answering true). See `_sweepBgConsumers`' header in navNotification.ts.
- **`Screen.setMarker(templateId)` in the react-native-carplay patch.** react-native-carplay never
  calls `Screen.setMarker` anywhere (the only `setMarker` in the package is on a *Place* builder,
  `RCTTemplate.kt:215`). With no marker, androidx's `popTo` finds nothing and pops everything except
  the session ROOT placeholder — which is how every Android Auto search dismiss threw the driver out
  to the app drawer. A guarded single `popTemplate` shipped as the JS workaround (`0e43bbe`); the
  marker is the real fix.
- **Android delivery = the store AAB (`mapbox-android-store`) + a Play internal submit.** NOT a
  sideload APK — see §1; that rule is retired. `eas submit` needs Jeff's explicit go-ahead every
  time. Android Auto in particular has never worked from a sideload, so 74's AA fixes only reach
  testers through the Play internal track.

**JS deliberately riding 74 instead of an OTA** (this is a choice, not a constraint — each of these
*could* ship OTA today):

- **The two-tier car models** — `97debd1` + `466f47e`, Jeff 2026-08-28: **"hold for 74."**
  Garage hero keeps the full GRC2; map + CarPlay load the decimated `GRC2_map1.glb` twin
  (48,760 verts / 2.21 MB vs 217,651 / 9.24 MB — the ego car drops from 8.7× to 2× over
  Mapbox's vert budget; heat lever). The publish gate is CLEARED: the twin is live in the
  bucket, byte-identical, sim-verified through the committed code and the real https URL.
  Includes the convoyCar4_→convoyCar5_ model-id generation bump and the new `publish-model`
  edge function + `tools/glb-pipeline/publish_model.sh` (how ALL finished models reach the
  bucket from now on).

- **The mic arbiter** — `src/micArbiter.ts` + `audioMode` / `pttChannel` / `useVoice` / `askScout` /
  `carComms`, committed `b7b633c` and pushed, **not published**. Jeff, 2026-08-26: *"hold it for the
  next build."* It changes mic ownership on iOS phone, CarPlay and Android phone simultaneously, and
  it lands after seven OTAs in twenty hours — the 0731 rule says one change per real drive, so it
  gets validated on a build rather than pushed at the crew mid-week. Verified before commit: 25/25 in
  an offline clock-controlled simulation (including the lock-screen case — timers frozen two minutes,
  lease still reaped), a negative control failing for every fix, typecheck clean, lint at baseline,
  no import cycles, and a clean sim boot through a Comms mount/unmount. **NOT verified on a real
  device or a real Bluetooth car stereo** — that is exactly what cutting it with 74 buys.

⚠ When regenerating patches: `npx patch-package react-native-carplay --exclude 'android/build/'`,
then verify `grep -ac '^diff --git' patches/<name>.patch` is unchanged. This has silently destroyed
the whole Android Auto port once.

**Cost gate: `eas build` is paid. Batch the scope, get Jeff's explicit go-ahead, and confirm
`yarn typecheck` is clean and `yarn.lock` consistent before recommending it.**

---


### 🌅 MORNING RUNBOOK 2026-09-03 — teed up 00:40 PDT, executes when the crew is on 1.27.0
Two session-local timers exist in Claude's session (die if the session closes): **06:03** one-shot
tester reminder (WhatsApp desktop); **every 30 min from 06:33** a gate that queries who is on
runtime 1.27.0 and, once every handle active in the last 24 h (Jeff excluded) is on it: ships
HEAD via the ship-ota ritual (`env:exec preview` + `verify-bundle-key.py <group> 1.27.0`), flips
`pipeline_flags.require_slot=true` once Rodrigo/Ni GR/GRSIENNA are on 1.27.0, reports, deletes itself.
- ✅ **06:03 reminder fired late (first Supabase call hung) — SENT 07:00 PDT** to Hairpin App Testing,
  naming Ron / SMSGRC / Victor 3d Dude as still on 1.26.0. **State at 06:59:** on 1.27.0 = Enablewhore,
  GRSIENNA, Ni GR, Rodrigo (iOS), **SPL_GRC (Android 76 — confirmed on his head unit, screenshot
  `1 Crew · v75 · 1.27.0 · emb` at 06:04)**, Jeff. Still 1.26.0 = Ron (Android, active 06:51), Victor
  3d Dude (Android, 03:31), SMSGRC (Android, last row 09-02 09:45). **All three formerly-stranded testers
  are on 1.27.0 → `require_slot` is unblocked.** John Mungai posted "1.27 emb / V75" at 00:11 (iOS).
- ✅ **OTA-A SHIPPED 2026-09-03 ~07:15 PDT on Jeff's "ship it"** (the gate was still holding on Ron /
  Victor 3d Dude / SMSGRC at 1.26.0 — they get nothing until they install 76; nothing lost).
  **Group `1fac6dc3-a67b-4dfb-bb48-ed6788dbc627`, runtime 1.27.0, both platforms, commit `f32c406`.**
  Proof: `ios KEY_PRESENT=1 openweathermap=2 neg_control=0` · `android KEY_PRESENT=1 openweathermap=2
  neg_control=0` (control group `0a6ea103` @1.26.0 identical). **First OTA at 1.27.0 — the red pill
  now has something to show on 75/76.** `require_slot` LEFT FALSE (Jeff said "ship it", not "flip
  it"; the flip is safe for every device — all three laggards are on the slot-path OTA `01a062b7`).
  OTA-B still `REROUTE_ORIGIN_BEARING = false`. The 06:33 gate cron was deleted after this publish.
- ✅ **`require_slot = true` — FLIPPED 2026-09-03 07:08:42 PDT on Jeff's "flip it".** Slot-less uploads are
  now skipped, never rendered. Safe for every device: the formerly-stranded three are on 1.27.0 and the
  three 1.26.0 laggards are on the slot-path OTA `01a062b7`. Worker tick 07:08:43 (1 s later) = `200
  ok:true idle:empty`, no worker errors. `enabled=true · daily_credit_cap=6000 · per_user_cap=2 ·
  min_balance=300` unchanged. Off switch unchanged: `update public.pipeline_flags set enabled=false …`.
- 📊 **FIRST 75 DRIVE READ (Olaf, 05:56–06:48, embedded `b16bda5e` — nobody had tapped the pill yet):**
  1. **Stranding fix — FIELD-PASSED.** 05:56:20 a fresh process (`iapltp`) came up CarPlay-first:
     `carplay-onconnect → idleroot-set → live-paint`, and its own updates-log rows show
     `appLoaderTask didFinishWithLauncher` + `endStartup` → the car surface mounted on expo-updates'
     host, `launch_kind=embedded`, update id present. No `carplay-host-ceiling`, no `unknown`.
  2. **Olaf's size flash — MECHANISM VERIFIED from `cam-probe` (803 car rows / 484 phone):** the camera
     target swings ≥2 zoom levels **10× on car, 8× on phone — every one OUT of `CORNER_ZOOM` 18.5**
     (the moment a maneuver passes, `chaseZoom` drops from 18.5 to the speed zoom 13.7–16) and the
     1.4 s low-pass then glides the APPLIED zoom through it at >1 level/s (**11 of 11** car glides
     ≥0.9 level/s follow such a swing; max 1.70/2.03 levels in one second; snaps ≈0). modelScale is
     2×/level, so the car visibly halves/doubles over ~2 s at every corner exit, on both surfaces in
     lockstep. Fix candidates (design call): ease the corner-zoom RELEASE over ~3 s instead of
     snapping the target, or hold the self-car's on-screen size independent of the corner zoom.
  3. **Rodrigo's reroute hang — REPRODUCED on Olaf, on 75:** 06:22:17 off-route → ids 8–17 over 2.5 min;
     **10 results landed in the same second (06:27:33), ages 159/135/84/76/68/59/32/23/15/7 s — 9
     superseded, 1 applied.** `stops=0/1` = the `fetchRoutes` path WITH the 15 s AbortController — and
     **zero `route-fetch-fail` rows** (that crumb is in 75's bundle). Requests past 15 s resolved with
     real routes and never threw → **the abort provably does not fire on this build.** Next crumb: log
     when the abort TIMER fires vs when fetch settles.
  4. **Olaf's same-route loop — again, on 75, 06:01:31–06:02:12: 6 reroutes in 41 s, each `moved=0m
     n=1 stops=1/1 applied`, step reset each time — the STOPS path (`fetchRouteViaStops`).** ⚠ OTA-B as
     staged threads the bearing into `fetchRoutes` ONLY; it must also cover `fetchRouteViaStops` or it
     misses exactly this case.
  5. `main-gap` new format works (`app=a sinceApp=…` = never left foreground). 7 of 8 rows sit at
     6–17 km/h crawl (loop-idle caveat applies); the one at speed: 06:06:09 dt=2.9 s @25 km/h.
  6. `arrive-speak 06:48:38 novaMuted=0` — Olaf has Nova ON today; the tts crumbs will tell once he
     is on `1fac6dc3`. Say Phin has not driven on 76 yet (no AA rows at 1.27.0).
- **OTA-A (LIVE at HEAD, ships first):** `9a01f45` TTS receipts — `tts-say/tts-play/tts-done/tts-cut/
  tts-skip`. Instrumentation only. Answers "scout drops sentences on arrival" with one query.
- ✅ **OTA-C SHIPPED 08:07 PDT on Jeff's "ship it" — group `7abe6a20-6529-4392-8c46-abbc9055ffbb`, runtime
  1.27.0, both platforms, commit `6ed21a1`.** Proof: `ios KEY_PRESENT=1 openweathermap=2 neg_control=0` ·
  `android KEY_PRESENT=1 openweathermap=2 neg_control=0`. Bundle = camera slew (live) + heading receipt on
  draw-cmp (live) + abort-timer crumbs (live) + OTA-D nose lead-in (`NOSE_LEAD_IN_ENABLED=false`) + OTA-B
  bearing reroute (`REROUTE_ORIGIN_BEARING=false`). **This is drive 1 (camera). Verdict = cam-probe on the
  next drive: no second with |Δz| ≥ 0.5, `zg` never > 0.5 ahead of `z`. Then drive 2 = flip the nose flag,
  drive 3 = flip the bearing flag — one per drive.**
- 📣 **Crew told 08:12 PDT** (WhatsApp desktop, "Hey guys, it's Claude" — the "Jeff's AI dev" suffix is
  RETIRED per Jeff 09-03): what's in the OTA in plain terms (smoother camera after turns / holds still
  at steady speed / the size-flash fix; extra logging for Scout cut-offs and stuck reroutes, no
  behaviour change there yet), the red pill, and what to watch for (zoom-out after corners smooth not
  slow · map still at steady speed · car still flashing?). Told them the nose-into-corners fix is next.
  Context in the chat: Say Phin 07:38 "Uneventful drive, nothing to report" (first AA drive on 76).
- **OTA-C (was: STAGED at HEAD, live code — the NEXT nav change to ship, one drive):** slew-limited camera
  goal in `pushCam` (`CAM_ZOOM_SLEW_PER_S 0.5`, `CAM_ZOOM_DEADBAND 0.25`, `CAM_PITCH_SLEW_PER_S 5`).
  Fixes the corner-zoom RELEASE cliff (Olaf's size flash) and the speed-jitter creep (Jeff's "notchy").
  Replay of Olaf's real trace: 1.93 → 0.49 max level/s, 0 seconds ≥0.5/s, rest 33% → 24%. Verify on
  the drive with `cam-probe` (`zg=` is the goal): expect no second with |Δz| ≥ 0.5. Tool:
  `tools/cam-probe/replay.py`. Ship with the ship-ota ritual on Jeff's word; bearing flag stays off.
- **Also in the OTA-C bundle — heading receipt** (`draw-cmp … hdg= gpsHdg= rb=`, both surfaces): Jeff's
  "nose doesn't follow the corner" on 74. VERIFIED how the nose is driven: while snapped = bearing of the
  single projected route SEGMENT (steps per vertex), eased ~1.1 s/fix behind an 8° dead-band; camera rides
  the same value in lockstep (the car is rigid on screen, the road rotates). Two readings, two fixes:
  (A) no lead-in → let the camera heading lag the car's; (B) nose off the road mid-corner → interpolate
  the bearing along the curve. **Jeff: "both, mostly A" → STAGED (flag OFF) as OTA-D:**
  `NOSE_LEAD_IN_ENABLED` in ConvoyMapbox.tsx — camera heading lags the car (700 ms, ≤25° lead) +
  `bearingSmooth` curve tangent for the drawn nose (`noseBearing()`, both surfaces); gates keep the
  raw segment `bearing`. ⚠ Correction: the 8° heading dead-band only holds the nose when the car
  is also nearly stationary (the condition is an AND) — while driving the ease re-arms every fix,
  so the notchiness was the per-vertex step + the 1.1 s ease, not the dead-band. Own drive after
  OTA-C; measure the lead with cam-probe `hdg=`/`ch=`.
- **OTA-B (STAGED, `REROUTE_ORIGIN_BEARING = false` in map.tsx):** origin `bearings=<hdg>,45;` on
  off-route refetches (Olaf's 8-reroute loop). **Needs Jeff's word**: flip the flag, `OTA:` commit,
  publish — and it gets one real drive to itself. `reroute-result … bearing=` shows what was sent.
- **Read after the first 1.27.0 drives:** `carplay-host-ceiling` / any `launch_kind=unknown` on 1.27.0
  (stranding fix) · `aa-crumb` on Say Phin's first AA connect (targetSdk 36) · `cam-probe` (Olaf's size
  flash) · `route-fetch-fail why=` (Rodrigo's 15 s abort that never fired) · `main-gap … app=<seq>
  sinceApp=` · `tts-cut` at arrivals.
- **Not teed up (needs design or a drive first):** congestion+reason on the map at the faster-route
  offer (#1) · replay (#3, nothing exists to revamp) · peer twin in presence (#4, heat budget) ·
  failed-scan surfacing (needs a readable job status) · RevenueCat/widgets/watch = build 76.

## 5 · The road to build 80 — GRC club launch

Jeff's goal (2026-08-20): **build 80 launches Hairpin to the full ~170-member GRC club** with full
access until the app-store launch. It doubles as the load test for Expo / Supabase / MongoDB /
Render / Play / TestFlight.

| build | contents |
|---|---|
| **74** | native — CarPlay patches + RevenueCat SDK |
| **75–76** | OTA — entitlement gating, premium badges, paywall |
| **77** | referral backend + website |
| **78** | Play closed testing + TestFlight public link dry run |
| **79** | hardening + staged invites |
| **80** | full club launch |

**Entitlement codes** (Jeff's decisions — server-side, because store promo codes cannot express this):

- existing beta testers → personal codes, **never expire**, bound to their emails → `beta_og` free forever
- club members → signup code granting `club_founder`, auto-expires at full launch
- referrals → personal share code; when a **paying** subscriber uses it the referrer gets **+1 year**
  (RevenueCat promotional entitlement; cap stacked years)

**Free-tier split** (Jeff's list): green 3D arrow only · Clubs/Events/Cruises/Discover/My view-only ·
Top Speed hidden · Drives available · day map only · green route only · speed cameras + incidents
locked · Gas Jockey free · Nova-only voice · spoken extras locked · speed alert locked · comms
hands-free locked. Everything locked wears a premium badge → one shared component → paywall.

### ⏳ Still needs Jeff's decision — blocking

- **Pricing.** Suggested 2026-08-20, never signed off: **$4.99/mo · $39.99/yr · 7-day trial**,
  plus a **$99 Founders Lifetime** limited to the launch window.
- **The free-tier tweaks I proposed**, still pending: PTT stays free (VOX premium); free users
  **see** convoy hazards (cameras + reporting premium); convoy size capped ≤3 on free.
- **The donate URL.** The stub currently points at `hairpin.app/donate`.

### Must harden before 170 people arrive

Render · Supabase · **Play store declarations (8 open)** — background-location is blocked on a demo
video, and UGC triggers Guideline 1.2, which wants report + block + EULA in code.

---

## 6 · Open issues, ranked

### scan-worker v3 hardening — HELD for Jeff's go (review 2026-09-02, none critical, pipeline works as-is)
Ranked by what it protects. Server-side only (Supabase), no app change, no build.
1. *(optional — two independent verifiers REFUTED the risk: the 170 s lease + transaction advisory lock already prevent a double buy)* **Fence row writes to the lease** — `updateJob` adds `.eq('locked_by', tick).gt('lease_until', now)` and throws `LeaseLost` on 0 rows; today double-buy protection rests on the 170 s lease outliving a 130 s tick (`deps.ts updateJob`).
2. **Abort check before every paid POST** — `if (signal.aborted) throw` at the top of `paidSubmit`; a POST after the budget is recorded as a lost reply and the generate FAILS the job.
3. **Tripo 5xx = ambiguous, not "no task"** — `isDefiniteRejection` must also require `httpStatus < 500`, else a 5xx that did create a task rolls the ledger back.
4. **Guards reserve the ceiling (60), not the nominal 50**; re-read `pipeline_flags.enabled` inside `paidSubmit` (a tick started before the switch went off can still buy converts).
5. **Log which secret failed (never values)** in `resolveSecrets`; drop the isolate-lifetime cache (one RPC per tick is nothing) so a Vault rotation takes effect without a redeploy; `.trim()` Vault values.
6. **Policy, Jeff's call:** the shipped anon key can upload a folder and spend, keyed on a client-supplied handle — bounded only by `daily_credit_cap` 300 ($3/day) + balance floor. Options: lower the cap while testers are few, or have `register-scan` issue the scan id and refuse unregistered folders (closes it properly).
Not exposures (verified by probe): pg_net's PUBLIC table grants are unreachable — the API exposes only `public, graphql_public`.

**1 · widebody4 invisible on the car map — CAUSE NEVER ESTABLISHED.**
Shipped 2026-08-21 morning, Jeff's mid-drive photo showed no car marker, reverted same day
(`c5fa646`). widebody4 is uint16 and structurally identical to widebody3, and it renders fine in
Mapbox GL JS on desktop. **This is unexplained and will recur on the next model swap.**
> ⚠ `draw-cmp` telemetry reports the position handed to the marker — **not whether the model
> rendered.** It read healthy while the car was invisible. Do not use it to clear a marker bug.

**2 · CarPlay End button did not work** (Jeff, 2026-08-21). Unresolved: it is not known whether the
press reached JS. The receipt chain is shipped (`83600a09`) — a full crumb chain with the pressed
button and **no tap row** means the press died native-side, which makes it a build fix. Needs Jeff
to say whether a pill appeared.

**3 · ✅ 3D car — TRIPO PICKED, look approved 2026-08-23.**
Jeff: *"this current widebody is by far the best… this is the #1 pick so far."* The asset and
its irreplaceable source generation are saved at `~/Documents/hairpin-3d/PICKS/` with a full
recipe in `PICKS/MANIFEST.md`. 190,000 tris · uint16 · 6.47 MB · 2K maps — inside the fleet
budget. **Not yet uploaded to the Supabase bucket and not referenced in `vehicleAssets.ts`;**
Mapbox caches by URL so any rebake needs a new filename. Details in `HANDOFF-3D.md`.

**4 · Premium gates not wired** — map modes, route colours, cameras, voices, speed alert, VOX,
club-create, top speed, convoy size. Backend entitlement endpoints live in `~/convoy-backend`
(build 77).

**5 · Class colour batch** — GT3 RS +7, GRC +4, LFA +5. Baked, needs QC + wiring.

**6 · Mic arbiter — FIXED, held for build 74.** ~~There is no arbiter anywhere.~~ There is now:
`src/micArbiter.ts` (`b7b633c`, 2026-08-26). One lease at a time across all four recorders (scout /
voice / ptt / carComms), and `audioMode`'s two destructive flips defer while a lease is held. The
change is **JS-only and OTA-able**, but Jeff's call on 2026-08-26 was **"hold it for the next
build"** — it touches the mic on every surface at once and follows seven OTAs in twenty hours, so it
wants a real drive behind it rather than another same-day push. See §4.
**Still open underneath it:** hold-to-talk on CarPlay remains impossible — `react-native-carplay`
exposes a single-press handler, not press/release. That is a separate native problem, untouched.

**7 · Leaderboard misses free drives.** `recordTrip` fires **only** from `onArrive`, so `trips` is
an exact usage counter — but personal bests never record on a free drive. Crew has been told the
interim rule.

**8 · Offline** — TTS is silent offline, no Mapbox offline tile packs, no NetInfo. Deliberately not
done: it reverses an earlier call about the robotic device voice.

**9 · Settings are per-device local** — not synced across a user's devices.

**10 · Map orientation freak-out** — tester report, not reproduced.

---

## 7 · Next session — do these in order

1. **Read `RULES.md`, then this file.** Do not trust `HANDOFF.md`'s header.
2. **Re-verify §1 and §2 live** (`eas build:list` both platforms, `eas update:list --branch
   mapbox-migration`, `git status`). These numbers age.
3. **3D: the vendor is TRIPO and the look is APPROVED.** Jeff picked PICK 1 on 2026-08-23
   (*"this current widebody is by far the best"*) and closed the vendor question the same day
   (*"we are working with Tripo now"*). **Do not benchmark other modelers or re-open a comparison.**
   Tripo Multi-view takes **4 orthogonal views** — front / left / right / back. The approved asset
   lives in `~/Documents/hairpin-3d/PICKS/`; it is NOT yet uploaded to the `models` bucket or wired
   into `vehicleAssets.ts`. Ask his credit budget before spending on generations.
4. **Commit the three new docs** if not already done (`RULES.md`, `ROADMAP.md`, `HANDOFF-3D.md`).
5. Then the ranked list in §6.
