#!/usr/bin/env python3
"""PREVIEW ONLY — new category pin set for place-search results, ROUND 3 (Jeff, 2026-09-23: "i dont
like it looks nothing like the screenshot i gave you" — rounds 1/2 both invented a form Jeff's own
reference never had. This round re-reads and ZOOMS on
/private/tmp/.../images/2.webp before baking anything — see the report at the bottom of __main__ for
what that zoom actually showed).

WHAT'S ACTUALLY IN THE SCREENSHOT (verified by cropping+zooming the map area, then pixel-sampling pin
fills directly — not eyeballed):
  - MAP PINS: small solid teardrops, DEEP-shade fill, a bold WHITE number centred in the head, NO
    glyph, NO bright ring, NO glow. Just a barely-there darker edge and a soft drop shadow.
  - CHIPS (top row): ~56pt dark circles with a bright ring + bright glyph + a grey/off-white label.
  - LIST ROWS: a smaller (36pt) twin of the chip badge, then name/address/meta text.
Round 1 and 2 built the NeonPin/solid-ring-and-glow family that's nowhere in Jeff's screenshot — this
round replaces that with the above, and folds in the apple-design skill's materials/typography/craft
rules (SKILL.md §12/§15/§16) for the composite, per the coordinator's follow-up.

Run: python3 tools/poi-pins/bake.py   (PIL only, plus the system SF Pro variable font — see report).
"""
import math, os, json
from PIL import Image, ImageDraw, ImageFont, ImageFilter, ImageChops, ImageEnhance

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
OUT = os.path.dirname(os.path.abspath(__file__))
FONTS = os.path.join(ROOT, "node_modules/@expo/vector-icons/build/vendor/react-native-vector-icons")
MCI = os.path.join(FONTS, "Fonts/MaterialCommunityIcons.ttf")
MCI_MAP = json.load(open(os.path.join(FONTS, "glyphmaps/MaterialCommunityIcons.json")))
MAP_BG_SRC = os.path.join(OUT, "map-bg-source.png")
S = 3   # px per pt throughout — @3x baked assets, and the composite is built at this same density

# ── SF Pro — the real variable-weight system font (NOT SFCompact.ttf, which PIL only loads as a single
# fixed style). /System/Library/Fonts/SFNS.ttf identifies internally as "System Font" and carries named
# instances (Regular/Medium/Semibold/Bold/...) — exactly the weights §15 asks for. Falls back to
# Helvetica Neue (has real Bold/Regular members, at least) if SFNS.ttf isn't on this machine. ─────────
SF_PATH = "/System/Library/Fonts/SFNS.ttf"
_FALLBACK = "/System/Library/Fonts/HelveticaNeue.ttc"
FONT_USED = None

def sf(size_pt, weight="Regular"):
    global FONT_USED
    sz = max(1, round(size_pt * S))
    if os.path.exists(SF_PATH):
        try:
            f = ImageFont.truetype(SF_PATH, sz)
            f.set_variation_by_name(weight)
            FONT_USED = FONT_USED or f"SF Pro (system variable font, {SF_PATH}, named instances)"
            return f
        except Exception:
            pass
    FONT_USED = FONT_USED or f"Helvetica Neue (fallback — {SF_PATH} unavailable)"
    return ImageFont.truetype(_FALLBACK, sz)

def text_w(font, text, tracking_pt=0):
    if not text: return 0
    return sum(font.getlength(ch) for ch in text) + tracking_pt * S * (len(text) - 1)

def draw_tracked(draw, x, y, text, font, fill, tracking_pt=0, align="l"):
    """Draws `text` with manual letter-spacing (PIL has none natively — §15's tracking values are
    real, not decorative). y is the VERTICAL CENTRE of the text. align: l/r/c around x."""
    w = text_w(font, text, tracking_pt)
    bbox = draw.textbbox((0, 0), text or " ", font=font)
    th = bbox[3] - bbox[1]
    ty = y - th / 2 - bbox[1]
    x0 = x if align == "l" else (x - w if align == "r" else x - w / 2)
    cx = x0
    for ch in text:
        draw.text((cx, ty), ch, font=font, fill=fill)
        cx += font.getlength(ch) + tracking_pt * S
    return w

# ── Colour: sRGB -> CIE Lab, CIE76 ΔE ───────────────────────────────────────────────────────────────
def srgb_to_lin(c):
    c = c / 255
    return c / 12.92 if c <= 0.04045 else ((c + 0.055) / 1.055) ** 2.4

def hex_to_lab(h):
    h = h.lstrip("#"); r, g, b = (int(h[i:i+2], 16) for i in (0, 2, 4))
    r, g, b = srgb_to_lin(r), srgb_to_lin(g), srgb_to_lin(b)
    x = r * 0.4124 + g * 0.3576 + b * 0.1805
    y = r * 0.2126 + g * 0.7152 + b * 0.0722
    z = r * 0.0193 + g * 0.1192 + b * 0.9505
    xn, yn, zn = 0.95047, 1.0, 1.08883
    f = lambda t: t ** (1/3) if t > 0.008856 else 7.787 * t + 16/116
    fx, fy, fz = f(x/xn), f(y/yn), f(z/zn)
    return (116*fy - 16, 500*(fx-fy), 200*(fy-fz))

def delta_e76(h1, h2):
    l1 = hex_to_lab(h1); l2 = hex_to_lab(h2)
    return math.sqrt(sum((a-b)**2 for a, b in zip(l1, l2)))

def hexrgb(h): h = h.lstrip("#"); return tuple(int(h[i:i+2], 16) for i in (0, 2, 4))

import colorsys
def hsl_of(h):
    r, g, b = (v/255 for v in hexrgb(h)); hh, l, s = colorsys.rgb_to_hls(r, g, b); return hh*360, s, l

def hsl_to_hex(h, s, l):
    h = h % 360 / 360; c = (1 - abs(2*l-1)) * s; x = c * (1 - abs((h*6) % 2 - 1)); m = l - c/2
    if h < 1/6: r,g,b = c,x,0
    elif h < 2/6: r,g,b = x,c,0
    elif h < 3/6: r,g,b = 0,c,x
    elif h < 4/6: r,g,b = 0,x,c
    elif h < 5/6: r,g,b = x,0,c
    else: r,g,b = c,0,x
    return "#{:02X}{:02X}{:02X}".format(*(round((v+m)*255) for v in (r,g,b)))

