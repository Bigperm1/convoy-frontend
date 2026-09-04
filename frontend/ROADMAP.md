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
- 🎯 **"SCOUT DROPS SENTENCES AT ARRIVAL" — ROOT-CAUSED from the first tts receipts (Say Phin, 07:36:04, Android 76,
  OTA `1fac6dc3`).** Three mechanisms in one arrival, all from rows:
  1. `07:36:03.071 tts-say len=45` → `07:36:04.084 arrive-speak` → **no `tts-say` for the arrival line** — it was
     **dropped by `speak()`'s 1.5 s rate gate** (`if (now - _lastSpoke < 1500) return;` — 1.013 s after the previous say).
  2. `07:36:04.109 tts-cut queued=1 playing=1` — 25 ms later `onArrive → endNav → resetSpeakGate()` **emptied the queue**
     (the queued 45-char line never played) while a clip was still in flight.
  3. That in-flight clip: `07:35:54.100 tts-play len=20` → `07:36:09.080 tts-done ms=15018` — **a 20-character line took
     15 s** (cold `/tts` network hop; the drive's first callout took 19.6 s: `tts-done ms=19644 len=43` at 07:19:10).
  Fix (OTA-E, to stage): exempt the arrival line from the rate gate · let the arrival clip finish before the
  teardown resets the queue/audio session (bounded wait) · prefetch the arrival phrase at the prepare callout the
  way turn cues already are (`prefetchTts`). Verify with the same rows.
- 🧩 **REINSTALL LOSES THE SCAN (Olaf, iMessage 06:24 09-03) — OPEN, ranked with #2 (failed renders invisible).**
  He uninstalled/reinstalled to get 75 (2 am), the phone's `carScanId`/`carScanMapUrl` went with AsyncStorage,
  and he re-uploaded. VERIFIED: the re-upload `enablewhore-20260903-095615` went `queued → WAIT user-cap →
  FAILED` at 03:02, **0 credits, no slot** — the per-user cap of 2 held. His twin
  `scan_enablewhore-20260901-210315_map.glb` is intact in the bucket. Two gaps, both real: (a) **no recovery
  path** — `carScanId` is only ever set at capture (`garage-capture.tsx`), the backend has only `POST /scan/slot`,
  nothing lists an account's scans; (b) **the phone is never told the worker refused** — `carScanStatus:'failed'`
  is still never written, so his Garage shows "submitted" indefinitely. Fix shape: `GET /api/scan/mine` (done scans
  for the account, server-side, Render auto-deploys) + restore-on-launch in the app + surface the worker verdict.
  This is the same listing the Ultra multi-car garage (#2) needs — build it once. **Do NOT re-render for him.**
  📣 **Olaf told 08:49 by iMessage from Jeff's phone** ("This is Claude (on Jeff's phone)…"): scan safe, re-upload cost
  nothing, reinstall wiped the phone's link, Garage will sit on "submitted" until the fix, nothing to do. Delivered
  Quietly (his notifications are silenced) — "Notify Anyway" NOT pressed. He had asked "I fucked it didn't I?" at 08:44.
- 💬 **Crew chat read 08:5x:** Say Phin 08:33 "I tap every update" · Jeff 08:35 "android 75 failed so technically
  you're on 76… next build 77 for both" · **Victor 08:42/08:45: "When I use the AA do I need to have the app turn on
  on the phone… it's lack of [if] I don't turn on the app"** · Say Phin 08:44 "app on phone screen shows the avatar on
  the AA screen". VERIFIED against Victor's rows: he is **still on build 74 (1.26.0)** — opened the phone app 08:40 and
  08:49 while asking; his 09-03 03:23 AA session started COLD from the head unit (first row `aa-crumb template-set`,
  no phone-surface row before it) and the car surface drew every ~10 s for the whole 7-min drive at 100–129 km/h
  while the phone app cycled background/active (`heat-probe app=ababa`). So on 74: AA starts without the phone
  app open and keeps drawing with it backgrounded. What he saw is not in the rows — first step is install 76.
  HYPOTHESIS, unasserted: Android may keep a freshly installed/updated app off the AA launcher until it has been
  opened once ("stopped state"); if AA shows no tile after 76, open the app once, reconnect.
- ✅ **OTA-D SHIPPED 08:48 PDT — NOSE LEAD-IN ON (drive 2) — group `c92db159-7f94-4b2c-8643-f46713205fdc`, runtime
  1.27.0, both platforms, commit `1018035`.** Proof: `ios KEY_PRESENT=1 openweathermap=2 neg_control=0` · `android
  KEY_PRESENT=1 openweathermap=2 neg_control=0`. `NOSE_LEAD_IN_ENABLED=true`: camera heading trails the car (700 ms,
  ≤25° lead) + curve-tangent nose (`bearingSmooth`). `REROUTE_ORIGIN_BEARING` still false (drive 3). **Verdict rows:**
  `cam-probe hdg=` vs `ch=` — a lead of up to 25° through turns, never more; `draw-cmp hdg=` vs `rb=` sweeping through
  bends instead of stepping. Feel to report: the nose visibly turns into the corner before the map follows.
- ✅ **OTA-E SHIPPED 10:31 PDT — group `a1fd5e74-deaa-4c6e-848d-64a5a15f0439`, commit `4a8ec72`, KEY_PRESENT=1 both — SELF-CAR SIZE ROOT-CAUSED → per-tick scale (Jeff: "SHIP IT").** Sim-verified before publish: 14 km/h (z 17.0) and 122 km/h (z ≈13.4) draw the car at the identical pixel size. Jeff's 62 s
  CarPlay video (`IMG_7015.MOV`, 09:22:22) joined to `cam-probe`: the car's on-screen size grows ∝ 2^(z−⌊z⌋)
  between whole zooms and pops at each integer (z=17 at t≈5.5 s 180→110 px, z=18 at t≈10.5 s 165→95 px, then
  a straight 2× shrink 18.2→17.2). Mapbox evaluates a zoom-expression `model-scale` at the TILE's integer zoom
  (`mapbox-gl-js/3d-style/data/bucket/model_bucket.ts`, `evaluate(…, this.canonical)`). **OTA-C only slowed
  the swelling; it did not fix the flash.** Fix: `modelScaleForPoints()` computes the scale per tick from the
  applied camera zoom + the car's latitude and rides the SOURCE feature (`scl`, `modelScale: ['get','scl']`)
  exactly like the nose (`rot`). Sizes unchanged at whole zooms: phone 44 pt; CarPlay car 45 / arrow 33.5 /
  2D 26 (× uiScale on AA). Also in the bundle: the `cam-apply` receipt (map's ACTUAL center/zoom vs the
  request, ≤1 poll / 2 s, logs only on >15 m / >0.4 z divergence) and `cam-probe spd=` no longer stale.
  **Roundabout "blow-through" (09:22:37–49):** the car FOLLOWED the ribbon (8 fps frames); the MAP froze ~12 s
  while pushes were issued (heat-probe `cam == tick`, no `main-gap` ≥ 2 s) then caught up — a native non-apply,
  cause unknown; `cam-apply` is the check. Verdict rows next drive: no `cam-apply` rows through a roundabout =
  camera applied; car size constant across `cam-probe z=` changes (photo/video).
- ✅ **OTA-F SHIPPED 11:16 PDT — group `e59147ea-79d2-4931-99ea-8dc7c04ed094`, commit `7850992`, KEY_PRESENT=1 both — ROUTE LINE OFF THE CAR (Jeff: "the route line was overlapping the car marker… make sure this does not happen") + the gates (Jeff: "how can we gate all these changes so they do not come back?").**
  Sim-reproduced on the phone (iOS 27 sim, Xcode-MCP taps, `tools/sim-qc/`): at 54 km/h the cut sat 31 m
  ahead of the RAW projection but the faint casing glow reached the nose; on CarPlay (Jeff's 09:22 video) the
  solid line ended on the roof. Two structural causes removed: (1) the cut was `frac × partition.totalM` with
  `frac` from a projection onto the precision-5 nav polyline but applied to the dense `coordinates` partition —
  the lengths differ ~1%, i.e. tens of metres a few km in; (2) the eased fraction ran its own clock against the
  marker's ease. Now `routeRibbon.alongMOnPartition()` projects the DRAWN car (SelfCarModel's `drawPosOutRef`)
  onto the ribbon's own metres, windowed ±250 m, and the cut = that + lead (both surfaces). Readout on the sim:
  `lead:33m cut+33m lag:0m` (was cut+31). `TRIM_LEAD_DP` 48 → 60 so the glow halo clears the nose (measured
  faint green 3 pt ahead of the nose at 48). Receipt `ribbon-trim surf=phone|car snap= z= lead= cutAhead= lag=
  anchorOff= proj= fade=` every 15 s in nav — the CarPlay-specific cause (if any remains) shows up there.
  **Gates added:** `scripts/trap-check.py` (release gate, wired into the ship-ota skill + CLAUDE.md: textual
  signatures of the zoom-curve modelScale, per-tick layer-style writes, `Constants.nativeBuildVersion`, the
  foreign-polyline cut, a bare `eas update`) and `tools/sim-qc/` (park → search → drive the app's own route on
  the sim → `measure.py` PASS/FAIL on car size across zooms + nose→line gap). Debug toggle now shows a `TRIM`
  line (snap, zoom, lead, cut+, lag, proj, fade).
- ✅ **OTA-G SHIPPED 12:15 PDT — group `47fc82ed-9857-4f76-8ab7-66934662982d`, commit `103d32c`, KEY_PRESENT=1 both — DRIVE REPLAY (Jeff: "the Drive replay looking terrible, right now it doesn't even work").**
  Sim-reproduced (iOS 27 sim, injected trip = the app's own 7.4 km route, frames every second): (1) the head dot
  moved by VERTEX INDEX while the trail was revealed by LENGTH FRACTION (`lineTrimOffset`), so on the highway leg
  (km-long, few vertices) the dot raced to the exit hook while the trail was mid-highway, then crawled — never
  together; (2) the 12 s clock started on open, before the style/tiles loaded — the first seconds (on a cold phone
  the whole playback) ran on a blank grey map; (3) the trail was a per-frame `lineTrimOffset` STYLE write (the
  0x8BADF00D pattern) and the head a per-frame MarkerView. Rewrite (`src/components/TripPlayback.tsx`): head and
  trail parametrised in METRES on one GeoJSON source updated at 12 Hz, static layers (CircleLayer head), clock
  gated on `onDidFinishLoadingMap` with a "Loading map…" state, top speed in the header. Drives IS reachable
  (H logo menu → Drives; my first grep said otherwise — ugrep treats `(app)` as a group; escape it).
  **Not changed (needs Jeff's call):** the stored geometry is the PLANNED route polyline, not the driven track —
  "the way you actually went" needs on-device track recording during nav (snapped fixes every ~25 m, ≤10 kB/trip,
  never uploaded) and would also close "leaderboard misses free drives".
- ✅ **OTA-H SHIPPED 12:47 PDT — group `77883711-270c-43c4-8888-467fbcd8463a`, commit `2e87e8e`, KEY_PRESENT=1 both — ARRIVAL LINE TAIL (Jeff: "the scout voice was cut off when I arrived at work").**
  Receipts for the 09:25:15 arrival, ms-precise: the last instruction (45→50 chars after toSpeech) played 5994 ms,
  the arrival line "Here we are — work." (19 chars) queued with priority behind it and played 1652 ms, the redundant
  Mapbox "You have arrived" (16 chars) was rate-skipped, no `tts-cut`, the drain hold worked (`tts-arrival-hold` ×24).
  So the CLIP was not cut. Two things the receipts cannot see, both in `speakOne`/`drainTtsQueue`: (1) a volume
  FADE-OUT took the last 240 ms of EVERY clip to silence — on a 1.6 s arrival line that is the final syllable of the
  destination name (the fade-IN had the mirror bug, "the first word will be super quiet", and was shortened the same
  way); (2) `setIdleAudioMode()` fired on the same tick as `didJustFinish`, while a CarPlay/Bluetooth route still holds
  the tail in its buffer. Fix: fade-out 80 ms to 60 % (never silence), idle release deferred 350 ms
  (`_releaseIdleSoon`, cancelled when the next clip starts; also used by `resetSpeakGate`). HYPOTHESIS until Jeff's
  next arrival — the receipts already say "played to completion", so the verdict is his ear: the destination name
  should now finish cleanly.
- ✅ **OTA-I SHIPPED 13:19 PDT — group `7857b5d5-c5c1-4a85-8171-8b5b188c417e`, commit `8c2c955`, KEY_PRESENT=1 both — UX batch (Jeff, 2026-09-03 afternoon): darker route chips + stop pills · pin-first Add stop · scanned
  peers drawn as their 3D twin · hero-shot avatars.**
  (1) `routeOptChip` / `PillFill` now smoked glass (`rgba(6,8,12,0.58–0.92)`) instead of the faint white lift / graphite.
  (2) "Add stop" arms `stopPinMode`: the Drive card drops, a banner says *Tap the map to drop your stop* with
  **Search instead** / **Cancel**; the next single tap on the map appends the stop through the SAME `setStops` line the
  long-press and double-tap use (build-74 visited-stops invariant intact).
  (3) Presence carries `scanId` while `carScanStatus === 'ready'`; `PeerScanModels` (ConvoyMapbox, shared with
  CarMapView) draws every scanned peer from ONE source + ONE ModelLayer — data-driven `model-id`, per-feature
  `rot`/`scl` (modelScaleForPoints at the live zoom), `<Models>` keyed on the scan-id set; sprites stay for everyone
  else; tap → the peer sheet via ShapeSource onPress. CarPlay: same component, scanned peers removed from the sprite
  symbol source. ⚠ Not sim-verifiable (needs a second account with a finished scan) — field verdict: Olaf's twin on
  Jeff's map + CarPlay; watch `heat-probe` on drives with scanned peers (one GLB per scanned peer, ~2 MB each).
  (4) Hero SHOT: the pipeline makes GLBs only, so the PHONE takes the picture — CarHero3D's model-viewer snapshots
  itself after `load` (`toDataURL` JPEG → postMessage), the Garage uploads it ONCE per scan to
  `car-scans/<scanId>/hero.jpg` (insert-only, `carScanHeroShotId` remembers), and a new storage policy
  `car_scans_hero_anon_select` grants anon SELECT on exactly `*/hero.jpg` (photos stay private). MemberCarousel
  (Crew / "Drive to a friend") shows it via the authenticated object endpoint with the anon key in headers, sprite
  fallback on error. Testers see each other's hero shots once each has opened their Garage on this build.
- ✅ **OTA-J SHIPPED 13:58 PDT — group `5bf509e6-6fb5-4790-82e2-3e6ec892727b`, commit `ce6912b`, KEY_PRESENT=1 both — scan id
  through the BACKEND + Rodrigo's two items (Jeff, 2026-09-03 afternoon).**
  (1) `car_scan_id` on the profile: backend `0b928d5` (`CarUpdate`, `public_user`/`peer_user`, `members_users`,
  user search, event attendees — verified live via `/openapi.json`). The phone PUTs it once per scan
  (`syncScanIdToBackend`, `src/carScan.ts`; remembered in `carScanBackendId`, marked done only when the backend
  ECHOES the id) from the Garage on delivery and from map.tsx on launch (Olaf's scan predates the field);
  `navMembers.scanId = p?.scanId ?? m.car_scan_id`, so the Crew / "Drive to a friend" hero shot shows for
  OFFLINE members too.
  (2) Rodrigo's request — saved places reachable without scrolling: a SAVED chip row (Home, Work, custom) under the
  phone search field (`NavSearchScreen`); on CarPlay the Search button now opens a **"Where to?"** CPListTemplate
  of saved places FIRST, with "Search by name…" as the last row pushing the keyboard template (his head unit's
  keyboard covered the saved rows). The list shares the search flow's ownership flag (`_searchPushed`) so the
  motion pop / recovery / back-out rules are unchanged; AA untouched (its native search lists saved rows as `items`).
  (3) Rodrigo's issue — "phone compass changing directions randomly, CarPlay fine" (12:46–12:52, CarPlay connected,
  phone on the Show-map face). VERIFIED: `heat-probe inst=car#2:2417/2368,phone#3:2418/0` every minute — the
  phone's SelfCarModel ran ~2,400 rAF/min and pushed the camera **0 times** for 15 min (the lockstep never drove
  the phone; the car surface pushed nearly every frame). Drawn heading in `draw-cmp surf=phone` tracked GPS/route
  cleanly at 10 s samples; the phone's zoom DID move with speed (`ribbon-trim surf=phone z=17.00→18.28→…`), so
  something other than the lockstep drove that camera. **Which gate held `lockReadyRef` false is NOT on record** —
  shipped `cam-mode surf=phone view= hu= foll= lock= places= ready= lockstep= nav=` (once a minute + on change)
  and `phone-tap:show-map`. Next Rodrigo drive: `where handle='Rodrigo' and message like 'cam-mode%'` — the 0 is
  the answer. Do not guess it. Memory: `rodrigo-phone-compass-lockstep-off.md`.
  ⚠ Verified: typecheck, trap-check (0 hits), KEY_PRESENT both platforms. NOT sim-verified at ship time: the chips
  row (sim Release build running) and the CarPlay list (CarPlay sim blocked by the iOS-26 share crash) — field
  verdict from Rodrigo / Jeff.
- ✅ **OTA-K SHIPPED 14:05 PDT — group `47a9aa95-64fc-414f-beb0-304a4c39eebf`, commit `542e9cb`, KEY_PRESENT=1 both — phone
  compass tap TOGGLES north-up; CarPlay "Where to?" keyboard row first (Jeff's clarification of Rodrigo's two items).**
  (1) Jeff: "the compass shows north but it's going right/left" = a NORTH-UP map (the needle rotates by `-mapHeading`).
  The phone compass FAB was ONE-WAY: every tap armed `northUpHold`, released only by a manual pan or a new route — a
  recenter tap mid-drive pinned the map north for the rest of the drive, and the lockstep feed went to 0 (exactly
  Rodrigo's `heat-probe phone#3:2418/0`). CarPlay's compass already toggled ("holding north-up until tapped again"),
  hence "CarPlay was fine". **Sim-verified both ways** (iOS 27 sim, Release build, guidance active): pre-fix one tap →
  `HDG mode:north_up feed:0`, second tap still north_up; post-fix tap 1 → north_up, tap 2 → `heading_up feed:360`.
  Receipt `phone-tap:compass hold=0|1`. ⚠ Still a HYPOTHESIS that Rodrigo tapped it rather than having North-up in
  Settings → Map view — the OTA-J `cam-mode` row at route start settles it (`view=north_up` from the start = the setting).
  (2) Jeff: "keyboard hidden when tapping Search on CarPlay, invoke it to type" — that is the OTA-J list; now
  "Type a place…" is ROW 0 (one tap however long the saved list) and the saved-places cap is 30 (Rodrigo has lots).
  AA untouched (its native search template lists saved rows under the search bar; `showKeyboardByDefault` stays true —
  candidate follow-up: false on the first push, true on keystroke refreshes).
- 📊 **JEFF'S 15:37–15:45 DRIVE (OTA-K `01a06910`, CarPlay connected 15:37:20) — read 16:05.** Jeff: "first corner was
  off the road, otherwise good, Scout arrival was good."
  · **Scout arrival — PASS (his ear + receipts):** `arrive-speak 15:45:30.456` → `tts-play len=30` → 24 `tts-arrival-hold`
  rows → `tts-done ms=5807`, no `tts-cut`. OTA-H's fade/idle-release fix is field-confirmed. Resolved.
  · **Backwards start, twice:** `depart-rank n=2 facing=141 chosenBr=346 off=155` (15:37:24) → `off-route tripped d=49m
  … step=0` 8 s later → `reroute-result id=1 age=0s bearing=-` → new route ahead (`turn=39m`). Second route 15:40:55:
  `facing=182 chosenBr=61 off=121`. Rodrigo's 12:45 start: `off=147`. With n=2 and the 75° forward gate, both candidates
  were judged non-forward — the crumb could not say whether a forward option EXISTED and lost. **OTA-L adds `cands=`**
  (every candidate's bearing/duration). `bearings=` is measured to do nothing (departureBearing.ts header) — do not
  re-try it; OTA-B's flag stays OFF until `cands=` says what the responses hold.
  · **First corner:** 10 s `draw-cmp` samples show the car ON the line at 15:37:41 (d=4.5 m) and 15:37:51 (d=1.7 m, hdg 61)
  either side of the left turn — the sampling cannot see a 2–3 s excursion; the reroute at 15:37:32 landed 13 s before
  that corner. At the second corner (right, 15:38:06–12) a `main-gap dt=3947 surface=car` ended at 15:38:05 with the car
  at 7 km/h (`hdg=57 gpsHdg=89`, drawn heading 32° behind GPS) — the loop-idle caveat applies at crawl, so it is NOT
  evidence of a freeze. **Asked Jeff which corner and whether it was the car or the line.** No `cam-apply surf=car` rows
  all drive (camera applied everywhere); the 36 s `main-gap` at 15:44:23 was a 30 s stop (`spotAge=30s`) = idle.
  · Olaf (Enablewhore) was live 15:10–15:52 on the 08:42 bundle `01a067ea` (pre-OTA-I, no presence scanId) → the peer
  twin could not show yet; he has not tapped the pill since 08:42.
- ✅ **OTA-L SHIPPED 16:12 PDT — group `7b31cdef-6c43-4458-a52f-ff84c0d9e3f7`, commit `0a050e2`, KEY_PRESENT=1 both —
  `depart-rank … cands=<bearing/duration,…>` on both the phone and CarPlay route picks. Instrumentation only.**
- ✅ **OTA-M SHIPPED 16:24 PDT — group `9ecf38bf-47be-46fd-9ee0-28788294cc40`, commit `c1d476d`, KEY_PRESENT=1 both —
  `corner-trace` + `snap-mode` receipts (instrumentation only).** Jeff clarified 16:15: two drives back to back; DRIVE 1
  (15:37, the long "home" route he ended at 15:39:53) is the one whose **first corner had the car marker off the route
  line by a lot**. The 10 s `draw-cmp` cadence straddled it (4.5 m / 1.7 m either side, nothing inside), so this is a
  sampling hole, not a verdict. Now, in guidance: a GPS-course swing ≥ 30° within ~3 s arms ≤ 5 `corner-trace` rows at
  ≥ 1 s (d/sep/mode/spd/raw/drawn/hdg), re-armed after 15 s; every snap-mode change logs once (`snap-mode surf= from= to=
  d=` — route→raw at a corner = the snap dropped). Shared `reportDraw` hook (`src/drawTelemetry.ts`), both surfaces.
  **Next drive over that first corner answers it.** Olaf told to tap the pill (still on `01a067ea` at 16:10).
- ✅ **OTA-N SHIPPED 16:36 PDT — group `029d238b-daca-4b53-948f-969c37500188`, commit `eaa03e2`, KEY_PRESENT=1 both — THE
  DESTINATION PIN IS THE ARRIVAL WEATHER (Jeff: "change the green pin to the weather for that destination… I like the
  size and how it floats on the 3D map… border the skin colour, green/silver/gold").**
  `tools/wx-pin/bake.py` bakes 30 pins (brand/premium/ultra × none + 9 WeatherKinds) and 3 temperature pills from the
  brand pin's OWN alpha (eroded band → the tier gradient outline, dark-glass body, head disc + Ionicons/MCI two-tone
  glyph matching `WeatherGlyph`) into a `wxPinImages` module as data URIs (2×, 305 KB base64; bundle 5.09 → 5.41 MB) — **superseded the same hour by OTA-O below; that module is deleted.**
  Data URIs on purpose: OTA-able (no asset path-key trap) and pixel-identical on both surfaces. Phone:
  `DestinationWeatherPin` (MarkerView 34×44, bottom-anchored — the float) replaces the green pin AND retires the chip
  that floated above it; the ETA-matched temperature (`destWeather`, weather layer ON) hangs in a skin-bordered pill
  beside the head; no weather = the clean skin-ringed pin. CarPlay: `carStore.waypoints` dest entry carries
  `wx`/`temp`; `car-waypoint-pins` picks `['get','icon']` (+ `isz` for the 2× bake), new `car-waypoint-temp` layer =
  pill + white reading translated 37.25 pt right / 29.5 pt up of the anchor. **Android Auto keeps `brand_pin`**
  (`WX_PIN_ON_CAR = Platform.OS === 'ios'`): data-URI symbol images on the AA canvas are unverified and a failed decode
  would draw NO end pin — flip after one verified AA connect. **Sim-verified (phone, iOS 27, key-in-build):** gold rim
  on the Ultra skin, cloud glyph, "20°" pill, tip on the place. CarPlay not sim-verifiable — field verdict.
- ✅ **OTA-O SHIPPED 17:08 PDT — group `2a6a7151-0a23-444e-bf4a-5dd838ac9cfd`, commit `d743252`, KEY_PRESENT=1 both — THE
  DESTINATION MARKER IS THE ARRIVAL-WEATHER CALLOUT (replaces the OTA-N pin).** Jeff on OTA-N: "no thats not what i want,
  moving forward before pushing UX stuff give me a example to visualize before submitting" → rule saved
  (memory `preview-ux-before-shipping`): mockup sheet + in-context composite (`tools/wx-pin/mock_callout.py`), his OK,
  THEN code. Approved design: rounded box 70×34 pt, radius 10, dark glass 75%, **1.5 pt tier-gradient border**, 8 pt
  tail whose tip is the destination, two-tone glyph + live temperature (white 14 pt bold at the baked slot x=38 / cy=17);
  **weather off / no forecast = the flag** (Jeff's call). `tools/wx-pin/bake.py` → `src/wxCalloutImages.ts` (30 images
  @2×, ~96 KB; the OTA-N `wxPinImages.ts` is gone). Phone `DestinationWeatherCallout` (MarkerView, bottom-anchored float);
  CarPlay `wxcallout_<kind>` per skin at iconSize 0.5 + `car-waypoint-temp` text layer; **AA keeps `brand_pin`**
  (`WX_PIN_ON_CAR`). Sim-verified with a real forecast: gold border on the Ultra skin, partly-night glyph, 19°, tail on
  the spot — screenshot sent to Jeff before publishing. **CarPlay field verdict (Jeff, ~17:40, CarPlay-connected drive): "the CarPlay icon, perfect size, everything is perfect."** Resolved on both surfaces (AA still gated).
- ✅ **OTA-P SHIPPED 18:03 PDT — group `5691f91a-cfda-4691-a2ac-1091d47fae94`, commit `213204f`, KEY_PRESENT=1 both — phone
  self car 44 → 50 pt; "Show map" WARM-MOUNT COVER.** Jeff, CarPlay-connected drive ~17:40: "the CarPlay icon, perfect
  size, everything is perfect" · "on the phone when I switch over to the map, the car needs to be a little bit bigger"
  (→ `SELF_MARKER_PT` 50, CarPlay keeps 45; before/after sim renders sent, 56 offered) · "when I go from the turn-by-turn
  directions on the phone and hit Show map, it's orientated completely wrong, and then it snaps to the correct chase cam
  — get rid of that weird in-between." **Cause (his own 15:38:26 rows):** the phone map is UNMOUNTED on the
  written-directions face (8/16 heat decision), so Show map mounts it cold mid-drive — frame 0 = `defaultSettings`
  (north-up, z17), the 1.2 s cold-lock timer holds the lockstep off (`cam-mode lock=0 ready=0` → 1 s later `lockstep=1`),
  then the first push lands the chase pose in one jump (`cam-apply dz=0.96`). **Fix (ConvoyMapbox `warmMountRef`):** a
  mount during guidance waits 250 ms for the cold lock (the 1.2 s exists for the native follow fly-in, which heading-up
  never uses) and sits under an opaque `#0B0D10` cover until SelfCarModel's FIRST lockstep push (`onFirstCam`), then fades
  220 ms; hard safety lift at 1 s. ⚠ Not reproducible on the sim (needs CarPlay connected) — normal launch verified
  unaffected (no cover at a non-nav mount). Field verdict = Jeff's next Show-map tap: the map should appear already in the
  chase pose, ~0.3 s after the tap.
- 📊 **JEFF'S DRIVE HOME 17:28–18:05 (OTA-O `01a069ba`, CarPlay connected) — read 18:20.** Jeff: "the exit off the
  highway was glitching and the route line was overlapping for a bit, and the turn into the parking lot was wide."
  · **Exit = corner-zoom yo-yo (VERIFIED, cam-probe 1 Hz):** zoom climbed 16.2→18.1 for the exit-gore maneuver
  (`zt=18.50`, `turn=138m` at 18:02:27); the step advanced at ~18:02:34 with the NEXT maneuver 483 m away (car-strip
  `step=3/7 turn=483m` at 18:02:36) → target dropped to the 76 km/h speed zoom (`zt=14.92`) → the camera glided OUT
  18.1→15.4 over 7 s → at 280 m from the ramp's end-turn (18:02:49) the corner zoom re-armed and it climbed back to 18.5
  by 18:03:02 while the actual ramp curve ran 18:02:59–18:03:15. In, out, in, through one exit. "Line overlapping for a
  bit" is a HYPOTHESIS tied to that zoom-out window (ribbon-trim at 18:02:37/52 shows lag 1–2 m, cut 25–40 m ahead —
  the 15 s sampling cannot see inside it).
  · **Parking-lot turn = route-snap geometry (VERIFIED, corner-trace):** `i=1 mode=route d=15.9m sep=16m spd=24 hdg=124
  gpsHdg=136 rb=159` — the marker followed the polyline's wide arc while the car cut inside, 16 m apart for ~1 s, then
  4.5 m on the lot road.
  · **Backwards start, with the new `cands=` receipt:** `depart-rank n=2 facing=null chosenBr=351 off=-1
  cands=351/2361s,351/2599s` → the compass sample was null AND both Mapbox candidates departed 351°; off-route 73 m in
  33 s → reroute. Not the ranker: Mapbox offered no forward option at that origin.
  · Show-map wrong pose reproduced once more pre-OTA-P (`phone-tap:show-map` 17:51:29 → `cam-apply surf=phone dz=1.65`,
  then `dM=9480` at 17:51:51 — the phone camera 9.5 km off the request for a moment).
- ✅ **OTA-Q SHIPPED 18:36 PDT — group `17366001-2b5a-410f-8788-302ab0f5fc57`, commit `676cae5`, KEY_PRESENT=1 both —
  CORNER-ZOOM HOLD THROUGH CHAINED MANEUVERS + CORNER RELEASE for the drawn car (both surfaces).** From the drive-home
  read above. (1) `chaseZoom(kmh, distToManeuverM, curStepLenM)`: a current step ≤ `CORNER_CHAIN_M` (550 m) holds
  `CORNER_ZOOM` for its whole length — an exit is a gore maneuver + a short ramp step, which is exactly the in/out/in.
  Phone `currentStepLenM` (map.tsx, `activeRoute.steps[tbt.stepIndex].distance_m`); CarPlay `carStore.stepLengthM` (written
  with `distanceToTurnM` in ConvoyCarPlay). Accepted trade-off: short city blocks between turns also hold 18.5.
  (2) `src/cornerBlend.ts`: while the GPS course swings ≥ 12°/s AND the route projection is > 6 m off, the drawn position
  blends toward the raw fix (fully raw at 16 m), eased 250 ms in / 700 ms out, nose on the raw course past 0.5 — straights
  stay glued (a divided highway holds `proj=35` for minutes with a stable heading). Phone `cornerK` at `selfDraw`, car
  `carCornerK` at `drawLat/Lng` + `drawHdg`. Receipts: `corner-trace` (d should fall toward raw inside corners), `cam-probe
  zt` (held at 18.5 across short steps). **Sim smoke drive (iOS 27, key-in-build):** guidance, snap and chase camera healthy;
  the sim's straight-line waypoints diverge from the road (d 12→55 m, a reroute) so the blend never engages there —
  `measure.py` also FAILS on the dusk style (its car detector assumes the day palette; run it in daylight or fix the
  detector). **Field verdict = Jeff's next exit + lot entrance.**
- ✅ **EVENT INVITES — OTA-R SHIPPED 21:41 PDT (Jeff: "go ship it") — group `692446cf-8a08-465d-81a4-9570a034ed96`, commit
  `12401fd`, KEY_PRESENT=1 both; backend `8030769` + `05435a7` live; `OPENWEATHER_API_KEY` SET on Render by Jeff 21:30
  (`GET /api/health` → `weather_key: true`).** Jeff: "I created a meet event but I want to push the meet to the crew." VERIFIED:
  the only push was at creation, only with Public OFF (the club picker was gated on it) + Notify ON; no re-send existed;
  editing never notified. His spec: owner + club admins manage; a club can be tagged EVEN IF PUBLIC and the whole crew gets
  "you have been invited to the 'Boba Tea Meet'" → tap opens the event page → Going / Not going → 24h and ~2h follow-ups
  with the weather at the meet (24h = weather + "still attending?"; 2h = who's going + weather + "take me there").
  · Backend: `_push_event_invite` (used on save AND by `POST /events/{eid}/announce`, creator or club admin, 10-min
  throttle), `POST /events/{eid}/decline` (remembered; invites skip decliners), `can_manage`/`is_declined` on the
  serializer, `PUT /events/{eid}` open to club admins, `_venue_weather_line` (OpenWeather 3-hour forecast at the venue
  nearest the start; **needs `OPENWEATHER_API_KEY` on Render** — same value as `EXPO_PUBLIC_OPENWEATHER_KEY`; silently
  omitted until set). Invite copy: "🏁 You're invited to \"<title>\"" / "🛣️ You're invited to the \"<title>\" cruise" ·
  "<host> · Sat Sep 6, 8:00 PM at <venue>. Tap to say if you're going." 24h: "<wx> at the meet. Still attending? Tap to
  confirm." 2h: "<n> going · <wx> · [⛽ Fill up before you arrive ·] Tap to take me to <venue>" (tap = route).
  · App (`src/hubEvents.tsx`, `src/eventsApi.ts`): "Invite your club" chips always shown (Public only sets discovery);
  Going (= attend+confirm) / Not going (decline) replace the interested→confirm two-step; "Send the invite to the club"
  for creator/admins; Edit/Delete for admins. Notification taps already route `open`/`confirm` to `/(app)/hub?event=`.
  · Sim-verified: form (chip + copy) and the Boba Meet page (Going / Not going / Send the invite / Edit). Screenshots sent.
- ✅ **OTA-S SHIPPED 21:58 PDT — group `6f2a2940-bb93-4c7b-99c8-8fb4dc56840a`, commit `7ca906e`, KEY_PRESENT=1 both —
  "Post a meet" beside "Plan a cruise" on the Hub's empty next-up card (Jeff: "maybe put in the club card beside plan a
  cruise put plan a event button too"). Same pill style, same labels as the + sheet; both open the create sheet with the
  right kind. Only shows while nothing is upcoming (with an event the card shows You're in / Details). Mock sent first.
- ✅ **OTA-T SHIPPED 22:06 PDT — group `cb6d6fa4-472b-48cb-ac8f-70c1622cca3a`, commit `fedb7ec`, KEY_PRESENT=1 both —
  CORNER RELEASE reworked after CODEX's first second-opinion pass.** Codex (codex-cli 0.153.2, `codex@openai-codex`
  plugin, Jeff's ChatGPT sign-in 21:53 — second opinion ONLY, never `--write`) read `src/cornerBlend.ts` and found two
  real flaws in the OTA-Q version, both verified by re-reading the code: (1) the rate was recomputed on every call ≥150 ms
  apart while the course only changes per GPS fix (~1 Hz) — unchanged frames decayed it and the next fix was measured
  over ~150 ms instead of ~1 s, so a 4° jitter read as 27°/s: enough to release a car 35 m off a divided-highway line
  (the exact regression the design tried to avoid); (2) the 0.5 EMA halved the first swing, so a short lot-entrance turn
  could sit under threshold. Fix: a sample counts only when the course changes ≥3°, rate = Δ over the real gap between
  distinct samples (floor 0.25 s, cap 3 s), held 1.5 s instead of decaying, no EMA; easing constants named as
  exponential time constants (Codex's third, cosmetic, point). **New numeric gate** `tools/sim-qc/corner_blend_test.mts`
  (`node --experimental-strip-types …`): highway jitter 0 · 4° step 0 · lot swing 16 m → 1.0 · lot swing 4 m → 0. The sim
  cannot cut corners, so this is the only automated check of that logic. Field verdict unchanged: Jeff's next lot entrance.
  Codex usage: `/codex:review`, `/codex:adversarial-review <focus>`, `/codex:rescue` (no `--write`); stop-time gate OFF.
- 🟡 **OTA-V READY, NOT PUBLISHED (needs Jeff's go) — commit `0f67a89` — a reinstall no longer loses the scan;
  a dead upload stops the countdown.** Olaf's 09-03 reinstall wiped `carScanId` (AsyncStorage only) and his Garage
  sat on "submitted" for a re-upload the worker had failed on `user-cap`, while his finished twin
  (`enablewhore-20260901-210315`, `done`, both GLBs in `models`) sat untouched. Now `reconcileScanState()`
  (`src/carScan.ts`) runs once per launch (map.tsx, next to the profile sync) and on every Garage refresh: it asks
  `GET /scan/mine` and restores the newest `done` scan whose GLBs HEAD OK (settings + `carscan-restored` crumb; the
  profile sync then PUTs the id once), or flips a polled scan the worker marked `failed`/`skipped` to
  `carScanStatus:'failed'` (`carscan-verdict` crumb) — the Garage then shows the invitation again (no "failed"
  copy yet: that is a UX change and needs a mockup OK first). **Sim-verified 23:11 PDT on the iOS 27 sim with Jeff's
  account:** pointer wiped → launch → settings read back `ready` + both URLs + `carScanBackendId`, crumb
  `carscan-restored id=jeff-20260902-193844 from=none`. Failed case (phone pointed at a fake `failed` job, account
  also owns a done scan = Olaf's exact situation): the done twin wins → `carscan-restored … from=submitted`, countdown
  gone. The pure "failed and nothing done" branch is code-verified only (no such account to run it on).
  **Backend:** `GET /api/scan/mine` (`~/convoy-backend` `03be1cb`, live) = Mongo `scan_slots` ids + Supabase
  `car_scan_jobs` by handle through the anon-key RPC `scan_jobs_for_handle` (migration applied), because —
  **⛔ VERIFIED: the Render deploy has NO Supabase service-role key** (`/api/health` → `"supabase":false`). Every
  `supabase_admin` helper is a silent no-op in production: hazards + communities mirrors, community routes, and the
  **scan-slot mirror** — with `pipeline_flags.require_slot=true` (since 09-03) the worker will `skip("slot-required")`
  every NEW upload (Supabase `scan_slots` holds one `qa` row). Nobody has hit it yet. Fix = Jeff sets `SUPABASE_URL` +
  `SUPABASE_SERVICE_ROLE_KEY` on Render (never through me) → `supabase:true`; or `require_slot=false` meanwhile.
  Trap met: `re` was only imported inside one function → the first deploy 500'd (`carscan-reconcile-fail` crumbs at
  23:04/23:05 prove the app-side failure path too). Codex second opinion on the pipeline → `SCAN-PIPELINE.md`
  "Second opinion" (7 verified findings, 7 hypotheses, none adopted tonight).
- ✅ **OTA-U SHIPPED 22:52 PDT — group `b97a211d-4ce3-447c-91ad-876333192c16`, commit `5f9bb6f`, KEY_PRESENT=1 both — map
  HUD pinned to factory text size + CarPlay banner inset scales with head-unit width.**
  (1) **Olaf's "bigger" HUD** (Jeff's two screenshots, measured: chip frames + status clock identical, HUD text ~1.3×) =
  iOS Text Size; Olaf confirmed by iMessage his slider was at max. Jeff: "yes lets cap it" / told Olaf "stuck at
  factory". `maxFontSizeMultiplier={1}` on the glanceable HUD only (WeatherHUD, TurnByTurnNav, DestinationSearch +
  TextInput `allowFontScaling={false}`, UpdateReadyPill, CategoryPills, 18 fab/banner/pill/step Texts in map.tsx, tab
  labels incl. the custom Comms label). Sheets/lists/settings/search results keep Dynamic Type. Sim-verified at the max
  content size (`xcrun simctl ui <udid> content_size extra-extra-extra-large`) — before/after sent to Jeff.
  (2) **Alfred's Toyota Sienna** (handle `GRSIENNA`, `car-viewport surf=775x291`; WhatsApp photo 2026-09-02 17:20): the
  maneuver banner's right end ran UNDER iOS's crew/compass map buttons — the 48 pt inset was measured on a 470-wide
  canvas and iOS draws a larger glass button column on the wide screen. `carRightInsetFor(surfaceW)`: 48 × width/470
  above 470 (unchanged 400/427/470; 79 on the Sienna), capped at 96. Receipt `car-chrome surf= rightInset=` once per
  w×h. ⚠ HYPOTHESIS from one photo — the native answer (`CPWindow.mapButtonSafeAreaLayoutGuide`) is a build-77 item.
  Verdict = Alfred's next photo with the receipt row.
  **Codex adversarial review before shipping** (`/codex:adversarial-review`, verdict needs-attention): three findings
  acted on — the first text cap had spilled into map.tsx sheets/settings rows (narrowed to HUD styles), the custom Comms
  tab label was uncapped (fixed), the receipt could spam on width oscillation (deduped). Two kept as known limits: the
  width-only inset model (capped, receipted) and the tight-canvas branch on portrait canvases (those rows are the phone
  window mis-reported, not head units).
- ✅ **OTA-E SHIPPED 08:37 PDT on Jeff's "ship it" — group `c59b50b9-82c4-4fba-a1f4-47f1fdcfc0c9`, runtime 1.27.0,
  both platforms, commit `323d12d`.** Proof: `ios KEY_PRESENT=1 openweathermap=2 neg_control=0` · `android
  KEY_PRESENT=1 openweathermap=2 neg_control=0`. Contents: arrival-speech fix (`43b901c`) + one shared build number on
  the pill (`8f34f98`/`db8cc25`). Flags still OFF (`NOSE_LEAD_IN_ENABLED`, `REROUTE_ORIGIN_BEARING`). **Verdict rows:**
  `arrive-speak` → `tts-say/tts-play/tts-done` for the arrival line and NO `tts-cut` at arrival; `tts-arrival-hold`
  may appear (that's the drain working); `tts-skip why=rate` now names anything else the gate drops.
- 🔧 **OTA-E (was: STAGED at HEAD (`43b901c`, live code, UNPUBLISHED) — the arrival-speech fix):** arrival line chosen +
  prefetched at the "you will arrive" callout (`prefetchArrivalLine`), spoken past the 1.5 s rate gate
  (`speak(line, {priority:true})`), and `resetSpeakGate()` defers up to 8 s while an arrival drains
  (`tts-arrival-hold` rows). `stopSpeech()` (Clear / new route) still hard-stops. New crumb `tts-skip why=rate`
  for anything else the gate drops. **Verdict = the same rows:** `arrive-speak` → `tts-say/play/done` for the
  arrival line, no `tts-cut` at arrival. Audio-only; independent of the camera/nose verdicts, so it can ride
  the next publish alongside one flag flip. HEAD also carries the pill fix `db8cc25` (unpublished).
- 🐛 **"v75" on Android — ROOT-CAUSED + FIXED `db8cc25` (rides the next OTA):** `Constants.nativeBuildVersion` was
  REMOVED from expo-constants (SDK 54 CHANGELOG, PR #26329) → undefined on both platforms → the pill, the
  update gate and the push roster all fell through to the **iOS** `buildNumber`. Android showed 75 on a 76
  binary; the roster's `build_number` has been empty since the SDK bump. `src/buildNumber.ts` prefers
  expo-application's `nativeBuildVersion`, then the running platform's own app.json number — **for telemetry only.**
  **Jeff's call (09-03 08:3x): the PILL shows ONE number on both platforms** ("too confusing if they are mismatched")
  → `8f34f98` `releaseBuildNumber()` (iOS buildNumber by convention) drives the pill + update gate; Android keeps
  saying **75** for this release ON PURPOSE. The honesty rule is upstream: builds are cut at the same number (77
  on both next). Replied to Say Phin 08:18 (he is on 76 and already on `7abe6a20` — his pill's `03·0806` proves it)
  — ⚠ that reply promised "Android shows its own number next update"; **corrected in the group 08:30** (one shared number, 75 this release, builds cut together from now on).
- ✅ **Android Auto on 76 (targetSdk 36) — FIELD-PASSED:** Say Phin 07:19:05 `aa-crumb root-mount/root-render/
  template-set/surface-render`, canvas 213x107dp, drove to `arrive-speak` 07:36:04, no fatals. His words: "Uneventful
  drive, nothing to report." `main-gap app=ba sinceApp=40823` at 07:19:48 shows the new discriminator working.
- **`7abe6a20` pickups by 08:18:** Enablewhore (iOS), SPL_GRC (Android). Drive-1 verdict comes from their next drives.
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

- **BUILD 77 (next native cut, BOTH platforms at the same number) — CarPlay layout guide (Jeff, 2026-09-03: "Add the
  CarPlay Layout Guide to Build seventy seven").** Read `CPWindow.mapButtonSafeAreaLayoutGuide` (CPWindow.h:18) in the
  CarPlay scene / react-native-carplay patch and push the chrome-free rect (top nav bar + trailing map-button column) into
  `carStore` as `chromeInsets {top,right,bottom,left}`; `ConvoyCarPlay` then anchors the nav stack, speed cluster and
  crew pill to REAL insets and retires the measured constants (`CAR_RIGHT_INSET` 48, the 775-wide stopgap
  `carRightInsetFor`, `CAR_BAR_*`). Why: Alfred's Sienna (775×291) put the banner under the crew/compass buttons; every
  unit we have not seen is the same risk. Verify on the CarPlay sim at 400×240 and a wide preset, then Alfred's photo.
  Also on the 77 list from 75/76: RevenueCat, widgets + watchOS, `Screen.setMarker` patch, AA `isConnected` getter,
  self-heal A1. `buildNumber` and `versionCode` move together to 77.

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
