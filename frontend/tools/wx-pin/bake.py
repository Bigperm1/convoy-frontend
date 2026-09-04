#!/usr/bin/env python3
"""Bake the destination WEATHER CALLOUT images (Jeff, 2026-09-03, approved off the mockup in
tools/wx-pin/mock_callout.py): "a rectangle (rounded corners), dark transparent background, weather in
the middle (temp/glyph), skin border not too thick, tapered to a point at the destination spot" — and
"when someone has weather off in settings it can be the flag".

Geometry (pt): box 70x34, radius 10, 1.5 pt border in the tier metal (vertical gradient), dark glass
fill (75%), 8 pt tail centred at the bottom whose TIP is the destination. Glyph (two-tone, the
WeatherGlyph compositions) centred at x=21; the TEMPERATURE is NOT baked — it is dynamic text drawn by
the app at x=38 (left edge), y=17 (centre): RN <Text> on the phone, a SymbolLayer textField on CarPlay.
`none` (weather layer off / no forecast yet) = the flag, centred, no text.

Output: src/wxCalloutImages.ts — base64 PNG data URIs at 2x (140x84 px), so the phone (RN Image) and
CarPlay/AA (Mapbox Images + SymbolLayer) draw the IDENTICAL asset and the bytes ride the JS bundle
(OTA-able; no asset path-key trap). Run: python3 tools/wx-pin/bake.py   (PIL only)
"""
import base64, io, json, os
from PIL import Image, ImageDraw, ImageFilter, ImageFont, ImageChops

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
FONTS = os.path.join(ROOT, "node_modules/@expo/vector-icons/build/vendor/react-native-vector-icons")
ION = os.path.join(FONTS, "Fonts/Ionicons.ttf"); MCI = os.path.join(FONTS, "Fonts/MaterialCommunityIcons.ttf")
ION_MAP = json.load(open(os.path.join(FONTS, "glyphmaps/Ionicons.json"))); MCI_MAP = json.load(open(os.path.join(FONTS, "glyphmaps/MaterialCommunityIcons.json")))
S = 2                       # 2x raster
BOX_W, BOX_H, TAIL_H, TAIL_W, RADIUS, BORDER = 70, 34, 8, 12, 10, 1.5   # pt
GLYPH_CX, GLYPH_PT = 21, 22  # glyph centre x, glyph box size (pt)
TEXT_X, TEXT_CY = 38, 17     # where the app draws the temperature (pt, from the box's top-left)
BG = (12, 14, 18, 190)
SKINS = {"brand": ("#8CFFC4", "#2DEC86", "#0E9B58"), "premium": ("#FFFFFF", "#C9D2D8", "#7E878E"), "ultra": ("#F6D77A", "#E0A93E", "#B97F1F")}
WX = {"sun": "#FFD60A", "moon": "#DCE3F0", "cloud": "#AEB4BD", "cloudDark": "#8E949E", "rain": "#5AC8FA", "bolt": "#FFD60A", "snow": "#EAF6FF"}
KINDS = ["none", "clear-day", "clear-night", "partly-day", "partly-night", "cloudy", "fog", "rain", "snow", "thunder"]
hexrgb = lambda h: tuple(int(h.lstrip("#")[i:i + 2], 16) for i in (0, 2, 4))

def gradient(w, h, stops, locs=(0, 0.45, 1)):
    img = Image.new("RGBA", (w, h)); px = img.load(); cs = [hexrgb(c) for c in stops]
    for y in range(h):
        t = y / max(1, h - 1)
        if t <= locs[1]: u = t / locs[1]; a, b = cs[0], cs[1]
        else: u = (t - locs[1]) / (1 - locs[1]); a, b = cs[1], cs[2]
        col = tuple(int(round(a[i] + (b[i] - a[i]) * u)) for i in range(3)) + (255,)
        for x in range(w): px[x, y] = col
    return img

def glyph(font, name, table, size, color):
    f = ImageFont.truetype(font, int(size)); ch = chr(table[name]); l, t, r, b = f.getbbox(ch)
    im = Image.new("RGBA", (r - l + 4, b - t + 4), (0, 0, 0, 0)); ImageDraw.Draw(im).text((2 - l, 2 - t), ch, font=f, fill=hexrgb(color) + (255,))
    bb = im.getbbox(); return im.crop(bb) if bb else im

def paste_c(dst, im, cx, cy): dst.alpha_composite(im, (int(round(cx - im.width / 2)), int(round(cy - im.height / 2))))

