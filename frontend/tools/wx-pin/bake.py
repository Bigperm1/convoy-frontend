#!/usr/bin/env python3
"""Bake the destination WEATHER PIN images (Jeff, 2026-09-03: "change the green pin to the
weather for that destination … same size, floating … border in the skin colour").

Geometry is the brand pin's own silhouette (assets/images/brand-pin.png, 73x95): the alpha
mask is eroded to make a 2.5 pt outline in the skin metal, the body is dark glass, the head
hole gets a dark disc + a two-tone weather glyph (Ionicons / MaterialCommunityIcons TTFs from
@expo/vector-icons, same compositions as src/components/WeatherHUD.tsx), and a separate
temperature PILL (skin-bordered dark rounded rect) is baked once per skin.

Output: src/wxPinImages.ts — base64 PNG data URIs at 3x (219x285 px = 73x95 pt), so the phone
(RN Image) and CarPlay/AA (Mapbox Images + SymbolLayer) draw the IDENTICAL asset — parity by
construction — and the bytes ride the JS bundle (no OTA asset path-key trap).
Run: python3 tools/wx-pin/bake.py   (PIL only)
"""
import base64, io, json, os
from PIL import Image, ImageDraw, ImageFilter, ImageFont, ImageChops

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
SRC = os.path.join(ROOT, "assets/images/brand-pin.png")
FONTS = os.path.join(ROOT, "node_modules/@expo/vector-icons/build/vendor/react-native-vector-icons")
ION = os.path.join(FONTS, "Fonts/Ionicons.ttf")
MCI = os.path.join(FONTS, "Fonts/MaterialCommunityIcons.ttf")
ION_MAP = json.load(open(os.path.join(FONTS, "glyphmaps/Ionicons.json")))
MCI_MAP = json.load(open(os.path.join(FONTS, "glyphmaps/MaterialCommunityIcons.json")))
S = 2  # 2x raster (CarPlay draws the pin at 36.5x47.5 pt, the phone at 34x44 — 2x covers 3x DPR there)
W, H = 73 * S, 95 * S
HOLE_C = (36.5 * S, 36 * S)   # head hole centre (59 asset px above the bottom edge)
HOLE_R = 15.5 * S
OUTLINE_PX = int(round(2.5 * S))

SKINS = {  # vertical gradient light -> mid -> deep, from src/tierTheme.ts TIER_SKIN
    "brand":   ("#8CFFC4", "#2DEC86", "#0E9B58"),
    "premium": ("#FFFFFF", "#C9D2D8", "#7E878E"),
    "ultra":   ("#F6D77A", "#E0A93E", "#B97F1F"),
}
WX = {"sun": "#FFD60A", "moon": "#DCE3F0", "cloud": "#AEB4BD", "cloudDark": "#8E949E", "rain": "#5AC8FA", "bolt": "#FFD60A", "snow": "#EAF6FF"}
BODY = (15, 20, 24, 240)      # dark glass body
DISC = (10, 13, 16, 255)      # head disc behind the glyph

def hexrgb(h):
    h = h.lstrip("#"); return tuple(int(h[i:i+2], 16) for i in (0, 2, 4))

def gradient(w, h, stops, locs=(0, 0.45, 1)):
    img = Image.new("RGBA", (w, h))
    px = img.load()
    cs = [hexrgb(c) for c in stops]
    for y in range(h):
        t = y / max(1, h - 1)
        if t <= locs[1]:
            u = t / locs[1]; a, b = cs[0], cs[1]
        else:
            u = (t - locs[1]) / (1 - locs[1]); a, b = cs[1], cs[2]
        col = tuple(int(round(a[i] + (b[i] - a[i]) * u)) for i in range(3)) + (255,)
        for x in range(w): px[x, y] = col
    return img

def glyph_img(font_path, name, table, size_px, color):
    """Render one icon glyph tightly cropped, coloured, as RGBA."""
    cp = table[name]
    font = ImageFont.truetype(font_path, int(size_px))
    ch = chr(cp)
    l, t, r, b = font.getbbox(ch)
    im = Image.new("RGBA", (r - l + 4, b - t + 4), (0, 0, 0, 0))
    ImageDraw.Draw(im).text((2 - l, 2 - t), ch, font=font, fill=hexrgb(color) + (255,))
    bbox = im.getbbox()
    return im.crop(bbox) if bbox else im

