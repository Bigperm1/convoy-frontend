#!/bin/bash
# sim-ios.sh — build, install and launch Hairpin on the iOS Simulator.
#
# WHY THIS EXISTS (2026-08-29): QC for this app is "load it in the app on the sim"
# — GLB cars, the scan flow, CarPlay layout — and Jeff's standing rule is that the
# simulators are the ONLY verification surface (never a browser, never Metro-as-a-
# surface). Every session was re-deriving the incantation. This is it, working.
#
# RELEASE, NOT DEBUG, on purpose:
#   • It EMBEDS the JS bundle, so the sim runs with no Metro attached — matching what
#     a tester actually gets, and keeping Metro to packager plumbing.
#   • It runs `expo export:embed`, which is the exact path that ERRORED the first
#     build-74 cut (a density-suffixed require that resolves in dev Metro and fails
#     release export). So every run is a free pre-flight for the next PAID build.
#
# ⚠ THE LOCAL PREBUILD IS NOT THE SHIPPED CONFIG. `ios/` is gitignored and EAS
# prebuilds fresh, so anything hand-added to the local xcodeproj (there is an empty
# `HairpinWidget` target in there right now) NEVER ships. Native changes must come
# from a config plugin — see plugins/withScoutSiri.js for the pattern. The local
# Info.plist may also lag app.json (it read 3.8.0/72 while app.json said 3.10.0/74);
# harmless for QC, because the JS bundle and the Pods are current — but do not read
# a version off the native plist and believe it.
#
# Usage:
#   ./scripts/sim-ios.sh                 # iPhone 16 Pro, build + install + launch
#   ./scripts/sim-ios.sh "iPhone 17 Pro" # a different device
#   SKIP_BUILD=1 ./scripts/sim-ios.sh    # reinstall the last build (fast)
set -euo pipefail

DEVICE="${1:-iPhone 16 Pro}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

APP_PATH="ios/build/DD/Build/Products/Release-iphonesimulator/Hairpin.app"

echo "==> booting: $DEVICE"
UDID=$(xcrun simctl list devices available -j \
  | python3 -c "
import json,sys
d=json.load(sys.stdin)
want='''$DEVICE'''
for runtime, devs in sorted(d['devices'].items(), reverse=True):
    for x in devs:
        if x['name'] == want:
            print(x['udid']); raise SystemExit
raise SystemExit('no such device: ' + want)
")
xcrun simctl boot "$UDID" 2>/dev/null || true   # already-booted is not an error

# ── ONE BOOTED SIM, OR YOU WILL LOOK AT THE WRONG WINDOW (2026-08-29) ──────────
# This cost a real round trip. iPhone 16 Pro (app installed, running) and iPhone 16
# Pro Max (empty) were both booted, so Simulator.app had TWO windows and the empty
# one was in front. From the desk it read as "the app is not running" while every
# check here said it was up. The device was fine; the window was the wrong device.
OTHERS=$(xcrun simctl list devices booted -j | python3 -c "
import json,sys
d=json.load(sys.stdin)
me='''$UDID'''
out=[f\"{x['name']} ({x['udid']})\" for v in d['devices'].values() for x in v
     if x.get('state')=='Booted' and x['udid']!=me]
print('\n'.join(out))
")
if [ -n "$OTHERS" ]; then
  echo "!!  OTHER SIMULATORS ARE ALSO BOOTED — Simulator.app will show several windows,"
  echo "!!  and the front one may not be the device this script just installed to:"
  echo "$OTHERS" | sed 's/^/!!    /'
  if [ "${SHUTDOWN_OTHERS:-0}" = "1" ]; then
    echo "$OTHERS" | grep -oE '\(([0-9A-F-]{36})\)' | tr -d '()' \
      | xargs -I{} xcrun simctl shutdown {} 2>/dev/null || true
    echo "!!  shut them down (SHUTDOWN_OTHERS=1)"
  else
    echo "!!  re-run with SHUTDOWN_OTHERS=1 to close them, or pick the right window by name."
  fi
fi

open -a Simulator || true

if [ "${SKIP_BUILD:-0}" != "1" ]; then
  echo "==> building (Release, simulator) — first run is slow, later runs are incremental"
  xcodebuild -workspace ios/Hairpin.xcworkspace -scheme Hairpin \
    -configuration Release -sdk iphonesimulator \
    -destination "platform=iOS Simulator,id=$UDID" \
    -derivedDataPath ios/build/DD \
    CODE_SIGNING_ALLOWED=NO build \
    | tail -40
fi

[ -d "$APP_PATH" ] || { echo "no product at $APP_PATH" >&2; exit 1; }

BID=$(/usr/libexec/PlistBuddy -c "Print CFBundleIdentifier" "$APP_PATH/Info.plist")
echo "==> installing $BID"
xcrun simctl install "$UDID" "$APP_PATH"
xcrun simctl launch "$UDID" "$BID"

echo "==> up. screenshot:  xcrun simctl io $UDID screenshot /tmp/sim.png"
echo "==> logs:            xcrun simctl spawn $UDID log stream --predicate 'processImagePath CONTAINS \"Hairpin\"'"