def draw_wx(canvas, kind, cx, cy, G):
    ion = lambda n, s, c: glyph(ION, n, ION_MAP, s, c); mci = lambda n, s, c: glyph(MCI, n, MCI_MAP, s, c)
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

def bake_callout(skin, kind):
    w, h = BOX_W * S, (BOX_H + TAIL_H) * S
    P = int(BORDER * S) + 3   # padded canvas: MinFilter replicates edges, an edge-touching shape never erodes there
    fill = Image.new("L", (w + 2 * P, h + 2 * P), 0); d = ImageDraw.Draw(fill)
    d.rounded_rectangle([P, P, P + BOX_W * S - 1, P + BOX_H * S - 1], radius=RADIUS * S, fill=255)
    d.polygon([(P + w / 2 - TAIL_W * S / 2, P + BOX_H * S - 2), (P + w / 2, P + h - 1), (P + w / 2 + TAIL_W * S / 2, P + BOX_H * S - 2)], fill=255)
    er = fill.filter(ImageFilter.MinFilter(int(BORDER * S) * 2 + 1)); ring = ImageChops.subtract(fill, er)
    big = Image.new("RGBA", fill.size, (0, 0, 0, 0))
    big.paste(Image.new("RGBA", fill.size, BG), (0, 0), er); big.paste(gradient(fill.size[0], fill.size[1], SKINS[skin]), (0, 0), ring)
    im = big.crop((P, P, P + w, P + h))
    if kind == "none": draw_wx(im, "none", w / 2, BOX_H * S / 2, GLYPH_PT * S)          # flag, centred, no text
    else: draw_wx(im, kind, GLYPH_CX * S, BOX_H * S / 2, GLYPH_PT * S)
    return im

def b64(im):
    buf = io.BytesIO(); im.save(buf, "PNG", optimize=True); return base64.b64encode(buf.getvalue()).decode()

if __name__ == "__main__":
    lines = ["// GENERATED by tools/wx-pin/bake.py — do not edit by hand. Destination weather CALLOUT images",
             "// (70x42 pt incl. the 8 pt tail, @2x), per skin x weather kind; 'none' = the flag (weather off / no",
             "// forecast). The temperature is NOT baked: the app draws it at (WX_CALLOUT_TEXT_X, WX_CALLOUT_TEXT_CY).",
             "// Data URIs on purpose: the bytes ride the JS bundle (OTA-able, no asset path-key trap) and the phone",
             "// (RN Image) and CarPlay/AA (Mapbox Images + SymbolLayer) draw the SAME pixels.",
             f"export const WX_CALLOUT_W = {BOX_W};", f"export const WX_CALLOUT_H = {BOX_H + TAIL_H};", f"export const WX_CALLOUT_BOX_H = {BOX_H};",
             f"export const WX_CALLOUT_TEXT_X = {TEXT_X};", f"export const WX_CALLOUT_TEXT_CY = {TEXT_CY};", f"export const WX_CALLOUT_SCALE = {S};",
             "export const WX_CALLOUT_KINDS = " + json.dumps(KINDS) + " as const;",
             "export const WX_CALLOUT_B64: Record<string, string> = {"]
    total = 0
    sheet = Image.new("RGBA", (BOX_W * S * len(KINDS) + 20 * (len(KINDS) + 1), (BOX_H + TAIL_H) * S * len(SKINS) + 20 * (len(SKINS) + 1)), (34, 40, 48, 255))
    for si, skin in enumerate(SKINS):
        for ki, kind in enumerate(KINDS):
            im = bake_callout(skin, kind); s = b64(im); total += len(s)
            lines.append(f'  "{skin}/{kind}": "{s}",')
            sheet.alpha_composite(im, (20 + ki * (BOX_W * S + 20), 20 + si * ((BOX_H + TAIL_H) * S + 20)))
    lines.append("};")
    lines.append("export function wxCalloutUri(skin: string, kind: string): string { return 'data:image/png;base64,' + (WX_CALLOUT_B64[skin + '/' + kind] ?? WX_CALLOUT_B64['brand/none']); }")
    out = os.path.join(ROOT, "src/wxCalloutImages.ts")
    open(out, "w").write("\n".join(lines) + "\n")
    sheet.save(os.path.join(ROOT, "tools/wx-pin/preview.png"))
    print(f"wrote {out}: {len(SKINS)*len(KINDS)} callouts, base64 total {total/1024:.0f} KB; preview tools/wx-pin/preview.png")
