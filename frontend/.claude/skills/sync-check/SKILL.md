---
name: sync-check
description: One-shot release status report across GitHub, EAS builds (both platforms), OTA branch, and runtimes — answers "is everything in sync?", "did the build hit both platforms?", "safe to OTA?". Read-only; changes nothing.
---

# Release sync check

Produce a ✅/⚠️ checklist covering all four surfaces that must line up: **source on GitHub, JS on the OTA channel, native in TestFlight/APK, runtimes matching.** Read-only — run the commands, report, recommend.

## Gather (run in parallel where possible)
```bash
# Local source state
git status --short && git log --oneline -5
git rev-list --count @{u}..HEAD 2>/dev/null   # unpushed commits

# Declared runtime
grep -E "runtimeVersion|\"version\"" app.json

# Native builds — BOTH platforms, always
eas build:list --platform ios --limit 3 --non-interactive
eas build:list --platform android --limit 3 --non-interactive

# OTA state
eas update:list --branch mapbox-migration --limit 3 --non-interactive
eas channel:view mapbox-migration --non-interactive
```

# WHO IS ORPHANED — the check that was missing (2026-08-29)
# A tester on a stale runtime looks IDENTICAL to a quiet tester: nothing alerts, the red
# pill never appears for them, and they sit silently for weeks. Alfred went dark 8/21 and
# it took 8 days to notice; Ron and Victor sat on 3.8.0 / rt 1.24.0 for weeks. All three
# were invisible because we only ever looked at who WAS reporting.
#
# ⚠ USE BOTH SOURCES. crash_reports only carries `handle` from ~8/21 on, so anyone stuck on
# an older build has NULL handle there and vanishes from a telemetry-only query — that is
# exactly how I concluded "never installed" for two testers who had been installed for weeks.
# The in-app Admin screen is authoritative: it is fed by reportDevice() at LOGIN, independent
# of telemetry, and it already computes and displays "ORPHANED".
#
# Supabase (project pgtbjiszjglznjagolse) — who is behind or has gone quiet:
#   select coalesce(handle,'(no handle)') handle, platform, app_version,
#          coalesce(nullif(runtime_version,''),'(empty)') runtime,
#          max(event_at) last_seen
#   from crash_reports where handle is not null
#   group by 1,2,3,4 order by max(event_at) desc;
# Anyone whose runtime != app.json runtimeVersion is ORPHANED: they receive NO OTA at all and
# need a BUILD installed (TestFlight on iOS, Play internal on Android) — not an update prompt.
# Anyone absent for >3 days is worth a poke even at the right runtime.
#
# Android orphans specifically: a SIDELOADED APK can never be updated by Play (different
# signing key), and the app is in Draft so it does NOT appear in Play Store search. They must
# uninstall the APK first, then use the opt-in link — nothing else works:
#   https://play.google.com/apps/internaltest/4701493715980602911   (verified 2026-08-13)

## Evaluate
1. **Git**: working tree clean (ignoring `.env` + `.claude/`)? All commits pushed?
2. **Runtime parity**: latest FINISHED build on iOS **and** Android each match `app.json` `runtimeVersion` exactly? If one is lower → that platform needs a build, and OTAs are silently missing it (this happened 2026-07-06, six OTAs lost to Android).
3. **Channel**: builds' `Channel` field = the branch OTAs go to (`mapbox-migration`). Latest OTA update group present on that branch, `Is Roll Back to Embedded: No`.
4. **Build health**: any `errored` builds in the latest batch? Duplicate (version, buildNumber) risk for TestFlight?
5. **Orphaned testers**: any handle on a runtime that does NOT match `app.json`? They get NO OTA — shipping one does not reach them, and no prompt ever tells them. Name them and say which channel they must reinstall from. Also flag anyone silent >3 days.

## Report format
A short table: surface → state → ✅/⚠️, then a one-line verdict:
- "**In sync — safe to OTA**", or
- "**⚠️ <platform> is behind (runtime X vs Y) — needs a native build before it sees any OTA**", or
- "**⚠️ unpushed commits / dirty tree**" etc.

ALWAYS include an orphan line, even when it is clean: "**Testers: N on current runtime, 0 orphaned**".
A silent pass is the whole point — the failure mode here is nobody looking, not a missing check.

If a paid build is the remedy, say so but DO NOT queue it — that requires Jeff's explicit go-ahead (cost rule).
