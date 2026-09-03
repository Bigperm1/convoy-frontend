#!/usr/bin/env python3
"""route_wps.py — fetch the app's own route and print simctl waypoints (lat,lon per line).

    python3 tools/sim-qc/route_wps.py 49.11242,-122.51990 49.13823,-122.59453 > wps.txt

Uses the token in src/initMapbox.ts (MAPBOX_PUBLIC_TOKEN) and the same profile the app routes with
(mapbox/driving-traffic, overview=full). The sim must drive THIS geometry, from THIS origin, or the
car sits >60 m off the line, unsnaps and the app reroutes (see README, traps).
"""
import json, re, sys, urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
src = (ROOT / "src" / "initMapbox.ts").read_text(encoding="utf-8")
m = re.search(r"MAPBOX_PUBLIC_TOKEN\s*=\s*[\s\S]*?['\"](pk\.[A-Za-z0-9_.-]+)['\"]", src)
if not m:
    sys.exit("no MAPBOX_PUBLIC_TOKEN in src/initMapbox.ts")
tok = m.group(1)
if len(sys.argv) < 3:
    sys.exit("usage: route_wps.py <lat,lon origin> <lat,lon dest> [every-nth-point, default 3]")
o = sys.argv[1].split(","); d = sys.argv[2].split(",")
step = int(sys.argv[3]) if len(sys.argv) > 3 else 3
url = (f"https://api.mapbox.com/directions/v5/mapbox/driving-traffic/{o[1]},{o[0]};{d[1]},{d[0]}"
       f"?geometries=geojson&overview=full&access_token={tok}")
r = json.load(urllib.request.urlopen(url))
if "routes" not in r or not r["routes"]:
    sys.exit(f"no route: {str(r)[:200]}")
rt = r["routes"][0]; coords = rt["geometry"]["coordinates"]
pts = coords[::step] + [coords[-1]]
sys.stderr.write(f"route {rt['distance']:.0f} m {rt['duration']:.0f} s, {len(coords)} pts -> {len(pts)} waypoints\n")
print("\n".join(f"{c[1]:.6f},{c[0]:.6f}" for c in pts))