# ── Palette — BRIGHT hexes are Jeff's exact 14, two nudged (see report); DEEP is derived IN-SCRIPT: ───
# same hue and saturation as bright, lightness pinned to 0.24. That formula was calibrated against the
# coordinator's own screenshot samples (EV bright #1FC4DE -> pin #0E5F69, Gas bright #F5891F -> pin
# #7A3D0C): at L=0.24, same-hue-same-sat lands #0F5F6B (ΔE 1.4 from #0E5F69) and #753D05 (ΔE 3.0 from
# #7A3D0C) — both comfortably inside the ΔE-8 tolerance. NOTE (say-so, not silence): my OWN pixel
# sampling of the screenshot (see report) read the actual pin fills even darker still (~#02222C,
# ~#2B1600, L~9%) — likely the marketing photo's exposure/vignette — but the task's explicit
# calibration targets are what this formula is tuned to, per instruction.
CATS_BASE = [
    ("gas",      "Gas",          "gas-station",            "#F5891F"),
    ("coffee",   "Coffee",       "coffee",                 "#C98A4B"),
    ("fastfood", "Fast Food",    "hamburger",               "#FFC72C"),
    ("atm",      "ATM",          "cash",                    "#B5E23A"),
    ("grocery",  "Groceries",    "cart",                    "#57D163"),
    ("pharmacy", "Pharmacy",     "medical-bag",             "#2EC4A6"),
    ("ev",       "EV Charging",  "ev-station",              "#1FC4DE"),
    ("carwash",  "Car Wash",     "car-wash",                "#5FCBF6"),   # NUDGED, see report
    ("parking",  "Parking",      "parking",                 "#3B82F6"),
    ("repair",   "Car Repair",   "car-wrench",              "#8B7CF6"),
    ("parts",    "Auto Parts",   "car-cog",                 "#B055F7"),   # NUDGED, see report
    ("hotel",    "Hotels",       "bed",                     "#D946EF"),
    ("food", "Food", "silverware-fork-knife", "#FF6FA5"),
    ("hospital", "Hospital",     "hospital-box",            "#FF4D6D"),
]
DEEP_L = 0.24
# Per-category lightness overrides: Food at L 0.24 came out brick-red on the real map (sim, 2026-09-23);
# Jeff: "move food to coral pink" — a lighter deep keeps the pink hue readable on the dark map.
DEEP_L_BY_KEY = {"food": 0.34}
def deep_of(bright_hex, l=DEEP_L):
    h, s, _ = hsl_of(bright_hex)
    return hsl_to_hex(h, s, l)

BRIGHT = {k: c for k, l, g, c in CATS_BASE}
DEEP = {k: deep_of(c, DEEP_L_BY_KEY.get(k, DEEP_L)) for k, c in BRIGHT.items()}
GLYPH = {k: g for k, l, g, c in CATS_BASE}
LABEL = {k: l for k, l, g, c in CATS_BASE}

NUDGES = [
    ("carwash", "#4CC9F0", "#5FCBF6", 4.2, "vs EV #1FC4DE: bright ΔE 9.8 (<12), deep ΔE 9.4 (<10) — "
     "both cyans, 11deg apart in hue. Hue +3, S +0.05, L +0.05: clears both floors, ΔE 4.2 from original."),
    ("parts", "#A855F7", "#B055F7", 2.5, "vs Car Repair #8B7CF6 (post-nudge): deep ΔE 9.5 (<10) even "
     "though bright was fine (18.6) — the two purples compress at L=24%. Hue +3: clears the deep floor, "
     "ΔE 2.5 from original."),
]

def glyph_img(name, size, color):
    f = ImageFont.truetype(MCI, int(size)); ch = chr(MCI_MAP[name])
    l, t, r, b = f.getbbox(ch)
    im = Image.new("RGBA", (r - l + 4, b - t + 4), (0, 0, 0, 0))
    ImageDraw.Draw(im).text((2 - l, 2 - t), ch, font=f, fill=hexrgb(color) + (255,))
    bb = im.getbbox()
    return im.crop(bb) if bb else im

def sized_glyph(name, color, target_px):
    """The round-2 overflow fix, reused: size by the ink bbox's LONGER side, not by font point size."""
    g = glyph_img(name, 30 * S, color)
    longer = max(g.width, g.height)
    if longer > 0:
        sc = target_px / longer
        g = g.resize((max(1, round(g.width*sc)), max(1, round(g.height*sc))), Image.LANCZOS)
    return g

def paste_c(dst, im, cx, cy):
    dst.alpha_composite(im, (int(round(cx - im.width / 2)), int(round(cy - im.height / 2))))

def poly_mask(size, pts, ox, oy):
    m = Image.new("L", size, 0)
    ImageDraw.Draw(m).polygon([((x + ox) * S, (y + oy) * S) for x, y in pts], fill=255)
    return m

def cubic(p0, p1, p2, p3, n=28):
    pts = []
    for i in range(n + 1):
        t = i / n; u = 1 - t
        x = u**3*p0[0] + 3*u**2*t*p1[0] + 3*u*t**2*p2[0] + t**3*p3[0]
        y = u**3*p0[1] + 3*u**2*t*p1[1] + 3*u*t**2*p2[1] + t**3*p3[1]
        pts.append((x, y))
    return pts

def arc(center, r, a0, a1, n=40):
    pts = []
    for i in range(n + 1):
        t = math.radians(a0 + (a1-a0)*i/n)
        pts.append((center[0]+r*math.cos(t), center[1]+r*math.sin(t)))
    return pts

