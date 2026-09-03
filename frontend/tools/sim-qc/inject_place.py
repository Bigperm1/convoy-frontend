#!/usr/bin/env python3
"""inject_place.py — add a saved place to the simulator app's AsyncStorage (app must be terminated).

    python3 tools/sim-qc/inject_place.py <UDID> qc 49.13823 -122.59453
"""
import json, subprocess, sys, time
from pathlib import Path

udid, label, lat, lng = sys.argv[1], sys.argv[2], float(sys.argv[3]), float(sys.argv[4])
bid = "com.sw0rdfisch.convoy"
subprocess.run(["xcrun", "simctl", "terminate", udid, bid], capture_output=True)
container = subprocess.check_output(["xcrun", "simctl", "get_app_container", udid, bid, "data"], text=True).strip()
manifest = Path(container) / "Library/Application Support" / bid / "RCTAsyncLocalStorage_V1" / "manifest.json"
if not manifest.exists():
    sys.exit(f"no AsyncStorage manifest at {manifest} — launch the app once (signed in) first")
m = json.loads(manifest.read_text())
places = json.loads(m.get("convoy.savedPlaces.v1") or "[]")
places = [p for p in places if p.get("label", "").lower() != label.lower()]
places.append({"id": f"simqc-{label}", "kind": "custom", "label": label, "lat": lat, "lng": lng,
               "address": "sim-qc", "createdAt": int(time.time() * 1000)})
m["convoy.savedPlaces.v1"] = json.dumps(places)
manifest.write_text(json.dumps(m))
print(f"saved place '{label}' -> {lat},{lng} written to {manifest}")
