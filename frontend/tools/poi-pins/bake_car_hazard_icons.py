#!/usr/bin/env python3
"""bake_car_hazard_icons.py — the HEAD-UNIT (CarPlay + Android Auto) hazard art, written straight into
src/carplay/carButtonIcons.ts, so no base64 is pasted by hand any more. Jeff, 2026-09-25, from a CarPlay photo:

  1. "The hazard on the hazard glyph on CarPlay is just a little too big ... it's touching the bottom two edges. ... make it
     a little, little smaller and it's the same distance for each three points to the edge of the circle."
     → CAR_ICON_HZ_HAZARD_CANDY_{BRAND,PREMIUM,ULTRA,DIAMOND}: the phone's candy triangle (bake_hazard_candy.py svg()), scaled
     about its CIRCUMCENTRE and moved so the circumcentre sits on the button's centre. Measured before: the ink reached 0.98
     of the 66 px half-canvas at the two base corners (touching CarPlay's circle) and 0.72 at the apex. After: all three
     points at INK_FRAC. The phone FAB keeps assets/images/premium/hazard_candy*.png — this script never writes them.

  2. "make it so that the icons or the glyphs in the hazards window are the same colors as on the phone"
     → CAR_ICON_HZ_{POLICE,CRASH,HAZARD,TRAFFIC}_NEON: the brand glyph's alpha, every pixel set to the kind's BRIGHT colour
     (hazardPalette.ts → poiPalette.ts). That is exactly what the phone's `tintColor: neonFor(kind)` does to the same
     silhouette (HazardSheet.tsx); all four metals share one silhouette (alpha differs by ≤ 1/255), so one neon icon per kind.

  python3 tools/poi-pins/bake_car_hazard_icons.py      (needs headless Chrome — same as bake_hazard_candy.py)
Gate: tools/sim-qc/hazard_panel_test.mts section H decodes what this writes and checks both rules.
"""
import base64, io, math, os, re, subprocess, sys, tempfile
from PIL import Image

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(os.path.dirname(HERE))
sys.path.insert(0, HERE)
import bake_hazard_candy as candy  # noqa: E402

ICONS = os.path.join(ROOT, "src/carplay/carButtonIcons.ts")
SIZE = 132                      # 44 pt @3x, the box every head-unit glyph uses
# Where the three points sit, as a fraction of the half-canvas. 0.80 ≈ 4.4 pt of clear ring inside a 44 pt circle; the
# crew glyph reaches 0.89 and 2D reaches 0.72 on the same buttons (measured 2026-09-25), so the triangle lands between.
INK_FRAC = 0.80
SUFFIX_TO_METAL = {"": "BRAND", "_silver": "PREMIUM", "_gold": "ULTRA", "_diamond": "DIAMOND"}
NEON = {"police": "POLICE", "accident": "CRASH", "road": "HAZARD", "traffic": "TRAFFIC"}   # backend kind → constant stem


def tri_points():
    nums = [float(x) for x in re.findall(r"-?\d+(?:\.\d+)?", candy.TRI)]
    (ax, ay), (bx, by), cx = (nums[0], nums[1]), (nums[2], nums[3]), nums[4]   # "M ax ay L bx by H cx Z"
    return [(ax, ay), (bx, by), (cx, by)]


def circumcentre(p):
    (ax, ay), (bx, by), (cx, cy) = p
    d = 2 * (ax * (by - cy) + bx * (cy - ay) + cx * (ay - by))
    ux = ((ax * ax + ay * ay) * (by - cy) + (bx * bx + by * by) * (cy - ay) + (cx * cx + cy * cy) * (ay - by)) / d
    uy = ((ax * ax + ay * ay) * (cx - bx) + (bx * bx + by * by) * (ax - cx) + (cx * cx + cy * cy) * (bx - ax)) / d
    return ux, uy, math.hypot(ax - ux, ay - uy)


def render(svg_text, path):
    html = ('<!doctype html><html><head><meta charset="utf-8"><style>body{margin:0;background:transparent;'
            f'width:{SIZE}px;height:{SIZE}px}}</style></head><body>{svg_text}</body></html>')
    with tempfile.TemporaryDirectory() as d:
        h = os.path.join(d, "g.html")
        open(h, "w").write(html)
        subprocess.run([candy.CHROME, "--headless=new", "--disable-gpu", "--hide-scrollbars", "--force-device-scale-factor=1",
                        "--default-background-color=00000000", f"--window-size={SIZE},{SIZE}", f"--screenshot={path}",
                        f"file://{h}"], check=True, capture_output=True)