def paste_center(dst, im, cx, cy):
    dst.alpha_composite(im, (int(round(cx - im.width / 2)), int(round(cy - im.height / 2))))

def draw_glyph(canvas, kind):
    """Same compositions as WeatherGlyph (WeatherHUD.tsx), sized to the head hole."""
    cx, cy = HOLE_C
    G = HOLE_R * 2 * 0.80   # glyph box ~80% of the hole diameter
    ion = lambda n, s, c: glyph_img(ION, n, ION_MAP, s, c)
    mci = lambda n, s, c: glyph_img(MCI, n, MCI_MAP, s, c)
    if kind == "clear-day":
        paste_center(canvas, ion("sunny", G, WX["sun"]), cx, cy)
    elif kind == "clear-night":
        paste_center(canvas, ion("moon", G * 0.92, WX["moon"]), cx, cy)
    elif kind == "cloudy":
        paste_center(canvas, ion("cloud", G * 0.95, WX["cloud"]), cx, cy)
    elif kind == "fog":
        paste_center(canvas, mci("weather-fog", G, WX["cloud"]), cx, cy)
    elif kind == "partly-day":
        paste_center(canvas, ion("sunny", G * 0.55, WX["sun"]), cx + G * 0.22, cy - G * 0.22)
        paste_center(canvas, ion("cloud", G * 0.80, WX["cloud"]), cx - G * 0.10, cy + G * 0.12)
    elif kind == "partly-night":
        paste_center(canvas, ion("moon", G * 0.5, WX["moon"]), cx + G * 0.22, cy - G * 0.22)
        paste_center(canvas, ion("cloud", G * 0.80, WX["cloud"]), cx - G * 0.10, cy + G * 0.12)
    elif kind == "rain":
        paste_center(canvas, ion("cloud", G * 0.78, WX["cloud"]), cx, cy - G * 0.15)
        d = ion("water", G * 0.30, WX["rain"])
        paste_center(canvas, d, cx - G * 0.18, cy + G * 0.30); paste_center(canvas, d, cx + G * 0.18, cy + G * 0.30)
    elif kind == "snow":
        paste_center(canvas, ion("cloud", G * 0.78, WX["cloud"]), cx, cy - G * 0.15)
        paste_center(canvas, mci("snowflake", G * 0.40, WX["snow"]), cx, cy + G * 0.30)
    elif kind == "thunder":
        paste_center(canvas, ion("cloud", G * 0.78, WX["cloudDark"]), cx, cy - G * 0.15)
        paste_center(canvas, ion("flash", G * 0.52, WX["bolt"]), cx, cy + G * 0.28)
    # "none": no glyph — a clean skin-ringed pin.

def bake_pin(skin, kind):
    base = Image.open(SRC).convert("RGBA").resize((W, H), Image.LANCZOS)
    alpha = base.split()[3].point(lambda a: 255 if a > 96 else 0)      # crisp silhouette
    inner = alpha.filter(ImageFilter.MinFilter(OUTLINE_PX * 2 + 1))    # eroded body
    # (No feathering here: blurring the metal band more than doubled the PNG bytes — 305 KB →
    # 685 KB of base64 — for an edge the phone draws at 34 pt where it cannot be seen.)
    outline = ImageChops.subtract(alpha, inner)
    out = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    body = Image.new("RGBA", (W, H), BODY); out.paste(body, (0, 0), inner)
    metal = gradient(W, H, SKINS[skin]); out.paste(metal, (0, 0), outline)
    # head disc (the asset's hole is transparent) + glyph
    disc = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    ImageDraw.Draw(disc).ellipse([HOLE_C[0] - HOLE_R, HOLE_C[1] - HOLE_R, HOLE_C[0] + HOLE_R, HOLE_C[1] + HOLE_R], fill=DISC)
    out.alpha_composite(disc)
    # thin inner rim on the disc in the metal (depth)
    rim = Image.new("L", (W, H), 0)
    ImageDraw.Draw(rim).ellipse([HOLE_C[0] - HOLE_R, HOLE_C[1] - HOLE_R, HOLE_C[0] + HOLE_R, HOLE_C[1] + HOLE_R], outline=255, width=int(1.2 * S))
    out.paste(metal, (0, 0), rim)
    draw_glyph(out, kind)
    # soft antialias of the outer edge. The edge mask must INCLUDE the head disc: the asset's
    # hole is transparent, so multiplying by the bare silhouette erased the disc and the glyph
    # (the first bake shipped empty heads — caught on the preview sheet).
    hole = Image.new("L", (W, H), 0)
    ImageDraw.Draw(hole).ellipse([HOLE_C[0] - HOLE_R, HOLE_C[1] - HOLE_R, HOLE_C[0] + HOLE_R, HOLE_C[1] + HOLE_R], fill=255)
    # Use the asset's own SOFT alpha for the outer edge (the hard threshold above is only for
    # deriving the outline band) so the metal rim keeps the original anti-aliasing.
    soft = base.split()[3]
    edge = ImageChops.lighter(soft, hole)
    r, g, b, a = out.split(); out = Image.merge("RGBA", (r, g, b, ImageChops.multiply(a, edge.point(lambda v: min(255, int(v * 1.02))))))
    return out

