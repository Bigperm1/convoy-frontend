#!/bin/bash
# bearing_probe.sh — does Mapbox Directions honour the `bearings` departure constraint TODAY?
# Re-run this before believing any note that says it does not (src/departureBearing.ts carried
# a July 2026 "no effect" finding that was wrong for the API on 2026-09-06 and kept the U-turn
# start unfixed for weeks). Prints departure bearings only; the token never leaves the shell.
#   tools/sim-qc/bearing_probe.sh            # Rodrigo's street, west vs east destinations
# PASS = the westward constraint turns an eastbound departure into a westbound one (and vice versa).
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
TOK=$(grep -ho 'pk\.[A-Za-z0-9._-]\{40,\}' "$ROOT/src/initMapbox.ts" | head -1)
[ -n "$TOK" ] || { echo "no Mapbox public token literal in src/initMapbox.ts" >&2; exit 2; }
O="-122.85351,49.23526"   # Rodrigo, 2026-09-05 14:26 nav start (an east-west two-way street)
BASE="alternatives=true&steps=true&overview=full&geometries=polyline&access_token=$TOK"
fail=0
for D in "-122.8950,49.2353" "-122.8120,49.2353"; do
  for label in none east west; do
    case $label in east) Q="$BASE&bearings=92,45;";; west) Q="$BASE&bearings=272,45;";; *) Q="$BASE";; esac
    dep=$(curl -s "https://api.mapbox.com/directions/v5/mapbox/driving-traffic/$O;$D?$Q" \
      | python3 -c 'import json,sys; d=json.load(sys.stdin); r=d.get("routes") or []; print(r[0]["legs"][0]["steps"][0]["maneuver"].get("bearing_after") if r else "none")')
    echo "dest=$D constraint=$label → departs $dep°"
    case $label in
      east) [ "$dep" != "none" ] && [ "$dep" -lt 135 ] || fail=1;;
      west) [ "$dep" != "none" ] && [ "$dep" -gt 225 ] || fail=1;;
    esac
  done
done
[ $fail -eq 0 ] && echo "PASS — bearings steers the departure" || { echo "FAIL — bearings did NOT steer the departure; do not rely on it"; exit 1; }