def ink_frac(img):
    a = img.convert("RGBA").load()
    c = (SIZE - 1) / 2
    r = max((math.hypot(x - c, y - c) for y in range(SIZE) for x in range(SIZE) if a[x, y][3] > 128), default=0)
    return r / (SIZE / 2)


def png_b64(img):
    buf = io.BytesIO()
    img.save(buf, "PNG", optimize=True)
    return base64.b64encode(buf.getvalue()).decode()


def put(src, name, b64):
    pat = re.compile(r"(const " + re.escape(name) + r": CarIcon = icon\(\s*')[A-Za-z0-9+/=]*(')")
    if not pat.search(src):
        sys.exit(f"{name} not found in carButtonIcons.ts — add `const {name}: CarIcon = icon(\\n  ''\\n);` first")
    return pat.sub(lambda m: m.group(1) + b64 + m.group(2), src, count=1)


def get(src, name):
    m = re.search(r"const " + re.escape(name) + r": CarIcon = icon\(\s*'([A-Za-z0-9+/=]+)'", src)
    if not m:
        sys.exit(f"{name} not found in carButtonIcons.ts")
    return Image.open(io.BytesIO(base64.b64decode(m.group(1)))).convert("RGBA")


def bright_colours():
    pal = open(os.path.join(ROOT, "src/hazardPalette.ts")).read()
    poi = open(os.path.join(ROOT, "src/poiPalette.ts")).read()
    out = {}
    for kind in NEON:
        cat = re.search(rf'^\s*{kind}:\s*{{ cat: "(\w+)"', pal, re.M).group(1)
        out[kind] = re.search(rf'^\s*{cat}:\s*{{ bright: "(#[0-9A-Fa-f]{{6}})"', poi, re.M).group(1)
    return out


def main():
    src = open(ICONS).read()

    # 1 · the candy map button, centred on its circumcentre at INK_FRAC. The stroke (1.2) and anti-aliasing add ink past
    # the path's own corners, so solve the scale from a first render instead of guessing that margin.
    ux, uy, r0 = circumcentre(tri_points())
    target = INK_FRAC * (SIZE / 2)
    scale = (INK_FRAC * 32) / r0
    with tempfile.TemporaryDirectory() as d:
        for _ in range(3):
            t = f"translate(32 32) scale({scale:.5f}) translate({-ux:.5f} {-uy:.5f})"
            probe = os.path.join(d, "probe.png")
            top, mid, bot = candy.RAMPS[""]
            render(candy.svg(top, mid, bot, t), probe)
            got = ink_frac(Image.open(probe)) * (SIZE / 2)
            scale *= target / got
        t = f"translate(32 32) scale({scale:.5f}) translate({-ux:.5f} {-uy:.5f})"
        for suf, (top, mid, bot) in candy.RAMPS.items():
            p = os.path.join(d, f"candy{suf}.png")
            render(candy.svg(top, mid, bot, t), p)
            img = Image.open(p).convert("RGBA")
            src = put(src, f"CAR_ICON_HZ_HAZARD_CANDY_{SUFFIX_TO_METAL[suf]}", png_b64(img))
            print(f"candy{suf or '_brand'}: ink {ink_frac(img):.3f} of the half-canvas (scale {scale:.4f})")

    # 2 · the Report tiles in the phone's colours: brand alpha, bright RGB (tintColor semantics).
    for kind, colour in bright_colours().items():
        stem = NEON[kind]
        g = get(src, f"CAR_ICON_HZ_{stem}_BRAND")
        rgb = tuple(int(colour[i:i + 2], 16) for i in (1, 3, 5))
        out = Image.new("RGBA", g.size, rgb + (0,))
        out.putalpha(g.getchannel("A"))
        src = put(src, f"CAR_ICON_HZ_{stem}_NEON", png_b64(out))
        print(f"neon {kind}: {colour}")

    open(ICONS, "w").write(src)
    print("wrote", os.path.relpath(ICONS, ROOT))


if __name__ == "__main__":
    main()
