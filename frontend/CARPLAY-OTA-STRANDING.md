# CarPlay-first launches strand testers off OTAs

**Status:** root-caused with source citations, 2026-08-28. Fix is split OTA-able / build-bound.
**Owner:** next native build. **Field cost so far:** one tester cut off for 2+ days.

---

## The symptom

A tester force-quits and reopens the app **while plugged into CarPlay**, and the new process
runs the EMBEDDED bundle with no update record: `launch_kind="unknown"`, `update_id=null`.
The downloaded OTA is never applied, and **the red pill cannot appear**, so there is no
user-visible way out. Every later OTA is missed too.

### Field evidence (VERIFIED, Supabase `crash_reports`)

- `Enablewhore` — **3 `unknown` sessions, 1,519 rows, first 2026-08-27 12:58, still stranded
  2026-08-29 02:09.** Our heaviest CarPlay driver, and the only source of rAF-runaway data.
- `Ni GR` — one brief `unknown` session (2026-08-28 00:38). **Not tester-specific.**
- Two adjacent launches 15 s apart produced opposite outcomes — the race, caught in the act:
  - `01:49:09` → `launch_kind=ota`, real updateId, downloaded 358/358 assets,
    `didFinishBackgroundUpdateWithStatus=NewUpdateLoaded`, `isUpdatePending: true`
  - `01:49:24` → `launch_kind=unknown`, `update_id=null`, `NoUpdateAvailable`
- Both sessions open with `carplay-onconnect` — both CarPlay-first.
- The update downloads fine **on cellular**. Wi-Fi is a red herring.

---

## Mechanism (VERIFIED against node_modules)

**Phone-first can never hit this.** The `RCTHost` is created from inside
`appController(_:didStartWithSuccess:)`
(`expo-updates/ios/EXUpdates/ReactDelegateHandler/ExpoUpdatesReactDelegateHandler.swift:71-108`).
JS cannot start before the launcher exists — there is no race to lose.

**CarPlay-first creates the host itself.** `plugins/withConvoyCarPlay.js:375-413` polls
`rootViewFactory.value(forKey:"reactHost")` for 20 s, then on ceiling-hit mints the car surface
via `ExpoReactRootViewFactory.superView(...)`. That call resolves its bundle through
`[reactDelegate bundleURL] ?: [super bundleURL]`, and `launchAssetUrl()` is still nil, so it
lands on the embedded `main.jsbundle`. The host is now pinned to stale JS — **process-wide,
phone surface included.**

`StartupProcedure.swift:60-62` — `launcher` is assigned in exactly two places (`:154`
didFinishWithLauncher, `:103` emergencyLaunch). Until one runs, `launchedUpdate` and
`launchAssetUrl` are both nil.

`AppController.swift:71-89` — `updateId` is written into the constants map only
`if let launchedUpdate`. `isEmbeddedLaunch` requires a non-nil `launchedUpdate`, so it stays
false. That is precisely why the state reads `unknown` and not `embedded`.

### ⚠ Correction to an earlier claim of mine

I reported that `update_id` staying null all session **proved** expo-updates never resolved a
launcher, on the grounds that `baseMeta()` re-reads the module per log row. **That is wrong.**

- `expo-updates/build/Updates.js:22-24` — `updateId` is a **module-level const**, evaluated once
  when the module is first imported; `require()` returns the cached module.
- `expo-modules-core/ios/Core/Objects/ObjectDefinition.swift:90-92` — legacy `Constants { }`
  are installed as plain **frozen** JS properties, not live getters.

So a null `update_id` proves only that **the launcher was unresolved at the instant the JS
runtime built the ExpoUpdates module**. That is a weaker claim — but it is still exactly the
race, and it makes the diagnosis sharper, not softer: *JS started before the launcher resolved.*

### Why there is no way out once it happens

- `ExpoReactNativeFactory.swift:106` — `recreateRootView`'s only guard is a Swift `assert`,
  **compiled out under `-O`**, i.e. in every Release build. It never fires for us.
- `RCTRootViewFactory.mm:244` — `createReactHostIfNeeded` early-returns once a host exists.
- **The red pill cannot help.** Native already launched the newest update, so `isUpdatePending`
  stays false. `UpdateReadyPill` watches exactly that flag. This is why telling the tester to
  "wait for the red pill" could never have worked.

---

## Three defects to fix

