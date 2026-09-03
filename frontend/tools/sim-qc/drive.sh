#!/bin/bash
# drive.sh — move the simulator's location for a QC run. See README.md.
#   drive.sh <UDID> park <lat,lon>          clear, set the location, (re)launch the app
#   drive.sh <UDID> go <waypoints.txt> [mps] follow the waypoints (lat,lon per line) at mps (default 15)
#   drive.sh <UDID> shot <out.png>           full-resolution screenshot
#   drive.sh <UDID> stop                     clear the simulated location
set -euo pipefail
UDID="${1:?UDID}"; CMD="${2:?park|go|shot|stop}"; BID=com.sw0rdfisch.convoy
case "$CMD" in
  park)
    xcrun simctl location "$UDID" clear
    xcrun simctl location "$UDID" set "${3:?lat,lon}"
    xcrun simctl terminate "$UDID" "$BID" 2>/dev/null || true
    xcrun simctl launch "$UDID" "$BID" | head -1
    echo "parked at $3, app launched $(date +%T)";;
  go)
    xcrun simctl location "$UDID" clear
    xcrun simctl location "$UDID" start --speed="${4:-15}" --interval=1 - < "${3:?waypoints file}" | tail -1
    echo "driving at ${4:-15} m/s from $(date +%T)";;
  shot)
    xcrun simctl io "$UDID" screenshot "${3:?out.png}" >/dev/null
    echo "shot ${3} $(date +%T)";;
  stop)
    xcrun simctl location "$UDID" clear; echo "location cleared";;
  *) echo "unknown command $CMD" >&2; exit 2;;
esac
