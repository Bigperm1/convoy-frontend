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

**Written 2026-08-22.** Every number below was queried live from EAS / git / the Supabase bucket
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

## 1 · Shipped state — VERIFIED 2026-08-22

| | value |
|---|---|
| **Build** | **73** (iOS build number 73 · Android versionCode 73) |
| **runtimeVersion** | **1.25.0** |
| **version** | 3.9.0 |
| **channel** | `mapbox-migration` |
| **cut from commit** | `dd789bd` |
| **cut** | 2026-08-15 — iOS 15:33, Android 15:39 |
| **status** | finished, both platforms |

**Runtime parity holds.** iOS 73 and Android 73 are both at runtime **1.25.0**, and that matches
`app.json`. An OTA to `--branch mapbox-migration` reaches both platforms. This is the rule that
stranded Android for six OTAs on 2026-07-06 — it is currently satisfied.

Receipts: `npx eas build:list --platform ios|android` — iOS id `03312faa-a709-4cd0-97a0-1d109104b485`,
Android id `a9722059-4116-46b2-8a16-c7b154101c49`; `app.json` lines 5/11/15/40.

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

## 2 · OTA position — VERIFIED

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

## 4 · Build 74 — NOT CUT. What it must carry.

**Verified: build 74 does not exist on either platform.** The newest row on both listings is 73.

74 is the next **native** build, so everything native queues into it. Bumping `runtimeVersion` for
it means **both platforms must be cut in the same batch** or the unbuilt one is stranded from every
later OTA.

Native payload for 74:

- **RevenueCat SDK** — a native module, cannot ride an OTA. Gates the whole monetization sequence.
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
