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

## 5. Publish
```bash
eas update --branch mapbox-migration --message "<one-line summary>" --non-interactive
```
Report the Update group ID, commit hash, and EAS dashboard link back to Jeff.

## 6. Pickup instructions
Tell Jeff: pull via **Settings → Software Update** (the in-app button). If the button is missing, the device is on the embedded bundle — use `/ota-rescue` guidance (foreground 2 min on Wi-Fi → force-quit → reopen).

## Hard rules
- NEVER run `eas submit` — that's a separate, explicitly-authorized action.
- `eas update` is free; `eas build` costs money and always needs Jeff's fresh go-ahead.
- Ask Jeff for a go before publishing unless he already said "go/ship it" for this change.
