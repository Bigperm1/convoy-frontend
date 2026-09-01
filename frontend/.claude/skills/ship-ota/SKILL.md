---
name: ship-ota
description: Publish a JS-only OTA update to Convoy testers with the full release discipline — typecheck gate, channel + runtime-parity verification, commit/push, eas update, and pickup instructions. Use whenever shipping code changes over-the-air ("ship it", "OTA this", "publish the update").
---

# Ship an OTA update

Run the FULL ritual in order. Every rule below exists because skipping it once cost real damage (dates noted).

## 1. Gate: typecheck (never skip)
```bash
yarn typecheck
```
Must pass clean. Do not publish on a failing or skipped typecheck.

## 1b. Gate: doc-check (sub-second, added 2026-08-30)
```bash
python3 scripts/doc-check.py --live
```
Must exit 0. It verifies that every repo path a **live** doc references still exists, that
every `file.ts:NNN` citation is inside that file, and that every "~N lines" claim is within
25% of reality. History-only docs (`HANDOFF*.md`, `CARPLAY_MAC_HANDOFF.md`) are reported but
never fail — they are dated snapshots and their references are *supposed* to rot.

**Why it is a release gate and not a chore:** doc rot is created by CHANGES, not by time, so
the moment code ships is exactly the moment to check. Deleting `src/powerMode.ts` orphaned a
reference in `WHY-IT-HEATS.md` the same night. On the day this gate was added, four stale
references were live at once — including **`CARPLAY.md` rule 1, the hook rule that cost two
crashes on 2026-07-24**, pointing at an early-return that had drifted ~1,200 lines onto an
unrelated comment. A stale pointer is worse than none: it sends the next reader to unrelated
code, they conclude the rule does not apply, and they add the hook anyway.

**If it fails:** fix by citing CONTENT (a `grep` for the comment text), not a line number —
see `CARPLAY.md` rule 1 for the pattern. A line number written today is wrong by next week;
correcting one of these shifted its own target three lines on the spot. To name a
deliberately-deleted file in prose, add `<!-- doc-check:ignore: why -->` on that line.

⚠ **What this gate does NOT prove.** It shows references POINT somewhere real. It cannot tell
you a doc is LYING. `CLAUDE.md` described routing as "Google Routes API v2" for months after
the 2026-06-14 move to Mapbox — every path in that sentence was valid, the prose was false,
and it was repeated back to Jeff as fact. **If this OTA changed a subsystem, re-read that
subsystem's doc by hand.** That is the only thing that catches semantic rot.

## 2. Confirm the change is OTA-able
JS/TS-only changes ship OTA. If anything native changed (new native module, config plugin, `app.json` plugin/infoPlist change, patch-package on a native dep, SDK bump) — STOP: this needs a native build (`/cut-build`), not an OTA. Pushing JS an old binary can't run strands testers.