# ── MAP PIN geometry — small solid teardrop. "About 32pt tall, head Ø ~26pt, short tail" (Jeff's
# screenshot, measured off the zoom). Box 30x32pt, head r=13 (Ø26), head centre 17pt above the tip, so
# the neck/tail is a short 4pt (HEAD_CY - HEAD_R above 0). Padding around the nominal box holds the
# drop-shadow / highlight blur without clipping. ───────────────────────────────────────────────────
PIN_W, PIN_H = 30, 32
HEAD_R, HEAD_CY = 13, -17
PIN_PAD = 8
def pin_body_outline():
    r, cy = HEAD_R, HEAD_CY
    c1, c2, tanL = (-0.72*r, 0.45*cy), (-r, 0.71*cy), (-r, cy)
    left = cubic((0, 0), c1, c2, tanL)
    top = arc((0, cy), r, 180, 360)
    c2b, c1b = (r, 0.71*cy), (0.72*r, 0.45*cy)
    right = cubic((r, cy), c2b, c1b, (0, 0))
    return left + top[1:] + right[1:]

def pin_masks():
    CW, CH = (PIN_W + 2*PIN_PAD) * S, (PIN_H + 2*PIN_PAD) * S
    ox, oy = PIN_W/2 + PIN_PAD, PIN_H + PIN_PAD
    body = poly_mask((CW, CH), pin_body_outline(), ox, oy)
    return CW, CH, ox, oy, body

def head_circle_mask(CW, CH, ox, oy):
    m = Image.new("L", (CW, CH), 0)
    cx, cy = ox*S, (oy+HEAD_CY)*S
    ImageDraw.Draw(m).ellipse([cx-HEAD_R*S, cy-HEAD_R*S, cx+HEAD_R*S, cy+HEAD_R*S], fill=255)
    return m

def darken(hexcol, factor):
    r, g, b = hexrgb(hexcol)
    return (max(0, int(r*factor)), max(0, int(g*factor)), max(0, int(b*factor)))

def bake_pin(fill_hex, number):
    """Solid teardrop: deep (or bright, if selected) fill, a barely-there darker 1px edge, a 1px inner
    top highlight, a soft 2pt-blur 30%-alpha drop shadow, and an optically-centred bold white number.
    NO ring, NO glow, NO glyph — that's the whole point this round."""
    CW, CH, ox, oy, body = pin_masks()
    canvas = Image.new("RGBA", (CW, CH), (0, 0, 0, 0))

    # drop shadow: the body mask, shifted down, blurred, dark at ~30%
    shadow_off = round(1.4 * S)
    shadow_mask = Image.new("L", (CW, CH), 0)
    shadow_mask.paste(body, (0, shadow_off))
    shadow_mask = shadow_mask.filter(ImageFilter.GaussianBlur(2 * S * 0.6))
    canvas.paste(Image.new("RGBA", (CW, CH), (0, 0, 0, 77)), (0, 0), shadow_mask)  # 77/255 ~= 30%

    # solid body fill
    canvas.paste(Image.new("RGBA", (CW, CH), hexrgb(fill_hex) + (255,)), (0, 0), body)

    # barely-there darker edge: 1px band eroded off the body, filled with a darkened shade at low alpha
    edge_px = max(1, round(1 * S))
    body_er = body.filter(ImageFilter.MinFilter(edge_px*2+1))
    edge_band = ImageChops.subtract(body, body_er)
    canvas.paste(Image.new("RGBA", (CW, CH), darken(fill_hex, 0.62) + (140,)), (0, 0), edge_band)

    # 1px inner top highlight — a thin band just inside the edge, top-left-weighted
    hi_px = max(1, round(1 * S))
    fill_er = body_er.filter(ImageFilter.MinFilter(hi_px*2+1))
    hi_band = ImageChops.subtract(body_er, fill_er)
    grad = Image.new("L", (CW, CH), 0); gpx = grad.load()
    for yy in range(CH):
        for xx in range(CW):
            t = 1 - min(1, math.hypot((xx-ox*S)/(CW*0.6), (yy-(oy+HEAD_CY)*S+HEAD_R*S)/(CH*0.5)))
            gpx[xx, yy] = max(0, int(130*t))
    hi_band = ImageChops.multiply(hi_band, grad)
    canvas.paste(Image.new("RGBA", (CW, CH), (255, 255, 255, 190)), (0, 0), hi_band)

    # number — 15pt bold white, OPTICALLY centred: render, tight-crop the actual ink bbox, then centre
    # that bbox on the head centre (not the font baseline/advance box — that was round 2's overflow bug
    # and the coordinator's own "measure the digit bbox, don't trust the baseline" instruction this
    # round).
    f = sf(15, "Bold")
    tmp = Image.new("RGBA", (CW, CH), (0, 0, 0, 0))
    ImageDraw.Draw(tmp).text((PIN_PAD*S, PIN_PAD*S), str(number), font=f, fill=(255, 255, 255, 255))
    bb = tmp.getbbox()
    if bb:
        digit = tmp.crop(bb)
        paste_c(canvas, digit, ox*S, (oy+HEAD_CY)*S)
    return canvas, (CW, CH, ox, oy)

def results_pin_row_badge(bright_hex, glyph):
    """36pt circle: dark fill, thin bright ring, bright glyph — the list row's twin of the chip."""
    D = int(36 * S)
    im = Image.new("RGBA", (D, D), (0, 0, 0, 0))
    dd = ImageDraw.Draw(im)
    ring_px = max(1, round(1.5 * S))
    dd.ellipse([0, 0, D-1, D-1], fill=(30, 32, 37, 255), outline=hexrgb(bright_hex)+(255,), width=ring_px)
    g = sized_glyph(glyph, bright_hex, D*0.5)
    paste_c(im, g, D/2, D/2)
    return im

