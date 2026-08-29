---
name: verify-carplay
description: Verify an iOS or CarPlay change locally — bundle-swap into the real build, crash-gate it, drive the UI with taps/gestures, and read the CarPlay framework log for template mounts. Use before shipping any OTA, before asking Jeff for a drive or photo, and before cutting a paid build.
---

# Verify on the sim before it costs a drive or a build

Standing rule: **reproduce and verify locally before asking Jeff for a photo/drive or
cutting a paid build.** About ten CarPlay builds were shipped on confident-but-wrong code
reading. Say explicitly what is VERIFIED vs what is a hypothesis.

## 0. Setup

```bash
export DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer
```
Device: `0CA8F128-1592-4B7F-8E70-BA1AAA6F5519` ("Convoy iOS18 CarPlay") — build 67
installed and signed in. Bundle id `com.sw0rdfisch.convoy`.

If `xcrun` can't find the sim, `xcode-select` is pointing at CommandLineTools. That needs
Jeff's password — tell him to run:
`sudo xcode-select -s /Applications/Xcode.app/Contents/Developer`.

## 1. Bundle-swap into the REAL build

Faster and more faithful than a dev build — it runs your JS inside the shipped binary.

```bash
npx expo export:embed --platform ios --dev false --entry-file index.js \
  --bundle-output /tmp/main.jsbundle --assets-dest /tmp/assets
APP=~/Library/Developer/CoreSimulator/Devices/<UDID>/data/Containers/Bundle/Application/*/Hairpin.app
cp /tmp/main.jsbundle "$APP/main.jsbundle"
```

## 2. CRASH GATE — never skip this

```bash
xcrun simctl terminate <UDID> com.sw0rdfisch.convoy
xcrun simctl spawn <UDID> log stream --level default \
  --predicate 'processImagePath CONTAINS "Hairpin"' > /tmp/sim.log &
xcrun simctl launch <UDID> com.sw0rdfisch.convoy
# wait ~20s, then:
pgrep -f "Hairpin.app/Hairpin"                             # must be alive
grep -icE "Rendered more hooks|NSException" /tmp/sim.log   # must be 0
```

Run **two** cold launches. The first launch after a bundle swap can render black while
assets settle — that is an artifact, not a regression. Confirm with a second launch before
believing it, and don't report a black screen without that control.

## 3. Drive the UI (this is what catches wrong fixes)

The iOS Simulator MCP tool works:
- `attach` → opens the panel
- `tap` (x,y in **points**, not screenshot pixels — the attach result reports the point size)
- `touch2_path` → two-finger rotate/pinch
- `screenshot`

**For anything a BUTTON does, drive it.** A "Crew faces north" fix was reasoned from the
code, looked airtight, and did nothing — rotating the map and tapping it took two minutes
and proved it.

## 4. Read the CarPlay framework log — it is the instrument

The CarPlay framework logs its own template state:

| line | meaning |
|---|---|
| `Setting root template` | the root actually mounted |
| `Template did push, stack count: N` | **N > 1 at rest = something is covering the map** |
| `Requesting present template <CPAlertTemplate>` | a modal is up → every map button is dead |

Counting `Setting root template` and `carplayframework` lines across scenarios is how the
crash-remount bug was pinned:

```
normal launch            -> 3x "Setting root template", 38 carplayframework lines
SIGKILL then relaunch    -> 0x, ZERO carplayframework          <-- the bug
graceful quit + relaunch -> 3x, fine                            <-- proves the display was live
```

Simulate a crash with `kill -9 <pid>`, not `simctl terminate` (which is graceful and
recovers fine — that difference IS the finding).

## 5. Always run the broken-mode control

Prove the instrument can see the failure. When testing the modal fix: fire the NEW path
(expect nothing in the template log) **and** the OLD path (expect
`Requesting present template`). Without the control you can't tell "fixed" from
"not measuring".

## 5b. CAPTURE THE CAR SCREEN FROM THE CLI — no Simulator GUI access needed

`simctl io` takes `--display`, and the CarPlay screen is capturable by NAME:

```bash
xcrun simctl io <UDID> enumerate | grep -E "Screen ID|Screen Type"   # list screens
xcrun simctl io <UDID> screenshot --display CarPlay  /tmp/cp.png     # the car screen
xcrun simctl io <UDID> screenshot --display internal /tmp/phone.png  # the phone
```
`--display 101` FAILS ("does not have a '101' display port") even though enumerate prints
that ID — use the NAME (`CarPlay`) or the alias (`external`).

Order matters, and getting it wrong wastes a cycle:
1. The CarPlay display must be attached BEFORE the app launches, or the scene never binds
   and the capture returns **"Timeout waiting for screen surfaces"**.
2. Attaching it is Simulator → I/O → External Displays → CarPlay. There is NO simctl
   command to create one, and `SimulatorExternalDisplay` in
   `defaults read com.apple.iphonesimulator` does NOT re-attach it on its own.
3. **Do not reboot the sim once it is attached** — a reboot drops the display and you have
   to ask for the menu click again.

## 5c. THE APP DOES NOT FOREGROUND ON THE CARPLAY SIM (2026-08-28, build 67)

The CarPlay display renders the CarPlay HOME SCREEN with the Hairpin icon, and tapping it
does not open the app — for Claude OR for Jeff. The phone screen renders BLACK across two
cold launches (so not the post-swap settle artifact).

**VERIFIED PRE-EXISTING, by running the control**: restoring the original shipped
`main.jsbundle` reproduces it exactly — phone mean brightness 0.5 (vs 7.8 with the new
bundle), same CarPlay home screen, same 2x "Setting root template". So this is the sim, not
your change. Templates DO mount and the log is clean, so everything except the final
compositing can still be verified here.

⚠ Run that control before concluding a CarPlay change broke anything. It costs one launch
and it is the difference between "my change is fine" and shipping a rollback.

## 6. What cannot be verified here

- **iOS 26 CarPlay** — `carkitd` crashes in the iOS 26 sim, and Jeff's head unit is 26.x. So
  iOS-26-only behaviour (raw pinch/zoom gestures, the glass drawn behind CPMapButtons) is
  head-unit-only. Say so rather than implying it was tested.
- **Screen-off** behaviour.
- Anything needing a real head unit's chrome geometry.

## 7. Before publishing

`yarn typecheck` must pass — Metro does **not** typecheck, so a red typecheck still bundles
and ships on luck. Then follow `/ship-ota` (dual-publish the current runtime **and** the
previous one).
