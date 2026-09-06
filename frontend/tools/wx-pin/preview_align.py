#!/usr/bin/env python3
"""BEFORE/AFTER preview of the destination-weather-callout temperature alignment fix
(Jeff, 2026-09-05: "the numerical temperature off-center — make sure it is aligned with
the glyph"). Reuses tools/wx-pin/bake.py's real baked-callout renderer (same skins, same
glyph compositions) and reproduces the phone's <Text> placement two ways:

BEFORE (shipped code, src/ConvoyMapbox.tsx pre-fix): a fixed lineHeight:20 box positioned
at top=TEXT_CY-10=7pt. TextKit/includeFontPadding puts the font's ascender line at the TOP
of that box and appends the box's extra leading (lineHeight 20 vs the font's natural
~16.6pt line height at 14pt) BELOW the baseline instead of splitting it — so the ink (which
for digits/degree-sign has no descender to fill that reserved space) renders visibly HIGH
in the box, off the glyph's baked vertical centre (BOX_H/2 = 17pt, from bake.py).

AFTER (fixed code): a View of height=WX_CALLOUT_BOX_H with justifyContent:'center' wrapping
a Text with no forced lineHeight — RN/Yoga centres the text's own natural (untouched) line
box, which is close to the font's actual ascent+descent, on the container's midpoint (17pt),
matching where bake.py centred the glyph. No more manual TEXT_CY math on the phone.

Font metrics measured 2026-09-05 via PIL against /System/Library/Fonts/SFNS.ttf (San
Francisco — RN's default system font on iOS) at size 14, weight ~800:
  ascent=13.625pt, descent=3.0pt (natural line height 16.625pt vs the old fixed 20pt box)
  ink bbox for "19deg"  : top=3.5pt  bottom=13.875pt (relative to the ascender line)
  ink bbox for "104deg" : top=3.5pt  bottom=13.875pt, width 38.75pt (WIDER than the 70pt-
                          -32pt-glyph = 38pt of remaining box width at TEXT_X=38 — flagged
                          separately, not fixed here, this pass is vertical-alignment only)
  ink bbox for "-4deg"  : top=3.75pt bottom=13.75pt
Under the BEFORE model (ascender line at box top, y=7pt): ink centre lands at
  7 + (3.5+13.875)/2 = 15.69pt  -> 1.31pt ABOVE the glyph's 17pt centre (HYPOTHESIS on the
  exact leading split — TextKit's behaviour isn't publicly exact-specified — but directionally
  the documented RN "extra leading below baseline" quirk, and the fix removes the dependency
  on it either way by not forcing an oversized lineHeight).
Under the AFTER model (natural box centred at 17pt): ink centre lands at
  17 + ((3.5+13.875)/2 - 16.625/2) = 17.34pt -> within 0.4pt of the glyph centre.

Run: python3 tools/wx-pin/preview_align.py   (PIL only, no app/JS involved)
"""
import os, sys
from PIL import Image, ImageDraw, ImageFont

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import bake  # tools/wx-pin/bake.py — reuse the real baked-callout renderer

ROOT = bake.ROOT
FONT_PATH = "/System/Library/Fonts/SFNS.ttf"
SCALE = 3  # preview px-per-pt (the "3x" the brief asked for)

TEXT_ROWS = [
    ("brand", "clear-day", "19°"),
    ("premium", "cloudy", "104°"),
    ("ultra", "rain", "-4°"),
]

PAD = 14
LABEL_H = 22
CELL_W = bake.BOX_W * SCALE + PAD * 2
CELL_H = (bake.BOX_H + bake.TAIL_H) * SCALE + PAD * 2 + LABEL_H
COL_LABEL_H = 26


def make_font(size_pt):
    f = ImageFont.truetype(FONT_PATH, int(size_pt * SCALE))
    try:
        f.set_variation_by_axes([800])  # extra-bold, matching fontWeight:"800"
    except Exception:
        pass
    return f


def callout_at_scale(skin, kind):
    im = bake.bake_callout(skin, kind)  # native S=2 raster
    target_w = bake.BOX_W * SCALE
    target_h = (bake.BOX_H + bake.TAIL_H) * SCALE
    return im.resize((target_w, target_h), Image.LANCZOS)


def draw_variant(skin, kind, temp, mode):
    """mode: 'before' (buggy lineHeight box) or 'after' (flex-centred natural box)."""
    base = callout_at_scale(skin, kind).convert("RGBA")
    canvas = Image.new("RGBA", base.size, (0, 0, 0, 0))
    canvas.alpha_composite(base)
    draw = ImageDraw.Draw(canvas)
    font = make_font(14)

    text_x = bake.TEXT_X * SCALE
    box_center_y = (bake.BOX_H / 2) * SCALE  # == bake.TEXT_CY * SCALE, the glyph's own centre

    # Faint horizontal guide through the glyph's baked vertical centre.
    draw.line([(0, box_center_y), (bake.BOX_W * SCALE, box_center_y)], fill=(255, 255, 255, 90), width=1)

    if mode == "before":
        # Old code: top = TEXT_CY - 10, height 20, lineHeight 20 — ascender line at the
        # TOP of that 20pt box (RN/TextKit's "extra leading appended below" behaviour).
        box_top = (bake.TEXT_CY - 10) * SCALE
        draw.text((text_x, box_top), temp, font=font, fill=(255, 255, 255, 255), anchor="la")
    else:
        # New code: height=WX_CALLOUT_BOX_H, justifyContent:'center' — centres the text's
        # own natural (ascent+descent) box on the container's midpoint == glyph centre.
        draw.text((text_x, box_center_y), temp, font=font, fill=(255, 255, 255, 255), anchor="lm")

    return canvas


def label(draw, xy, text, size=13, color=(230, 233, 237, 255)):
    f = ImageFont.truetype(FONT_PATH, size)
    draw.text(xy, text, font=f, fill=color)


def main():
    cols = ["before", "after"]
    W = COL_LABEL_H + CELL_W * len(cols) + PAD
    H = LABEL_H + CELL_H * len(TEXT_ROWS) + PAD
    sheet = Image.new("RGBA", (W, H), (20, 23, 27, 255))
    d = ImageDraw.Draw(sheet)

    title_f = ImageFont.truetype(FONT_PATH, 16)
    d.text((PAD, 6), "BEFORE (shipped)                                              AFTER (fixed)", font=title_f, fill=(255, 255, 255, 255))

    for ri, (skin, kind, temp) in enumerate(TEXT_ROWS):
        row_y = LABEL_H + ri * CELL_H
        label(d, (4, row_y + CELL_H / 2 - 8), f"{skin}\n{kind}", size=11, color=(170, 176, 184, 255))
        for ci, mode in enumerate(cols):
            cell = draw_variant(skin, kind, temp, mode)
            x = COL_LABEL_H + ci * CELL_W + PAD
            y = row_y + PAD
            sheet.alpha_composite(cell, (x, y))
            label(d, (x, y + cell.height + 2), f'"{temp}"  ({mode})')

    out = os.path.join(ROOT, "tools/wx-pin/preview_align.png")
    sheet.save(out)
    print(f"wrote {out} ({W}x{H})")


if __name__ == "__main__":
    main()
