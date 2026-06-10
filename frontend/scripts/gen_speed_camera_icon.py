"""Generate assets/images/speed_camera{,@2x,@3x}.png — a speed-camera map pin.

Mirrors the old in-app `camPin` style (a dark circle with a red ring + a white
camera glyph) as a RASTER PNG, so the marker can be drawn via react-native-maps'
native `image` prop instead of capturing a vector-font child view (which renders
blank on New-Architecture Android).

The native `image` prop renders at the asset's intrinsic density size, so we emit
@1x/@2x/@3x variants sized to a 26pt pin (26 / 52 / 78 px). Each is drawn at 4x
then downscaled with LANCZOS so the small ones stay crisp.
"""
from PIL import Image, ImageDraw

SUPER = 312  # 26pt @12x master, downscaled to each target


def draw(S: int) -> Image.Image:
    img = Image.new("RGBA", (S, S), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    k = S / 104.0  # geometry below was tuned at 104px; scale to S

    def r(*v):
        return [x * k for x in v]

    ring = (255, 69, 58, 255)        # #FF453A
    fill = (28, 28, 30, 242)         # rgba(28,28,30,0.95)
    border = 8 * k
    d.ellipse(r(2, 2, 102, 102), fill=ring)
    d.ellipse([2 * k + border, 2 * k + border, 102 * k - border, 102 * k - border], fill=fill)

    w = (255, 255, 255, 255)
    d.rounded_rectangle(r(26, 42, 78, 72), radius=6 * k, fill=w)      # body
    d.rounded_rectangle(r(44, 34, 62, 44), radius=3 * k, fill=w)      # viewfinder bump
    cx, cy, rad = 52 * k, 57 * k, 11 * k
    d.ellipse([cx - rad, cy - rad, cx + rad, cy + rad], fill=fill)    # lens hole
    d.ellipse([cx - 4 * k, cy - 4 * k, cx + 4 * k, cy + 4 * k], fill=w)  # lens highlight
    return img


master = draw(SUPER)
for suffix, size in [("", 26), ("@2x", 52), ("@3x", 78)]:
    out = master.resize((size, size), Image.LANCZOS)
    path = f"assets/images/speed_camera{suffix}.png"
    out.save(path)
    print("wrote", path, out.size)