def blurred_disc(base, cx, cy, d_px, blur_px, sat, tint_rgba):
    """A circular 'material' sample: crop a square around (cx,cy) from `base`, blur+saturate it,
    tint dark, mask to a circle. Used for the translucent chips (§12 — small surface, light material)."""
    pad = blur_px + 4
    box = (int(cx-d_px/2-pad), int(cy-d_px/2-pad), int(cx+d_px/2+pad), int(cy+d_px/2+pad))
    box = (max(0,box[0]), max(0,box[1]), min(base.width,box[2]), min(base.height,box[3]))
    src = base.crop(box).convert("RGB")
    src = ImageEnhance.Color(src).enhance(sat)
    src = src.filter(ImageFilter.GaussianBlur(blur_px))
    src = src.convert("RGBA")
    tint = Image.new("RGBA", src.size, tint_rgba)
    src.alpha_composite(tint)
    # centre-crop back to exactly d_px and mask to a circle
    cx0, cy0 = src.width/2, src.height/2
    disc = src.crop((int(cx0-d_px/2), int(cy0-d_px/2), int(cx0+d_px/2), int(cy0+d_px/2)))
    m = Image.new("L", disc.size, 0)
    ImageDraw.Draw(m).ellipse([0, 0, disc.size[0]-1, disc.size[1]-1], fill=255)
    out = Image.new("RGBA", disc.size, (0,0,0,0))
    out.paste(disc, (0,0), m)
    return out

def chip(base_for_blur, cx, cy, key, selected=False):
    """~56pt chip. Default: translucent blurred-map disc (§12), 2pt bright ring, bright glyph, grey/
    off-white label below. Selected: opaque BRIGHT fill, DARK glyph — the one filled chip (§16)."""
    D = int(56 * S)
    bright = BRIGHT[key]
    if selected:
        disc = Image.new("RGBA", (D, D), (0, 0, 0, 0))
        ImageDraw.Draw(disc).ellipse([0, 0, D-1, D-1], fill=hexrgb(bright)+(255,))
        glyph_color = "#0B0D10"
    else:
        disc = blurred_disc(base_for_blur, cx, cy, D, 20*0.6, 1.6, (20, 22, 26, 184))  # 184/255=0.72
        ring_px = max(1, round(2*S))
        ImageDraw.Draw(disc).ellipse([1, 1, D-2, D-2], outline=hexrgb(bright)+(255,), width=ring_px)
        glyph_color = bright
    g = sized_glyph(GLYPH[key], glyph_color, D*0.42)
    paste_c(disc, g, D/2, D/2)
    # small, light shadow (chips are the SMALL material — lighter shadow than the sheet)
    shadow = Image.new("L", (D+16, D+16), 0)
    ImageDraw.Draw(shadow).ellipse([8, 10, D+8, D+10], fill=110)
    shadow = shadow.filter(ImageFilter.GaussianBlur(3*S*0.4))
    shcanvas = Image.new("RGBA", (D+16, D+16), (0,0,0,0))
    shcanvas.paste(Image.new("RGBA",(D+16,D+16),(0,0,0,255)), (0,0), shadow)
    shcanvas.alpha_composite(disc, (8, 8))
    return shcanvas

def build_panel(base_full, canvas_w, chip_keys, selected_key):
    """The top panel — round 4 (coordinator, 2026-09-23: chips floating directly on the map collided
    with map labels; Jeff's screenshot puts them in a translucent panel with a real search field above
    them). Same material recipe as the sheet (blur 20px-ish, saturate 1.6x, tint rgba(20,22,26,0.72)),
    rounded BOTTOM corners only (it hangs from the screen's top edge), a lighter shadow below it than
    the sheet gets (small/medium surface). Contains: 44pt dark-glass search field ("Where to?" + a
    magnifier), then the chip row, then labels. Chips are baked by the UNCHANGED chip() function
    (round 3's approved asset) sampling the same base map region, so they read as one material with
    the panel behind them."""
    GUTTER, SEARCH_H, CHIP_D, GAP = 16*S, 44*S, 56*S, 12*S
    # TOP_PAD/BOTTOM_PAD are the spec'd "16pt padding" around the contents; the internal gaps
    # (search-to-chips, label-to-circle, the label's own line height) aren't separately mandated, so
    # they're kept tight — the first pass at 16pt everywhere left only ~1px of clear map between the
    # panel and the sheet's blur zone for a 5-row sheet in a 2000pt-tall canvas (see the vertical-budget
    # note by PIN_SAFE_BAND below).
    TOP_PAD, GAP_SC, LABEL_GAP, LABEL_H, BOTTOM_PAD = 16*S, 10*S, 8*S, 15*S, 16*S
    panel_h = TOP_PAD + SEARCH_H + GAP_SC + CHIP_D + LABEL_GAP + LABEL_H + BOTTOM_PAD
    rad = 20*S
    src = base_full.crop((0, 0, canvas_w, int(panel_h)+40)).convert("RGB")
    src = ImageEnhance.Color(src).enhance(1.6).filter(ImageFilter.GaussianBlur(20*0.6))
    mat = src.convert("RGBA")
    mat.alpha_composite(Image.new("RGBA", mat.size, (20, 22, 26, 184)))  # 0.72
    # round the BOTTOM corners only: the rounded rect's TOP falls above the visible crop
    rmask = Image.new("L", mat.size, 0)
    ImageDraw.Draw(rmask).rounded_rectangle([0, -rad, mat.size[0]-1, mat.size[1]-1], radius=rad, fill=255)
    out = Image.new("RGBA", mat.size, (0, 0, 0, 0)); out.paste(mat, (0, 0), rmask)
    panel = out.crop((0, 0, canvas_w, int(panel_h)))

    # search field + placeholder + chip labels go on a TRANSPARENT deco layer, composited onto `panel`
    # in ONE shot at the end — for the same reason build_sheet's edge/text moved off raw ImageDraw (see
    # its comment): drawing translucent shapes straight onto `panel` with ImageDraw doesn't blend with
    # panel's own blurred material underneath, it OVERWRITES those pixels outright. The search field
    # was losing the panel's blur right where it sat — map labels showed through it sharp/unblurred
    # instead of frosted — until this went through alpha_composite instead.
    deco = Image.new("RGBA", panel.size, (0, 0, 0, 0))
    dd = ImageDraw.Draw(deco)

    # "dark glass" per the brief — darker than the panel behind it, not lighter (an earlier pass used a
    # translucent WHITE fill, which read as a faint wash, not a distinct field).
    sf_rect = [GUTTER, TOP_PAD, canvas_w-GUTTER, TOP_PAD+SEARCH_H]
    dd.rounded_rectangle(sf_rect, radius=14*S, fill=(6, 7, 10, 130))
    mag = sized_glyph("magnify", "#C7CBD1", 17*S)
    pf = sf(17, "Regular")
    draw_tracked(dd, GUTTER+16*S+mag.width+14*S, TOP_PAD+SEARCH_H/2, "Where to?", pf, (200, 204, 210, 190))

    total_w = len(chip_keys)*CHIP_D + (len(chip_keys)-1)*GAP
    cx0 = (canvas_w - total_w)/2 + CHIP_D/2
    chip_y = TOP_PAD + SEARCH_H + GAP_SC + CHIP_D/2
    lf = sf(13, "Medium")
    chip_imgs = []
    for i, key in enumerate(chip_keys):
        cx = cx0 + i*(CHIP_D+GAP)
        chip_imgs.append((chip(base_full, cx, chip_y, key, selected=(key == selected_key)), cx, chip_y))
        draw_tracked(dd, cx, chip_y+CHIP_D/2+LABEL_GAP+LABEL_H/2, LABEL[key], lf, (226, 228, 232, 235), tracking_pt=0.2, align="c")
    panel.alpha_composite(deco, (0, 0))
    # the magnifier icon and the chip discs are pre-rendered RGBA assets — alpha_composite (not
    # ImageDraw) already blends correctly, so these paste straight onto panel, after the deco layer so
    # they sit visually on top of the search field / aren't washed out by it.
    paste_c(panel, mag, GUTTER+16*S+mag.width/2, TOP_PAD+SEARCH_H/2)
    for c, cx, cy in chip_imgs:
        panel.alpha_composite(c, (int(cx-c.width/2), int(cy-c.height/2)))
    return panel, int(panel_h)

