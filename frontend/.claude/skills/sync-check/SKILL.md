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

## Evaluate
1. **Git**: working tree clean (ignoring `.env` + `.claude/`)? All commits pushed?
2. **Runtime parity**: latest FINISHED build on iOS **and** Android each match `app.json` `runtimeVersion` exactly? If one is lower → that platform needs a build, and OTAs are silently missing it (this happened 2026-07-06, six OTAs lost to Android).
3. **Channel**: builds' `Channel` field = the branch OTAs go to (`mapbox-migration`). Latest OTA update group present on that branch, `Is Roll Back to Embedded: No`.
4. **Build health**: any `errored` builds in the latest batch? Duplicate (version, buildNumber) risk for TestFlight?

## Report format
A short table: surface → state → ✅/⚠️, then a one-line verdict:
- "**In sync — safe to OTA**", or
- "**⚠️ <platform> is behind (runtime X vs Y) — needs a native build before it sees any OTA**", or
- "**⚠️ unpushed commits / dirty tree**" etc.

If a paid build is the remedy, say so but DO NOT queue it — that requires Jeff's explicit go-ahead (cost rule).
