---
name: verify-android
description: Reproduce and verify an Android-only bug on the local signed-in emulator — boot, pull the OTA, read real view bounds, drive taps, read logcat. Use whenever a tester reports something that only happens on Android ("can't tap X", "looks wrong on Android", black screen, Android Auto).
---

# Verify it on Android — don't reason about it

**Android-only bugs have burned more sessions than anything else in this project, every
time by being reasoned about instead of observed.** Two fixes for the comms-chip bug were
shipped from confident code-reading and both were wrong; the real cause (an invisible mic
glow eating touches) was found in ten minutes once the emulator was driven directly.

There is a **signed-in Android emulator** on this Mac. Use it.

## 0. Setup (once per session)

```bash
export PATH="$PATH:/opt/homebrew/share/android-commandlinetools/platform-tools:/opt/homebrew/share/android-commandlinetools/emulator"
emulator -avd aa-test -no-snapshot-save &
```

Wait for boot, then confirm:
```bash
adb shell getprop sys.boot_completed   # "1"
adb shell pm list packages | grep sw0rdfisch
```

Package is `com.sw0rdfisch.convoy`. **Never `pm clear`** — it wipes Jeff's login and he has
to sign in again by hand.

## 1. Get the build onto the current OTA

The emulator runs a real store build and pulls OTAs normally. **Two launches** — the first
fetches, the second runs it:

```bash
adb shell am force-stop com.sw0rdfisch.convoy
adb shell am start -n com.sw0rdfisch.convoy/.MainActivity   # wait ~35s (fetch)
adb shell am force-stop com.sw0rdfisch.convoy
adb shell am start -n com.sw0rdfisch.convoy/.MainActivity   # wait ~30s (run)
```

Confirm which bundle is live by reading the crew pill: `N Crew · v67 · 1.19.0 · DD·HHMM`.
The last field is the OTA's publish time — if it isn't yours, it didn't land.

`am start` is more reliable than `monkey` (monkey intermittently exits -5 without launching).

## 2. Look at it

```bash
adb exec-out screencap -p > shot.png
```
Then Read the file. Byte size is a quick liveness proxy (a black/loading screen is ~70KB, a
rendered map ~500KB–1MB) but **always look at the image** before concluding.

## 3. Get REAL coordinates — never guess from a screenshot

```bash
adb shell uiautomator dump /sdcard/ui.xml && adb pull /sdcard/ui.xml .
```
Parse for `bounds="[x1,y1][x2,y2]"` and `clickable="true"`. This is the authoritative hit
box. Screenshots are scaled; computing taps from them is how you end up "fixing" a button
you never actually hit.

For the native view tree with z-order and flags:
```bash
adb shell dumpsys activity top
```
Flags read `VFE...C..` = Visible / Focusable / Enabled / **Clickable**.

## 4. Drive it

```bash
adb shell input tap <x> <y>
adb shell input swipe <x1> <y1> <x2> <y2> <ms>     # same start/end = a held press
```
Verify by re-dumping `uiautomator` and reading a **text label that proves state changed**
(e.g. the mic label going "Hold to Talk" → "Talk · NuGz"). Do not trust screenshot byte
size for state — two different states can be the same size.

## 5. When a tap does nothing

Add a temporary `console.log` in the handler, publish a log-only OTA (harmless to testers),
and read it:
```bash
adb logcat -c ; adb logcat -d | grep ReactNativeJS
```
**No `onPressIn` at all + the container still scrolls + controls elsewhere work** = something
invisible is on top of it. Look for an absolutely-positioned decoration that overhangs its
parent, and check `pointerEvents` is on the **prop**, not in a StyleSheet (Android ignores
the style form). See `HANDOFF.md` §8.

Also useful:
```bash
adb logcat -d | grep -iE "FATAL EXCEPTION|AndroidRuntime"    # native crashes
adb shell top -b -n 2 | grep convoy                           # CPU (a render loop pegs it)
```

## 6. Permissions

`pm reset-permissions` is **not** a fresh install — Expo tracks "have we asked?" in app
storage, so it still reports `denied` and the app correctly declines to re-prompt. Truly
testing first-launch prompts needs `pm clear`, which wipes the login. Don't. Test permission
placement by reading the code path and confirm on a real fresh install instead.

## 7. Always restore what you changed

If you revoked permissions or changed device state, put it back before finishing:
```bash
adb shell pm grant com.sw0rdfisch.convoy android.permission.RECORD_AUDIO
# ...and the others
```

## Can't be reproduced here

- **Android Auto** — the emulator ships a stub AA. Needs the `AACrashLog` black box (build 68+)
  or a real head unit.
- Screen-off behaviour.