## 3. Commit + push (respect the exclusions)
- Stage ONLY the intended files. NEVER commit `.env` (it's dirty by default in this repo) or `.claude/`.
- Subject prefixed `OTA:` with a one-line summary of the user-visible change.
- End the commit message with the Co-Authored-By Claude trailer.
- `git push origin mapbox-migration` and VERIFY it landed (a push once silently failed and nearly lost work).

## 4. Verify channel + runtime parity (the two silent killers)
```bash
grep runtimeVersion app.json
eas build:list --platform ios --limit 3 --non-interactive
eas build:list --platform android --limit 3 --non-interactive
```
- The latest FINISHED build on EACH platform must be at `app.json`'s current `runtimeVersion` exactly. If either platform is lower, that platform needs a BUILD, not an OTA (2026-07-06: iOS-only build 62 orphaned Android from six OTAs).
- Read the installed build's `Channel` field — currently **`mapbox-migration`**, NOT `preview` (publishing to preview silently ate three updates on 2026-07-05). Never assume the channel; read it.

## 5. Publish — ALWAYS through `env:exec`, never bare `eas update`
```bash
npx eas-cli env:exec preview "npx eas-cli update --branch mapbox-migration --clear-cache -m '<one-line summary>' --non-interactive"
```
**A bare `eas update` bakes an EMPTY `EXPO_PUBLIC_OPENWEATHER_KEY` into the bundle and
silently kills every weather surface.** `eas update` inlines `process.env.EXPO_PUBLIC_*`
at export time from the LOCAL `.env` only — it does NOT read the EAS server-side
environments. `EXPO_PUBLIC_OPENWEATHER_KEY` lives ONLY in the EAS `preview`/`production`
environments (deliberately: it is the one key not hardcoded in `src/api.ts`, because
`Bigperm1/convoy-frontend` is a PUBLIC repo). `PROD_OPENWEATHER_KEY` in `src/api.ts:35`
is `""`, so there is no fallback to catch it — `fetchWeatherConditions` returns `null`
before any network call and the failure is completely silent.

MEASURED COST (2026-08-31): weather died on phone + CarPlay + the destination card + the
daily forecast + Nova's arrival weather word for **13 OTAs over 20 hours**, from the
2026-08-30 19:12 PDT publish until Jeff noticed the next morning. Nobody could have
reported it sooner — nothing errors, the chip simply never appears.

## 5b. PROVE the key is in the bundle before announcing anything
Do not tell anyone to tap the red pill until you have seen `KEY_PRESENT=1`:
```bash
python3 <scratchpad>/verify_key.py <new-update-group-id> 1.26.0
```
That script pulls the REAL published Hermes bundle from `u.expo.dev` (manifest multipart
-> `launchAsset.url` + its EAS-HMAC `authorization` header) and greps it for the key,
printing COUNTS ONLY so the value never reaches a transcript. Get the key into `ow.key`
with `npx eas-cli env:exec preview 'printf "%s" "$EXPO_PUBLIC_OPENWEATHER_KEY" > ow.key'`.
Expect `KEY_PRESENT=1  openweathermap=2  neg_control=0` on BOTH platforms; run it against
the previous group too, as a control.

⚠ Fetch the manifest with **curl**, not Python `urllib` — u.expo.dev 403s urllib's
default User-Agent, which reads exactly like an auth failure and sends you chasing a
stale session secret.

Report the Update group ID, commit hash, the `KEY_PRESENT` line, and the EAS dashboard
link back to Jeff.

## 6. Pickup instructions — the RED PILL, and nothing else
Tell Jeff and the testers exactly one thing:

> Open the app and leave it on the map for a few seconds. A red **"Update ready — tap to install"** pill appears under the search bar. Tap it. Done.

That is `src/UpdateReadyPill.tsx`: it watches `Updates.useUpdates().isUpdatePending`, so it shows the moment the new bundle finishes downloading, and one tap calls `reloadAsync()` — the new JS runs immediately. It is deliberately hidden while turn-by-turn nav is active and comes back when the drive ends.

**Do NOT tell anyone to use "Settings → Software Update" — that button was REMOVED** (Jeff, 2026-07-25). It was confusing next to the pill, and it actively lied: `checkForUpdateAsync` compares the server against what is DOWNLOADED on disk, not what is RUNNING, so it answered "You're up to date" during the 2026-07-09/07-11 stranded-OTA incidents. **Do not tell anyone to force-close twice either** — that is the old cold-start dance the pill exists to replace.

Only if the pill never appears is the device stranded on the embedded bundle → `/ota-rescue` (foreground ~2 min on Wi-Fi → force-quit → reopen).

## Hard rules
- NEVER run `eas submit` — that's a separate, explicitly-authorized action.
- `eas update` is free; `eas build` costs money and always needs Jeff's fresh go-ahead.
- Ask Jeff for a go before publishing unless he already said "go/ship it" for this change.