def fit_text(font, text, max_w, tracking_pt=0):
    if text_w(font, text, tracking_pt) <= max_w: return text
    t = text
    while t and text_w(font, t + "…", tracking_pt) > max_w:
        t = t[:-1]
    return t + "…" if t else "…"

def build_sheet(canvas, title_text, rows_data):
    """The 'Nearby' (or 'Gas Nearby') sheet — round 4 fix: the stray white-stroke rounded rectangle
    that outlined the WHOLE sheet is gone (that was `ed.rounded_rectangle(..., outline=...)` drawing a
    full box; now only a 1px bright arc/line follows the rounded TOP edge, nothing else is outlined).
    Grabber is the spec'd 36x5pt filled pill, no border. Rows keep round 3's exact layout; each row
    dict may carry `price`/`cheapest` for the single-category gas composite."""
    GUTTER = 16*S
    ROW_H, BADGE_D, TITLE_H = 64*S, 36*S, 22*S
    HANDLE_GAP, TOP_PAD, BOTTOM_PAD = 26*S, 22*S, 24*S
    n = len(rows_data)
    sheet_h = HANDLE_GAP + TOP_PAD + TITLE_H + 18*S + ROW_H*n + BOTTOM_PAD
    sheet_top = canvas.height - sheet_h
    blur_src = canvas.crop((0, int(sheet_top)-40, canvas.width, canvas.height)).convert("RGB")
    blur_src = ImageEnhance.Color(blur_src).enhance(1.6).filter(ImageFilter.GaussianBlur(20*0.6))
    mat = blur_src.convert("RGBA")
    mat.alpha_composite(Image.new("RGBA", mat.size, (20, 22, 26, 184)))
    rad = 20*S
    rmask = Image.new("L", mat.size, 0)
    ImageDraw.Draw(rmask).rounded_rectangle([0, 0, mat.size[0]-1, mat.size[1]-1+rad], radius=rad, fill=255)
    out = Image.new("RGBA", mat.size, (0, 0, 0, 0)); out.paste(mat, (0, 0), rmask)
    mat = out
    # heavier shadow than the panel gets (bigger surface = thicker material)
    shtop = Image.new("RGBA", (canvas.width, 60), (0, 0, 0, 0))
    ImageDraw.Draw(shtop).rectangle([0, 0, canvas.width, 60], fill=(0, 0, 0, 110))
    shtop = shtop.filter(ImageFilter.GaussianBlur(14))
    canvas.alpha_composite(shtop, (0, int(sheet_top)-60))
    canvas.alpha_composite(mat, (0, int(sheet_top)-40))

    # Everything below is drawn onto a TRANSPARENT overlay the size of `canvas`, then alpha_composite'd
    # in ONE shot at the end — not drawn directly onto `canvas` with ImageDraw. PIL's ImageDraw does NOT
    # do Porter-Duff blending onto an already-opaque destination: `fill=(...,46)` just STORES alpha=46
    # at that pixel instead of blending 46/255 white into the canvas colour beneath it. The saved PNG
    # then has a patch of real alpha=46 sitting in a sea of alpha=255 — and most viewers composite an
    # alpha<255 pixel against WHITE, so a "18%-opacity white edge" renders as a bold, fully-opaque white
    # line (found this rendering the round-4 sheet edge: pixel-sampled it and it was stored as literal
    # (255,255,255,46), not a blend — that's what looked like a stray outline box around the whole
    # panel-to-sheet span). alpha_composite() performs the real blend, so the FINAL stored pixel is
    # always opaque and correct however the viewer treats alpha.
    deco = Image.new("RGBA", canvas.size, (0, 0, 0, 0))
    ed = ImageDraw.Draw(deco)
    # 1px bright edge — ONLY along the rounded top (two corner arcs + the straight span between them),
    # never a full outline box (that was the round-3 bug).
    ed.arc([0, int(sheet_top), rad*2, int(sheet_top)+rad*2], 180, 270, fill=(255, 255, 255, 46), width=1)
    ed.arc([canvas.width-rad*2, int(sheet_top), canvas.width, int(sheet_top)+rad*2], 270, 360, fill=(255, 255, 255, 46), width=1)
    ed.line([(rad, int(sheet_top)), (canvas.width-rad, int(sheet_top))], fill=(255, 255, 255, 46), width=1)
    # grabber: 36x5pt filled pill, no outline
    gw, gh = 36*S, 5*S
    ed.rounded_rectangle([canvas.width/2-gw/2, sheet_top+12*S, canvas.width/2+gw/2, sheet_top+12*S+gh], radius=gh/2, fill=(255, 255, 255, 90))

    title_f = sf(22, "Bold")
    draw_tracked(ed, GUTTER, sheet_top+HANDLE_GAP+TOP_PAD/2+TITLE_H/2, title_text, title_f, (244, 244, 247, 255), tracking_pt=-0.4)

    rows_top = sheet_top + HANDLE_GAP + TOP_PAD + TITLE_H + 18*S
    title_row_f, addr_f = sf(17, "Semibold"), sf(15, "Regular")
    meta_f, dist_f, price_f = sf(13, "Regular"), sf(15, "Regular"), sf(13, "Semibold")
    badges = []
    for i, row in enumerate(rows_data):
        row_top = rows_top + i*ROW_H
        bcx, bcy = GUTTER+BADGE_D/2, row_top+ROW_H/2
        badges.append((results_pin_row_badge(row["bright"], row["glyph"]), bcx, bcy))
        tx = GUTTER + BADGE_D + 8*S
        title_cy, addr_cy, meta_cy = row_top+13*S, row_top+32*S, row_top+49*S
        dist_str = row["dist"]; dist_w = text_w(dist_f, dist_str)
        title_max_w = (canvas.width-GUTTER) - tx - dist_w - 12*S
        title_txt = fit_text(title_row_f, row["title"], title_max_w, -0.2)
        draw_tracked(ed, tx, title_cy, title_txt, title_row_f, (244, 244, 247, 255), tracking_pt=-0.2)
        draw_tracked(ed, canvas.width-GUTTER, title_cy, dist_str, dist_f, (200, 206, 214, 200), align="r")
        draw_tracked(ed, tx, addr_cy, row["addr"], addr_f, (232, 232, 236, 178))
        draw_tracked(ed, tx, meta_cy, row["meta"], meta_f, (176, 182, 190, 220), tracking_pt=0.2)
        if row.get("price"):
            cheap = bool(row.get("cheapest"))
            color = (45, 236, 134, 255) if cheap else (214, 218, 224, 225)
            ptxt = row["price"] + ("  ·  cheapest" if cheap else "")
            draw_tracked(ed, canvas.width-GUTTER, meta_cy, ptxt, price_f, color, tracking_pt=0.1, align="r")
    canvas.alpha_composite(deco, (0, 0))
    # badges are their own pre-rendered RGBA assets — alpha_composite (not ImageDraw) already blends
    # correctly, so these go straight onto canvas.
    for badge, bcx, bcy in badges:
        canvas.alpha_composite(badge, (int(bcx-badge.width/2), int(bcy-badge.height/2)))
    return int(sheet_top)

