#!/usr/bin/env python3
"""classes-car/make.py — the class top-down art at the GR Corolla sprite's size, for the car surfaces (2026-09-23).

Jeff, driving, 2026-09-23: "when I'm on the silver tier and I select, say, the exotic car, it's showing my GR Corolla as
the avatar or car marker when it's supposed to be the exotic car." CarPlay / Android Auto draw the driver's flat car
through SelfCarModel with spriteSize = vehiclePngScale(colour) — a scale TUNED FOR THE 44 pt GRC PHOTOS
(assets/vehicles/v3/*.png, 44/88/132 px) and fixed inside the nav-locked JSX (CarMapView car-jsx-selfcar-model). The
class art (assets/images/classes-v2/*.png) is 512 px single-scale, so registering it there would draw a car ~12x too
big. This makes each class the same way the GRC photos are made: a square crop whose HEIGHT is the car's length (the
GRC ink fills its 44 px height; the class art's ink is rows 12..500 of 512), then 44 / 88 / 132 px.
Run: python3 tools/classes-car/make.py   (idempotent; writes assets/vehicles/classes-car/<class>[@2x|@3x].png)
"""
from pathlib import Path
from PIL import Image

ROOT = Path(__file__).resolve().parents[2]
SRC = ROOT / "assets/images/classes-v2"
OUT = ROOT / "assets/vehicles/classes-car"
OUT.mkdir(parents=True, exist_ok=True)

for src in sorted(SRC.glob("*.png")):
    if "@" in src.stem or "_" in src.stem:    # base art only — not the _pri/_sec paint-mask layers
        continue
    im = Image.open(src).convert("RGBA")
    box = im.split()[3].getbbox()
    if not box:
        continue
    top, bottom = box[1], box[3]
    side = bottom - top                       # the car's length = the crop's side
    cx = (box[0] + box[2]) / 2
    left = int(round(cx - side / 2))
    crop = Image.new("RGBA", (side, side), (0, 0, 0, 0))
    crop.paste(im.crop((max(0, left), top, min(im.width, left + side), bottom)), (max(0, -left), 0))
    for suffix, px in (("", 44), ("@2x", 88), ("@3x", 132)):
        crop.resize((px, px), Image.LANCZOS).save(OUT / f"{src.stem}{suffix}.png", optimize=True)
    print(f"{src.stem}: ink {box} -> {side}px square -> 44/88/132")