### 1. The 20 s ceiling is ~3× too short, and its justification is stale
`withConvoyCarPlay.js:393` says *"fallbackToCacheTimeout is 15 s in app.json"*. **It is `0`**
(`app.json` → `updates`). That changed in `d1cae98` (2026-08-12) and the comment was never
updated. Meanwhile the genuinely unbounded step the ceiling exists to cover —
`ensureAllAssetsExist` network fetches — carries a **60 s per-asset timeout**
(`FileDownloader.swift:58`). The ceiling is shorter than the thing it is waiting for.

### 2. The ceiling-hit path creates the host — which is the poisoning act
Lengthening the timeout alone is not the fix. **The ceiling-hit path must never call
`superView()`.** A late car screen is recoverable; a process pinned to stale JS is not.

### 3. The failure is invisible
The only signal is one `NSLog` at `withConvoyCarPlay.js:402`. It reaches no telemetry. We were
blind to a two-day outage on our most active tester.

---

## The plan

### A. OTA-able, ships without a build

**A1 — Self-heal.** The stranded fingerprint is exact:
```
Platform.OS === 'ios' && Updates.isEnabled && !Updates.isEmergencyLaunch && Updates.updateId == null
```
`RelaunchProcedure.swift:73-76` shows `reloadAsync()` forces the host onto the resolved bundle.
Gate it hard: once per launch, **not** while a CarPlay/AA surface is mid-connect (this repo has
its own history of reload-during-CarPlay bugs — the `"convoy-aa-nav" has not been registered`
class), after a short settle, with an AsyncStorage loop-breaker so a genuinely broken bundle
cannot reload-spin.
⚠ **Must be sim-verified before shipping** — that it recovers, and that it cannot loop.

**A2 — In-session proof.** `readLogEntriesAsync` is a **live** native read (unlike the frozen
constants). Record JS start time at boot, then compare each entry's `timestamp` to it: a
`didFinishWithLauncher` stamped *after* JS started proves the race was lost, in-session.
Requires fixing A3 first.

**A3 — Fix the log harvest** (`src/crashBreadcrumb.ts:438-451`), which is wrong today:
- `e.timestamp` is **discarded** — which is exactly why existing rows cannot answer this.
- `MAX_HARVEST = 12` with `.slice(-12)` then `watermark = max(fresh)` **silently and permanently
  skips older entries**.
- Every harvested row is stamped with the **current** session's `baseMeta`, so cross-session
  attribution is wrong by construction. **Some of my own session-attribution above rests on
  harvested rows and should be re-read once this is fixed.**

### B. Build-bound (next native cut)

**B1 — Never create the host on the ceiling-hit path.** Leave the car window on a static
"starting" placeholder instead of minting a surface on an embedded-bundle host. Honours the
never-blank-head-unit rule (something is shown) without poisoning the process.

**B2 — If a ceiling must remain, raise it past 60 s** to exceed `FileDownloader`'s own
per-request timeout — and it still must not create the host.

**B3 — Replace the private KVC poll.** `value(forKey:"reactHost")` is brittle across Expo
versions; prefer the delegate/notification the updates handler already uses.

**B4 — Persist the diagnosis.** On ceiling-hit write a UserDefaults marker (ticks waited,
`hostReady`, whether a scene existed, `launchAssetUrl == nil`) and have JS report it on the
**next** launch — the same "diagnose from the following launch" trick `d1cae98` established.

**B5 — Check `failed_launch_count`.** `UpdatesDatabase.swift:436` + `ErrorRecovery.swift:306-308`:
if a CarPlay-only session never commits a frame, the OTA is never marked successful, and one
failure mark can retire that update **permanently** for that device. Verify a stranded device's
state before assuming the per-launch race explains everything.

---

## Detection SQL (use until the instrumentation lands)

```sql
select handle, count(distinct instance_id) sessions, max(event_at) last_seen
from crash_reports
where launch_kind = 'unknown' and event_at > now() - interval '3 days'
group by 1 order by sessions desc;
```

Any tester appearing here is stranded and will silently miss every OTA until they relaunch
**with CarPlay disconnected**.

---

## Interim workaround (what to tell a stranded tester)

> Unplug the phone from the car, then force-quit and reopen the app while it's disconnected.
> Plug back in once it's open.

VERIFIED to work: `Enablewhore` did exactly this at **02:09:08 on 2026-08-29** and came up
`launch_kind=ota` on `01a04933-2094-765a-8a25-860d952eec9d`, today's current OTA.
