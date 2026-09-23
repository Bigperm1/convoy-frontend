# Key the magenta renders and build the paint layers for the Showroom stills.
#   <name>.png            the still (straight alpha)
#   <name>_<band>black.png black floor, alpha = band weight
#   <name>_<band>mask.png  white, alpha = band weight x shading (tinted at runtime, RN tintColor)
# Same layering as the class sprites (src/classLayers.tsx).
import sys, numpy as np
from PIL import Image

SRC = sys.argv[1]; OUT = sys.argv[2]

def smooth(e0, e1, x):
    t = np.clip((x - e0) / (e1 - e0), 0, 1); return t * t * (3 - 2 * t)

def key(path):
    a = np.asarray(Image.open(path).convert("RGB")).astype(float) / 255
    r, g, b = a[..., 0], a[..., 1], a[..., 2]
    spill = np.clip(np.minimum(r - g, b - g), 0, 1)          # magenta = both R and B above G
    alpha = np.clip(1 - spill, 0, 1)
    alpha[alpha < 0.02] = 0
    M = np.array([1.0, 0.0, 1.0])
    safe = np.maximum(alpha, 1e-3)[..., None]
    fg = np.clip((a - (1 - alpha)[..., None] * M) / safe, 0, 1)  # un-mix the magenta
    return fg, alpha

def crop_resize(fg, alpha, width, pad=0.02):
    ys, xs = np.nonzero(alpha > 0.01)
    y0, y1, x0, x1 = ys.min(), ys.max() + 1, xs.min(), xs.max() + 1
    p = int((x1 - x0) * pad); y0 = max(0, y0 - p); x0 = max(0, x0 - p); y1 += p; x1 += p
    img = np.concatenate([fg, alpha[..., None]], -1)[y0:y1, x0:x1]
    im = Image.fromarray((img * 255).round().astype(np.uint8), "RGBA")
    # premultiplied resample so the edges don't pick up the black un-mixed fringe
    pm = np.asarray(im).astype(float) / 255; pm[..., :3] *= pm[..., 3:4]
    pim = Image.fromarray((pm * 255).round().astype(np.uint8), "RGBA")
    h = round(pim.height * width / pim.width)
    pim = pim.resize((width, h), Image.LANCZOS)
    q = np.asarray(pim).astype(float) / 255
    q[..., :3] = np.where(q[..., 3:4] > 1e-3, q[..., :3] / np.maximum(q[..., 3:4], 1e-3), 0)
    return np.clip(q, 0, 1)

def save(arr, path):
    Image.fromarray((np.clip(arr, 0, 1) * 255).round().astype(np.uint8), "RGBA").save(path, optimize=True)

def layers(q, name, bands):
    rgb, a = q[..., :3], q[..., 3]
    L = 0.2126 * rgb[..., 0] + 0.7152 * rgb[..., 1] + 0.0722 * rgb[..., 2]
    mx, mn = rgb.max(-1), rgb.min(-1); S = np.where(mx > 0, (mx - mn) / np.maximum(mx, 1e-6), 0)
    save(q, f"{OUT}/{name}.png")
    for band, w in bands(L, S).items():
        w = w * a
        sel = w > 0.5
        ref = np.percentile(L[sel], 92) if sel.any() else 1.0
        shade = np.clip(L / max(ref, 1e-3), 0, 1)
        blk = np.zeros_like(q); blk[..., 3] = w
        msk = np.ones_like(q); msk[..., 3] = w * shade
        save(blk, f"{OUT}/{name}_{band}black.png"); save(msk, f"{OUT}/{name}_{band}mask.png")
        print(name, band, "coverage", round(float(sel.mean()), 3), "ref L", round(float(ref), 3))

# Arrow: body = the saturated green facets, rim = the white/blue-grey rim (top and side walls).
def arrow_bands(L, S):
    wb = smooth(0.22, 0.42, S)
    return {"body": wb, "rim": 1 - wb}

# White class car: primary = the bright, unsaturated body panels. Glass, tyres, the carbon roof and
# saturated livery (callipers, lamps, the GT3 RS side script) stay the photo.
def car_bands_for(lo, hi, s_lo=0.14, s_hi=0.28):
    return lambda L, S: {"pri": smooth(lo, hi, L) * (1 - smooth(s_lo, s_hi, S))}
# The muscle model is the neutral mid-grey texture the map tints whole (VEHICLE_TINT), so everything
# but glass and tyres takes the paint; the white bakes only on their bright panels.
CAR_BANDS = {"hatchback": car_bands_for(0.45, 0.62), "supercar": car_bands_for(0.30, 0.50),
             "exotic": car_bands_for(0.30, 0.50), "muscle": car_bands_for(0.10, 0.24, 0.22, 0.36)}

jobs = [("arrow-top", "garage-arrow-2d", 540, arrow_bands),
        ("arrow-chase", "garage-arrow-3d", 540, arrow_bands)]
# 3/4 class-car stills (CAR_BANDS) were shipped for Silver's class car on 2026-09-22 and pulled the same night:
# Silver's car is the flat top-down 2D sprite (Jeff). To render one again: add (<class>, "garage-class-<class>",
# 900, CAR_BANDS[<class>]) and its r() line in render.sh.
only = sys.argv[3:] or None
for src, name, width, bands in jobs:
    if only and src not in only: continue
    fg, al = key(f"{SRC}/{src}.png")
    q = crop_resize(fg, al, width)
    print(name, q.shape[1], "x", q.shape[0])
    layers(q, name, bands)
