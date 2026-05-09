"""Generate Convoy app icon variants from the master logo.

Outputs (overwriting existing assets):
  icon.png            1024x1024  iOS / generic app icon (black bg, full bleed)
  adaptive-icon.png   1024x1024  Android adaptive foreground, padded so the
                                 logo lives entirely in the 66% safe zone
                                 (transparent bg — Expo composites it)
  favicon.png         196x196    Web favicon
  splash-image.png    1284x2778  Splash (black bg, centered logo at ~40% width)
  brand-mark.png       512x512   In-app logo with TRANSPARENT background
                                 (used in Login / Hub headers).
"""
from PIL import Image, ImageOps
import os

ASSETS = "/app/frontend/assets/images"
SRC = os.path.join(ASSETS, "convoy-logo-source.png")

src_rgb = Image.open(SRC).convert("RGB")
W, H = src_rgb.size

# 1) Crop to a tight square around the visible logo so we can re-pad cleanly.
# The source is already a square but the logo is centred with generous margin.
# Convert to RGBA so we can knock out the black background.
src_rgba = src_rgb.convert("RGBA")

# Knock out the near-black background → transparent.
def to_transparent_bg(img: Image.Image, threshold: int = 28) -> Image.Image:
    px = img.load()
    w, h = img.size
    for y in range(h):
        for x in range(w):
            r, g, b, _ = px[x, y]
            if r < threshold and g < threshold and b < threshold:
                px[x, y] = (0, 0, 0, 0)
    return img

logo_alpha = to_transparent_bg(src_rgba.copy())

# Crop to the bounding box of the non-transparent pixels for accurate scaling.
bbox = logo_alpha.getbbox()
logo_cropped = logo_alpha.crop(bbox) if bbox else logo_alpha
print("Logo bbox:", bbox, " cropped size:", logo_cropped.size)


def fit_centered(target_size: int, content: Image.Image, content_scale: float, bg=(0, 0, 0, 255)) -> Image.Image:
    """Place `content` centred inside a target_size square canvas of color `bg`,
    scaled so its longest side equals target_size * content_scale.
    Setting bg=(0,0,0,0) yields transparent background."""
    canvas = Image.new("RGBA", (target_size, target_size), bg)
    cw, ch = content.size
    longest = max(cw, ch)
    target = int(target_size * content_scale)
    ratio = target / longest
    new_w, new_h = max(1, int(cw * ratio)), max(1, int(ch * ratio))
    resized = content.resize((new_w, new_h), Image.LANCZOS)
    x = (target_size - new_w) // 2
    y = (target_size - new_h) // 2
    canvas.paste(resized, (x, y), resized)
    return canvas


# ---- 1) icon.png  (iOS / generic) — black bg, full bleed (~88% width to keep
#         a tiny safe margin per Apple's tile-mask trimming rules).
icon = fit_centered(1024, logo_cropped, 0.78, bg=(0, 0, 0, 255))
icon.convert("RGB").save(os.path.join(ASSETS, "icon.png"), "PNG", optimize=True)

# ---- 2) adaptive-icon.png — Android adaptive foreground.
#         Per Android guidelines: visible area is the central 66% of the canvas.
#         We size the logo so its longest edge sits within ~62% of the canvas
#         (a hair smaller than the 66% safe zone for visual breathing room).
#         Background is TRANSPARENT — Expo renders it on top of the
#         backgroundColor configured in app.json.
adaptive = fit_centered(1024, logo_cropped, 0.62, bg=(0, 0, 0, 0))
adaptive.save(os.path.join(ASSETS, "adaptive-icon.png"), "PNG", optimize=True)

# ---- 3) favicon.png  — web. Keep small + simple.
favicon = fit_centered(196, logo_cropped, 0.86, bg=(0, 0, 0, 255))
favicon.convert("RGB").save(os.path.join(ASSETS, "favicon.png"), "PNG", optimize=True)

# ---- 4) splash-image.png — iOS-portrait friendly aspect, centered logo.
SPLASH_W, SPLASH_H = 1284, 2778
splash = Image.new("RGBA", (SPLASH_W, SPLASH_H), (0, 0, 0, 255))
# Logo at 40% of the SHORT side (width) so it looks balanced on portrait.
target_long = int(SPLASH_W * 0.40)
cw, ch = logo_cropped.size
longest = max(cw, ch)
ratio = target_long / longest
new_w, new_h = int(cw * ratio), int(ch * ratio)
resized = logo_cropped.resize((new_w, new_h), Image.LANCZOS)
splash.paste(resized, ((SPLASH_W - new_w) // 2, (SPLASH_H - new_h) // 2), resized)
splash.convert("RGB").save(os.path.join(ASSETS, "splash-image.png"), "PNG", optimize=True)

# ---- 5) brand-mark.png — in-app use (Login screen, headers). Transparent bg.
brand = fit_centered(512, logo_cropped, 0.92, bg=(0, 0, 0, 0))
brand.save(os.path.join(ASSETS, "brand-mark.png"), "PNG", optimize=True)

print("Generated:")
for fn in ("icon.png", "adaptive-icon.png", "favicon.png", "splash-image.png", "brand-mark.png"):
    p = os.path.join(ASSETS, fn)
    sz = os.path.getsize(p)
    img = Image.open(p)
    print(f"  {fn:24s}  {img.size}  {sz/1024:.1f} KB")