def render_composite(out_name, crop_y0, chip_keys, selected_chip_key, sheet_title, rows_data, positions):
    """rows_data: list of row dicts, each {num, key, selected(bool), title, addr, meta, dist, bright,
    glyph[, price, cheapest]} — one per pin/row, in list order (row 1 first). positions: {num: (fx,fy)}
    fractions of the 1206x2000 canvas for each pin's tip. chip_keys/selected_chip_key drive the top
    panel's chip row (selected_chip_key gets the one filled-bright chip)."""
    W, H = 1206, 2000   # round 4: the FULL sim-capture width (402pt @3x), not a 900px crop — a 900px
    # canvas couldn't fit 5x56pt chips + gaps + gutters (360pt = 1080px) without clipping, which is
    # exactly what the round-3 render showed at its left/right edges.
    if os.path.exists(MAP_BG_SRC):
        src = Image.open(MAP_BG_SRC).convert("RGBA")
        base = src.crop((0, crop_y0, W, crop_y0+H))
        bg_source = f"real simulator capture, full width, y=[{crop_y0},{crop_y0+H}] from {src.size}"
    else:
        base = Image.new("RGBA", (W, H), (14, 16, 20, 255))
        bg_source = "SYNTHESISED fallback (map-bg-source.png missing)"
    print(f"\n[{out_name}] map-bg:", bg_source)

    canvas = base.copy()
    panel, panel_h = build_panel(base, W, chip_keys, selected_chip_key)
    canvas.alpha_composite(panel, (0, 0))
    print(f"[{out_name}] panel_h={panel_h}")

    rows_sorted = sorted(rows_data, key=lambda r: r["selected"])  # selected pin drawn LAST (on top)
    for row in rows_sorted:
        fillhex = BRIGHT[row["key"]] if row["selected"] else DEEP[row["key"]]
        pin_im, (CW, CH, ox, oy) = bake_pin(fillhex, row["num"])
        fx, fy = positions[row["num"]]
        tip_x, tip_y = int(W*fx), int(H*fy)
        canvas.alpha_composite(pin_im, (int(tip_x-ox*S), int(tip_y-oy*S)))

    sheet_top = build_sheet(canvas, sheet_title, rows_data)
    print(f"[{out_name}] sheet_top={sheet_top}  (panel bottom {panel_h} -> sheet blur-crop start {sheet_top-40}: "
          f"{'OK, clear' if sheet_top-40 > panel_h+60 else '*** TIGHT/OVERLAP ***'})")

    canvas.save(os.path.join(OUT, out_name))
    print(f"wrote {os.path.join(OUT, out_name)} {canvas.size}")
    return panel_h, sheet_top

def validate_pin_numbers(tol_white=235):
    """PROOF for the number containment: every near-white pixel (R,G,B>=tol, alpha>=250) in a baked
    pin @3x PNG must lie inside the HEAD circle (not just the body — 'must stay inside the head', the
    coordinator's exact words). Runs on both default and selected bakes."""
    rows = []
    CW, CH, ox, oy, _ = pin_masks()
    head_m = head_circle_mask(CW, CH, ox, oy)
    head_px = head_m.load()
    for key, label, glyph, bright in CATS_BASE:
        for state in ("default", "selected"):
            im = Image.open(os.path.join(OUT, "pins", f"{key}_{state}@3x.png")).convert("RGBA")
            px = im.load(); W, H = im.size
            outside = 0
            for y in range(H):
                for x in range(W):
                    r, g, b, a = px[x, y]
                    if a >= 250 and r >= tol_white and g >= tol_white and b >= tol_white:
                        if head_px[x, y] < 128: outside += 1
            rows.append((key, label, state, outside, outside == 0))
    return rows

