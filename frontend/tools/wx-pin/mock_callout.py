#!/usr/bin/env python3
"""Mockup renderer for the destination WEATHER CALLOUT (Jeff, 2026-09-03: "a rectangle (rounded corners),
dark transparent background, weather in the middle (temp/glyph), skin border not too thick, tapered to a
point at the destination spot"). Renders a sheet (3 skins x 4 states) and an in-context composite over a
real route-preview screenshot. Preview BEFORE code — see memory preview-ux-before-shipping."""
import json, os, sys
from PIL import Image, ImageDraw, ImageFont, ImageFilter, ImageChops
ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
FONTS = os.path.join(ROOT, 'node_modules/@expo/vector-icons/build/vendor/react-native-vector-icons')
ION = FONTS + '/Fonts/Ionicons.ttf'; MCI = FONTS + '/Fonts/MaterialCommunityIcons.ttf'
IM = json.load(open(FONTS + '/glyphmaps/Ionicons.json')); MM = json.load(open(FONTS + '/glyphmaps/MaterialCommunityIcons.json'))
SKINS = {"brand": ("#8CFFC4", "#2DEC86", "#0E9B58"), "premium": ("#FFFFFF", "#C9D2D8", "#7E878E"), "ultra": ("#F6D77A", "#E0A93E", "#B97F1F")}
WX = {"sun": "#FFD60A", "moon": "#DCE3F0", "cloud": "#AEB4BD", "cloudDark": "#8E949E", "rain": "#5AC8FA", "bolt": "#FFD60A", "snow": "#EAF6FF"}
hexrgb = lambda h: tuple(int(h.lstrip('#')[i:i + 2], 16) for i in (0, 2, 4))

def sysfont(size):
    for p, idx in [("/System/Library/Fonts/SFCompact.ttf", 0), ("/System/Library/Fonts/Helvetica.ttc", 1), ("/System/Library/Fonts/Supplemental/Arial Bold.ttf", 0)]:
        if os.path.exists(p):
            try: return ImageFont.truetype(p, size, index=idx)
            except Exception: continue
    return ImageFont.load_default()

def glyph(font, name, table, size, color):
    f = ImageFont.truetype(font, int(size)); ch = chr(table[name]); l, t, r, b = f.getbbox(ch)
    im = Image.new('RGBA', (r - l + 4, b - t + 4), (0, 0, 0, 0)); ImageDraw.Draw(im).text((2 - l, 2 - t), ch, font=f, fill=hexrgb(color) + (255,))
    bb = im.getbbox(); return im.crop(bb) if bb else im

def paste_c(dst, im, cx, cy): dst.alpha_composite(im, (int(round(cx - im.width / 2)), int(round(cy - im.height / 2))))

def draw_wx(canvas, kind, cx, cy, G):
    ion = lambda n, s, c: glyph(ION, n, IM, s, c); mci = lambda n, s, c: glyph(MCI, n, MM, s, c)
    if kind == "clear-day": paste_c(canvas, ion("sunny", G, WX["sun"]), cx, cy)
    elif kind == "clear-night": paste_c(canvas, ion("moon", G * 0.92, WX["moon"]), cx, cy)
    elif kind == "cloudy": paste_c(canvas, ion("cloud", G * 0.95, WX["cloud"]), cx, cy)
    elif kind == "fog": paste_c(canvas, mci("weather-fog", G, WX["cloud"]), cx, cy)
    elif kind == "partly-day": paste_c(canvas, ion("sunny", G * 0.55, WX["sun"]), cx + G * 0.22, cy - G * 0.22); paste_c(canvas, ion("cloud", G * 0.80, WX["cloud"]), cx - G * 0.10, cy + G * 0.12)
    elif kind == "partly-night": paste_c(canvas, ion("moon", G * 0.5, WX["moon"]), cx + G * 0.22, cy - G * 0.22); paste_c(canvas, ion("cloud", G * 0.80, WX["cloud"]), cx - G * 0.10, cy + G * 0.12)
    elif kind == "rain":
        paste_c(canvas, ion("cloud", G * 0.78, WX["cloud"]), cx, cy - G * 0.15); d = ion("water", G * 0.30, WX["rain"]); paste_c(canvas, d, cx - G * 0.18, cy + G * 0.30); paste_c(canvas, d, cx + G * 0.18, cy + G * 0.30)
    elif kind == "snow": paste_c(canvas, ion("cloud", G * 0.78, WX["cloud"]), cx, cy - G * 0.15); paste_c(canvas, mci("snowflake", G * 0.40, WX["snow"]), cx, cy + G * 0.30)
    elif kind == "thunder": paste_c(canvas, ion("cloud", G * 0.78, WX["cloudDark"]), cx, cy - G * 0.15); paste_c(canvas, ion("flash", G * 0.52, WX["bolt"]), cx, cy + G * 0.28)
    elif kind == "none": paste_c(canvas, ion("flag", G * 0.8, "#FFFFFF"), cx, cy)

def gradient(w, h, stops, locs=(0, 0.45, 1)):
    img = Image.new('RGBA', (w, h)); px = img.load(); cs = [hexrgb(c) for c in stops]
    for y in range(h):
        t = y / max(1, h - 1)
        if t <= locs[1]: u = t / locs[1]; a, b = cs[0], cs[1]
        else: u = (t - locs[1]) / (1 - locs[1]); a, b = cs[1], cs[2]
        col = tuple(int(round(a[i] + (b[i] - a[i]) * u)) for i in range(3)) + (255,)
        for x in range(w): px[x, y] = col
    return img

