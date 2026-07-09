---
name: cut-build
description: Cut a paid EAS native build (iOS + Android) with the full ritual — batched scope review, explicit cost go-ahead, runtime/version bumps, stale-prebuild checks, dual-platform queueing, background monitoring, and pre-submit verification. Use for "cut the build", "run the build", "build 63" etc.
---

# Cut a native EAS build

**EAS builds cost real money.** This ritual front-loads every check so the paid build goes green on the first try, and hard-stops for authorization.

## 1. Scope review (builds are batched)
- Read the memory file `build-63-native-backlog.md` (or current build's backlog) and list everything queued.
- Confirm with Jeff the scope is FULL — he deliberately batches native changes; never cut early.
- List exactly what this build adds over the previous one (his "what's in this build" checklist).

## 2. HARD STOP — cost go-ahead
State that this is a **paid** action and get Jeff's explicit, fresh "yes" for THIS build. A prior approval does not carry over. (`eas update`/git are free and don't need this; `eas submit` needs its own separate go-ahead.)

## 3. Pre-flight (all must pass BEFORE queueing)
```bash
yarn typecheck                          # clean, always
git status --short                      # committed + pushed (except .env/.claude)
git check-ignore ios android            # BOTH must be gitignored
```
- **ios/ + android/ gitignored** — if a native dir is uploaded, EAS skips prebuild, builds a stale build number, and applies NONE of the config plugins (bit us 2026-07-04).
- **Lockfile consistent** (`yarn install` produces no diff), all imports resolve.
- **Version bumps in `app.json`, together**: `runtimeVersion` (only if native changed — it's a FIXED string, e.g. 1.14.0 → 1.15.0), iOS `buildNumber`, Android `versionCode`. Check the new (version, buildNumber) pair isn't already on TestFlight — duplicates silently fail submission.

## 4. Queue BOTH platforms in the same batch
```bash
eas build --profile mapbox-ios --platform ios --non-interactive --no-wait
eas build --profile mapbox --platform android --non-interactive --no-wait
```
A runtime bump only "takes" for platforms actually rebuilt — building one platform orphans the other from every subsequent OTA (2026-07-06: Android missed six OTAs). Verify the reported build numbers in the queue output immediately.

## 5. Monitor to terminal state
Poll `eas build:list` for both platforms in a background task until finished/errored. On failure: read the build logs URL, diagnose (common: signing/capability issues, CocoaPods, stale caches), fix, and re-ask before re-queueing (another paid run).

## 6. After both land
- Run `/sync-check` — confirm both platforms are at the new runtime on the right channel.
- NEVER `eas submit` without Jeff's explicit separate go-ahead.
- Remind: the first OTA after a runtime bump only reaches the new builds.
- Update the build-backlog memory file: mark shipped, start the next backlog.