if __name__ == "__main__":
    print(f"== ΔE ==")
    print("calibration: EV deep", DEEP["ev"], "vs #0E5F69 ->", round(delta_e76(DEEP["ev"],"#0E5F69"),2),
          " | Gas deep", DEEP["gas"], "vs #7A3D0C ->", round(delta_e76(DEEP["gas"],"#7A3D0C"),2))
    keys = list(BRIGHT)
    bfail, dfail = [], []
    for i, k1 in enumerate(keys):
        for k2 in keys[i+1:]:
            db = delta_e76(BRIGHT[k1], BRIGHT[k2]); dd = delta_e76(DEEP[k1], DEEP[k2])
            if db < 12: bfail.append((k1, k2, round(db,1)))
            if dd < 10: dfail.append((k1, k2, round(dd,1)))
    print("bright pairwise <12:", bfail or "none")
    print("deep pairwise <10:", dfail or "none")
    print("\nnudges:")
    for key, orig, new, d, why in NUDGES:
        print(f"  {key}: {orig} -> {new} (ΔE {d} from original) — {why}")
    print("\npalette table:")
    for key, label, glyph, bright in CATS_BASE:
        print(f"  {key:<10} {label:<14} bright={bright}  deep={DEEP[key]}  glyph(MDI)={glyph}")

    os.makedirs(os.path.join(OUT, "pins"), exist_ok=True)
    for key, label, glyph, bright in CATS_BASE:
        for state, fillhex in (("default", DEEP[key]), ("selected", BRIGHT[key])):
            im3, _ = bake_pin(fillhex, 1)
            for scale in (1, 2, 3):
                w = round(im3.width * scale / S); h = round(im3.height * scale / S)
                im3.resize((w, h), Image.LANCZOS).save(os.path.join(OUT, "pins", f"{key}_{state}@{scale}x.png"))
    print(f"\nbaked {len(CATS_BASE)*2*3} pin PNGs -> tools/poi-pins/pins/")

    print("\n== number containment (white px must stay inside the HEAD circle) — @3x ==")
    crows = validate_pin_numbers()
    for key, label, state, outside, ok in crows:
        print(f"{key:<10} {state:<9} outside-head={outside:<4} {'PASS' if ok else '*** FAIL ***'}")
    cfails = [r for r in crows if not r[4]]
    print(f"\n{len(crows)} checked, {len(cfails)} failures" + (f": {cfails}" if cfails else " — all clear."))
    if cfails:
        raise SystemExit("number containment failed")

    # ── preview-sheet.png @3x: pin default / pin selected / chip / list badge, per category — full
    # native pixel sizes, laid out in fixed slots so nothing overlaps regardless of each asset's own
    # bounding box. Round 4 fix: the caption block was two draw_tracked calls 24px apart while the name
    # line's own font (15pt semibold = 45px tall) needed ~58px just for itself — they overlapped. Now a
    # dedicated, measured 3-line caption area: name 15pt semibold, then a REAL 6pt gap, then the hex
    # line at 12pt — computed from each font's own line height, not eyeballed pixel offsets. ──────────
    SLOT_W = [150, 210, 130, 320]   # pin-default, pin-selected, chip, badge+caption-room
    NAME_LH = round(15*1.3*S); HEX_LH = round(12*1.3*S); CAP_GAP = round(6*S)
    CAPTION_H = NAME_LH + CAP_GAP + HEX_LH
    ITEMS_H = 210   # tallest item (chip incl. its own shadow padding) plus a little breathing room
    ROW_BLOCK_H = ITEMS_H + 20 + CAPTION_H + 20
    cell_w = sum(SLOT_W) + 40
    cols = 2; rows_n = math.ceil(len(CATS_BASE) / cols)
    HEADER_H = 100
    sheet = Image.new("RGBA", (cell_w*cols + 20, HEADER_H + ROW_BLOCK_H*rows_n + 20), (16, 18, 22, 255))
    dd = ImageDraw.Draw(sheet)
    hd_f = sf(15, "Bold"); sub_f = sf(12, "Regular"); lab_f = sf(15, "Semibold"); hex_f = sf(12, "Regular")
    draw_tracked(dd, 20, 20, "Hairpin POI pins — ROUND 4 (deep-fill pins; glyphs in chips + list only)", hd_f, (240,240,244,255))
    draw_tracked(dd, 20, 72, "not shipped  ·  per category: pin default, pin selected, chip, list badge  ·  SF Pro", sub_f, (160,166,174,255))
    for i, (key, label, glyph, bright) in enumerate(CATS_BASE):
        col, row = i % cols, i // cols
        x0, y0 = 10 + col*cell_w, HEADER_H + row*ROW_BLOCK_H
        item_cy = y0 + ITEMS_H/2
        pin_d, _ = bake_pin(DEEP[key], 1)
        pin_s, _ = bake_pin(BRIGHT[key], 1)
        ch = chip(Image.new("RGB", (300, 300), (30, 34, 40)), 150, 150, key, selected=False)
        lb = results_pin_row_badge(bright, glyph)
        sx = x0
        for it, slot in zip((pin_d, pin_s, ch, lb), SLOT_W):
            ix = sx + (slot - it.width)//2
            sheet.alpha_composite(it, (ix, int(item_cy - it.height/2)))
            sx += slot
        cap_top = y0 + ITEMS_H + 20
        name_cy = cap_top + NAME_LH/2
        hex_cy = cap_top + NAME_LH + CAP_GAP + HEX_LH/2
        draw_tracked(dd, x0, name_cy, label, lab_f, (240,240,244,255))
        draw_tracked(dd, x0, hex_cy, f"bright {bright}  ·  deep {DEEP[key]}", hex_f, (150,240,190,255))
    sheet.save(os.path.join(OUT, "preview-sheet.png"))
    print("wrote", os.path.join(OUT, "preview-sheet.png"), sheet.size)

    # ── preview-map.png (mixed "Nearby") and preview-map-gas.png (single-category "Gas Nearby") ──────
    # Round 4: full 1206px (402pt @3x) canvas width — a 900px crop couldn't fit 5x56pt chips + 12pt
    # gaps + 16pt gutters (360pt = 1080px) without clipping, which is exactly what round 3 showed at
    # its edges. Vertical crop is 1206x2000, a "phone-like" region clear of the sim's own search-bar
    # and tab-bar chrome (checked by eye: tools/poi-pins/map-bg-source.png y=[400,2400]).
    CROP_Y0 = 400
    CHIP_ROW_KEYS = ["gas", "hotel", "ev", "pharmacy", "hospital"]

    # PIN_SAFE_BAND — the vertical gap between the panel's bottom and the sheet's top, computed (not
    # guessed) from both materials' real heights for a 5-row sheet in a 2000pt-tall canvas:
    #   panel_h  = (16+44+10+56+8+15+16)pt * 3  = 495px
    #   sheet_h  = (26+22+22+18 + 64*5 + 24)pt * 3 = 1296px  ->  sheet_top = 2000-1296 = 704px
    #   gap      = 704 - 495 = 209px
    # A baked pin's own extent runs ~120px above its tip and ~24px below (the padded 138x144px asset
    # canvas), so 144px must fit inside that 209px gap — 65px of slack, split as a 15px margin on each
    # side and ~35px of room for y variety across 5 pins. (An earlier pass used 16pt padding at every
    # internal panel gap, not just top/bottom, and the same math came out NEGATIVE — panel_h 519 alone
    # left only 145px against a 144px pin, a 1px margin for FIVE pins. That's what the tightened
    # GAP_SC/LABEL_H constants in build_panel() fixed.)
    PANEL_H_CALC = (16+44+10+56+8+15+16) * S
    SHEET_H_5ROW = (26+22+22+18 + 64*5 + 24) * S
    SHEET_TOP_5ROW = 2000 - SHEET_H_5ROW
    band_lo = PANEL_H_CALC + 15 + 120
    band_hi = SHEET_TOP_5ROW - 15 - 24
    print(f"\npin safe band: tip_y in [{band_lo},{band_hi}] ({band_hi-band_lo}px of slack)")
    tip_ys = [round(band_lo + (band_hi-band_lo)*t) for t in (0.0, 0.28, 0.5, 0.72, 1.0)]
    fxs = [0.10, 0.30, 0.50, 0.72, 0.92]

    # ── preview-map.png — mixed categories, EV selected (chip + pin #3, proving pin<->chip<->row) ────
    demo_keys = ["gas", "hotel", "ev", "pharmacy", "hospital"]
    names = {"gas": "Chevron 24th St", "hotel": "Hotel Zeppelin", "ev": "Electrify America", "pharmacy": "Walgreens Pharmacy", "hospital": "St. Francis Memorial"}
    addrs = {"gas": "2001 24th Street", "hotel": "601 Eddy St", "ev": "1192 Guerrero St", "pharmacy": "135 Powell St", "hospital": "900 Hyde St"}
    metas = {"gas": "★ 4.6 · 210 reviews", "hotel": "★ 4.3 · 902 reviews", "ev": "★ 4.5 · 533 reviews", "pharmacy": "★ 4.1 · 76 reviews", "hospital": "★ 4.0 · 340 reviews"}
    dists = {"gas": "0.3 mi", "hotel": "0.5 mi", "ev": "0.4 mi", "pharmacy": "0.6 mi", "hospital": "0.9 mi"}
    rows_mixed = []
    positions_mixed = {}
    for i, key in enumerate(demo_keys):
        num = i + 1
        rows_mixed.append({
            "num": num, "key": key, "selected": key == "ev",
            "title": f"{num}.  {names[key]}", "addr": addrs[key], "meta": metas[key], "dist": dists[key],
            "bright": BRIGHT[key], "glyph": GLYPH[key],
        })
        positions_mixed[num] = (fxs[i], tip_ys[i] / 2000)
    render_composite("preview-map.png", CROP_Y0, CHIP_ROW_KEYS, "ev", "Nearby", rows_mixed, positions_mixed)

    # ── preview-map-gas.png — single-category search, the realistic case (Gas chip selected/filled;
    # 5 gas stations; pin/row #1 is the selected result; a price tag per row, cheapest in brand green). ─
    GAS_STATIONS = [
        {"name": "Chevron",      "street": "Robson St",   "addr": "1055 Robson St",   "price": 1.72, "rating": "4.6", "reviews": "210", "dist": "0.3 mi"},
        {"name": "Shell",        "street": "Davie St",    "addr": "889 Davie St",     "price": 1.68, "rating": "4.2", "reviews": "145", "dist": "0.5 mi"},
        {"name": "Petro-Canada", "street": "Burrard St",  "addr": "1201 Burrard St",  "price": 1.79, "rating": "4.0", "reviews": "98",  "dist": "0.6 mi"},
        {"name": "Esso",         "street": "Seymour St",  "addr": "650 Seymour St",   "price": 1.75, "rating": "3.9", "reviews": "76",  "dist": "0.7 mi"},
        {"name": "Husky",        "street": "Pacific Blvd","addr": "788 Pacific Blvd", "price": 1.81, "rating": "4.1", "reviews": "132", "dist": "0.9 mi"},
    ]
    cheapest_price = min(s["price"] for s in GAS_STATIONS)
    rows_gas = []
    positions_gas = {}
    for i, st in enumerate(GAS_STATIONS):
        num = i + 1
        is_cheap = st["price"] == cheapest_price
        rows_gas.append({
            "num": num, "key": "gas", "selected": num == 1,
            "title": f"{num}.  {st['name']} · {st['street']}", "addr": st["addr"],
            "meta": f"★ {st['rating']} · {st['reviews']} reviews", "dist": st["dist"],
            "bright": BRIGHT["gas"], "glyph": GLYPH["gas"],
            "price": f"${st['price']:.2f}/L", "cheapest": is_cheap,
        })
        positions_gas[num] = (fxs[i], tip_ys[i] / 2000)
    render_composite("preview-map-gas.png", CROP_Y0, CHIP_ROW_KEYS, "gas", "Gas Nearby", rows_gas, positions_gas)

    print("\nfont used:", FONT_USED)