def callout(skin, kind, temp, S=4, W=66, H=34, TAIL_H=8, TAIL_W=12, R=10, BORDER=1.5, BG=(12, 14, 18, 190)):
    """Rounded rect + bottom-centre tail, tip = the destination. Sizes in pt, rendered at S x."""
    w, h = W * S, (H + TAIL_H) * S
    # Build on a PADDED canvas: MinFilter replicates edge pixels, so a shape touching the image
    # edge never erodes there and the top/bottom border vanished (first mockup). Crop back after.
    P = int(BORDER * S) + 3
    fill = Image.new('L', (w + 2 * P, h + 2 * P), 0); d = ImageDraw.Draw(fill)
    d.rounded_rectangle([P, P, P + W * S - 1, P + H * S - 1], radius=R * S, fill=255)
    d.polygon([(P + W * S / 2 - TAIL_W * S / 2, P + H * S - 2), (P + W * S / 2, P + h - 1), (P + W * S / 2 + TAIL_W * S / 2, P + H * S - 2)], fill=255)
    er = fill.filter(ImageFilter.MinFilter(int(BORDER * S) * 2 + 1)); ring = ImageChops.subtract(fill, er)
    big = Image.new('RGBA', fill.size, (0, 0, 0, 0))
    big.paste(Image.new('RGBA', fill.size, BG), (0, 0), er); big.paste(gradient(fill.size[0], fill.size[1], SKINS[skin]), (0, 0), ring)
    im = big.crop((P, P, P + w, P + h))
    G = 22 * S; tf = sysfont(int(15 * S)); tw = tf.getlength(temp) if temp else 0; gap = 6 * S if temp else 0
    total = G * 0.95 + gap + tw; x0 = (W * S - total) / 2; cy = H * S / 2
    draw_wx(im, kind, x0 + G * 0.475, cy, G)
    if temp: ImageDraw.Draw(im).text((x0 + G * 0.95 + gap, cy), temp, font=tf, fill=(255, 255, 255, 255), anchor='lm')
    return im

def sheet(out):
    S = 4; kinds = [("clear-day", "24°"), ("rain", "12°"), ("partly-night", "9°"), ("none", "")]
    cw, ch = 110 * S, 70 * S
    img = Image.new('RGBA', (cw * 4 + 40, ch * 3 + 170), (34, 40, 48, 255)); dd = ImageDraw.Draw(img); lab = sysfont(int(12 * S))
    for si, skin in enumerate(SKINS):
        for ki, (kind, temp) in enumerate(kinds):
            c = callout(skin, kind, temp, S=S); ox = 20 + ki * cw + (cw - c.width) // 2; oy = 110 + si * ch + 8 * S
            img.alpha_composite(c, (ox, oy)); tipx, tipy = ox + c.width // 2, oy + c.height
            dd.ellipse([tipx - 3 * S, tipy - 3 * S, tipx + 3 * S, tipy + 3 * S], fill=(45, 236, 134, 255)); dd.ellipse([tipx - 1.2 * S, tipy - 1.2 * S, tipx + 1.2 * S, tipy + 1.2 * S], fill=(255, 255, 255, 255))
        dd.text((20, 110 + si * ch - 8 * S), {"brand": "Green (brand)", "premium": "Silver (Premium)", "ultra": "Gold (Ultra)"}[skin], font=lab, fill=(220, 225, 230, 255))
    dd.text((20, 10), "Destination callout: 66x34 pt + 8 pt tail, radius 10, dark 75% glass, 1.5 pt skin border. 4th = no forecast yet.", font=lab, fill=(200, 205, 210, 255))
    img.save(out); print("sheet", out, img.size)

def in_context(shot_path, out, skin="ultra", kind="cloudy", temp="20°"):
    """Composite over a real route-preview screenshot: find the old green pin (brand green) and put the
    callout's tip where the pin's tip was."""
    shot = Image.open(shot_path).convert('RGBA'); W, H = shot.size
    px = shot.load(); best = None
    for y in range(int(H * 0.15), int(H * 0.45)):          # the map band where the destination sat
        for x in range(0, int(W * 0.5)):
            r, g, b, a = px[x, y]
            if g > 200 and r < 110 and b < 170 and g - r > 90:   # candy green rim of the old pin
                if best is None or y > best[1]: best = (x, y)
    if best is None: raise SystemExit("green pin not found in the screenshot")
    tipx, tipy = best
    S = 3  # the screenshot is 3x
    c = callout(skin, kind, temp, S=S)
    # cover the old pin with a patch of nearby map first (the callout is wider than the pin)
    patch = shot.crop((tipx - 60, tipy - 190, tipx - 40, tipy + 6)).resize((80, 196))
    shot.alpha_composite(patch, (tipx - 40, tipy - 190))
    shot.alpha_composite(c, (tipx - c.width // 2, tipy - c.height))
    crop = shot.crop((max(0, tipx - 330), max(0, tipy - 330), min(W, tipx + 330), min(H, tipy + 260)))
    crop.save(out); print("context", out, crop.size, "tip", (tipx, tipy))

if __name__ == "__main__":
    S_DIR = sys.argv[1]
    sheet(os.path.join(S_DIR, "callout_sheet.png"))
    shot = sys.argv[2] if len(sys.argv) > 2 else None
    if shot: in_context(shot, os.path.join(S_DIR, "callout_context.png"))