def bake_pill(skin):
    """Temperature pill: 30x18 pt, dark glass, skin border 1.5 pt, baked at 3x."""
    w, h = 30 * S, 18 * S
    im = Image.new("RGBA", (w, h), (0, 0, 0, 0))
    d = ImageDraw.Draw(im)
    d.rounded_rectangle([0, 0, w - 1, h - 1], radius=h // 2, fill=(15, 20, 24, 236))
    mask = Image.new("L", (w, h), 0)
    ImageDraw.Draw(mask).rounded_rectangle([0, 0, w - 1, h - 1], radius=h // 2, outline=255, width=int(1.5 * S))
    im.paste(gradient(w, h, SKINS[skin]), (0, 0), mask)
    return im

def b64(im):
    buf = io.BytesIO(); im.save(buf, "PNG", optimize=True); return base64.b64encode(buf.getvalue()).decode()

KINDS = ["none", "clear-day", "clear-night", "partly-day", "partly-night", "cloudy", "fog", "rain", "snow", "thunder"]
if __name__ == "__main__":
    lines = ["// GENERATED by tools/wx-pin/bake.py — do not edit by hand. Destination weather pin",
             "// images (73x95 pt @2x) + temperature pills (30x18 pt @2x), per skin x weather kind.",
             "// Why data URIs (not require()d PNGs): the bytes ride the JS bundle, so an OTA can",
             "// change them (expo-updates dedupes embedded assets by PATH) and both surfaces —",
             "// RN <Image> on the phone, Mapbox Images/SymbolLayer on CarPlay/AA — draw the SAME",
             "// pixels. See tools/wx-pin/bake.py for the geometry (the brand pin's own silhouette).",
             "export const WX_PIN_W = 73;", "export const WX_PIN_H = 95;", "export const WX_PILL_W = 30;", "export const WX_PILL_H = 18;",
             "export const WX_PIN_KINDS = " + json.dumps(KINDS) + " as const;",
             "export const WX_PIN_B64: Record<string, string> = {"]
    total = 0
    sheet = Image.new("RGBA", (W * len(KINDS), H * len(SKINS) + 18 * S * 2), (40, 44, 52, 255))
    for si, skin in enumerate(SKINS):
        for ki, kind in enumerate(KINDS):
            im = bake_pin(skin, kind); s = b64(im); total += len(s)
            lines.append(f'  "{skin}/{kind}": "{s}",')
            sheet.alpha_composite(im, (W * ki, H * si))
        pill = bake_pill(skin); s = b64(pill); total += len(s)
        lines.append(f'  "{skin}/pill": "{s}",')
        sheet.alpha_composite(pill, (W * si, H * len(SKINS)))
    lines.append("};")
    lines.append("export function wxPinUri(skin: string, kind: string): string { return 'data:image/png;base64,' + (WX_PIN_B64[skin + '/' + kind] ?? WX_PIN_B64['brand/none']); }")
    lines.append("export function wxPillUri(skin: string): string { return 'data:image/png;base64,' + (WX_PIN_B64[skin + '/pill'] ?? WX_PIN_B64['brand/pill']); }")
    out = os.path.join(ROOT, "src/wxPinImages.ts")
    open(out, "w").write("\n".join(lines) + "\n")
    sheet.save(os.path.join(ROOT, "tools/wx-pin/preview.png"))
    print(f"wrote {out}: {len(SKINS)*len(KINDS)} pins + {len(SKINS)} pills, base64 total {total/1024:.0f} KB; preview tools/wx-pin/preview.png")
