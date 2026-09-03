#!/usr/bin/env python3
"""measure.py — car size + nose→route-line gap from nav screenshots, with PASS/FAIL.

    python3 tools/sim-qc/measure.py nav_54.png nav_108.png [--pt 44] [--min-gap 18]

Assumes the phone nav layout (heading-up, car near x=50%, y≈68%). Screenshots from
`xcrun simctl io <UDID> screenshot` on an iPhone 16/17 Pro are 1206×2622 (3 px/pt).

Invariants (2026-09-03):
  * car length (dark body bbox) within ±15% across all screenshots — the per-tick scale
    holds the car at SELF_MARKER_PT at every zoom (was 2× swings between whole zooms);
  * the route line's visible start (faint green) at least --min-gap pt ahead of the nose,
    and never over the car (was ending on the roof on CarPlay).
Needs numpy + Pillow.
"""
import sys
import numpy as np
from PIL import Image

args = [a for a in sys.argv[1:] if not a.startswith("--")]
opt = {a.split("=")[0]: a.split("=")[1] for a in sys.argv[1:] if a.startswith("--") and "=" in a}
MIN_GAP = float(opt.get("--min-gap", 18))
SCALE = 3.0


def measure(path):
    im = Image.open(path).convert("RGB"); a = np.asarray(im).astype(int); H, W, _ = a.shape
    r, g, b = a[..., 0], a[..., 1], a[..., 2]
    x0, x1, y0, y1 = int(W * 0.40), int(W * 0.60), int(H * 0.55), int(H * 0.78)
    dark = np.maximum(np.maximum(r, g), b) < 120
    win = np.zeros_like(dark); win[y0:y1, x0:x1] = True
    ys, xs = np.where(dark & win)
    if len(ys) < 50:
        return None
    top, bot = np.percentile(ys, 1), np.percentile(ys, 99); cx = int(np.median(xs))
    out = {"car_len_pt": (bot - top) / SCALE, "nose_y": top, "centre_y": (top + bot) / 2}
    for label, thr in (("faint", 12), ("solid", 40)):
        col = (g - r > thr) & (g - b > thr)
        cw = np.zeros_like(col); cw[: int(top) - 2, cx - 45: cx + 45] = True
        ry, rx = np.where(col & cw)
        if len(ry) < 10:
            out[f"gap_{label}_pt"] = None; continue
        rows = {y: int((ry == y).sum()) for y in np.unique(ry)}
        maxc = max(rows.values()); end = max(y for y, c in rows.items() if c > 0.15 * maxc)
        out[f"gap_{label}_pt"] = (top - end) / SCALE
    # line over the car? green pixels inside the car's bbox column
    over = ((g - r > 25) & (g - b > 25))[int(top): int(bot), cx - 20: cx + 20].sum()
    out["green_px_over_car"] = int(over)
    return out


res = {}
for p in args:
    res[p] = measure(p)
    if res[p] is None:
        print(f"{p}: NO CAR FOUND"); continue
    m = res[p]
    print(f"{p}: car {m['car_len_pt']:.0f} pt | line start ahead of nose: faint {m['gap_faint_pt']} pt, "
          f"solid {m['gap_solid_pt']} pt | green px over car: {m['green_px_over_car']}")

ok = True
lens = [m["car_len_pt"] for m in res.values() if m]
if len(lens) >= 2 and (max(lens) - min(lens)) / max(lens) > 0.15:
    print(f"FAIL car size varies {min(lens):.0f}–{max(lens):.0f} pt across zooms"); ok = False
for p, m in res.items():
    if not m: ok = False; continue
    gap = m.get("gap_solid_pt"); faint = m.get("gap_faint_pt")
    # solid = where the line reads as a line; faint = the casing glow's halo (allowed to come closer).
    if m["green_px_over_car"] > 60 or (gap is not None and gap < MIN_GAP) or (faint is not None and faint < MIN_GAP / 3):
        print(f"FAIL {p}: route line too close/over the car (solid {gap}, faint {faint}, green over car {m['green_px_over_car']} px)"); ok = False
print("PASS" if ok else "FAIL")
sys.exit(0 if ok else 1)
