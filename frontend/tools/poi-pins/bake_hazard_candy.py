#!/usr/bin/env python3
"""bake_hazard_candy.py — the Hazards FAB / CarPlay map-button triangle in the CANDY finish the crew and 2D/3D glyphs wear
(Jeff, 2026-09-25: "the hazard on the fab doesn't have the same type of effect as the 3d or crew glyphs"): a light-to-deep
vertical ramp in the metal, a gloss band on the upper half, a thin dark edge and a soft drop shadow, the bang punched out.
132×132 px = 44 pt @3x — the same box as assets/images/premium/*_candy*.png and the CarPlay icons.
  python3 tools/poi-pins/bake_hazard_candy.py   → assets/images/premium/hazard_candy{,_silver,_gold,_diamond}.png
"""
import os, subprocess, tempfile, sys
ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
# top / mid / bottom stops per metal — the candy ramp (NEON_TONE's rim = light, glow = mid; a deeper third stop)
RAMPS = {
    "":         ("#C6FFE0", "#2DEC86", "#0E9C52"),   # brand green
    "_silver":  ("#FFFFFF", "#D3DBE1", "#8A96A0"),
    "_gold":    ("#FFF3C2", "#E7B549", "#A6761A"),
    "_diamond": ("#FFFFFF", "#B7EBFF", "#6CB9EA"),
}
TRI = "M32 9 L57 51 H7 Z"
BANG = '<path d="M32 23 V37" fill="none" stroke="#000" stroke-width="4.6" stroke-linecap="round"/><circle cx="32" cy="45" r="2.6" fill="#000"/>'

def svg(top, mid, bot, transform=None):
    # `transform` is for the HEAD-UNIT cut only (bake_car_hazard_icons.py); None renders the phone art unchanged.
    body = f'''<g mask="url(#m)" filter="url(#sh)">
  <path d="{TRI}" fill="url(#ramp)" stroke="{bot}" stroke-opacity="0.55" stroke-width="1.2" stroke-linejoin="round"/>
  <g clip-path="url(#c)"><ellipse cx="32" cy="18" rx="22" ry="14" fill="url(#gloss)"/></g>
</g>'''
    if transform:
        body = f'<g transform="{transform}">\n{body}\n</g>'
    return f'''<svg viewBox="0 0 64 64" width="132" height="132" xmlns="http://www.w3.org/2000/svg">
<defs>
  <linearGradient id="ramp" gradientUnits="userSpaceOnUse" x1="0" y1="9" x2="0" y2="52">
    <stop offset="0" stop-color="{top}"/><stop offset="0.5" stop-color="{mid}"/><stop offset="1" stop-color="{bot}"/>
  </linearGradient>
  <linearGradient id="gloss" gradientUnits="userSpaceOnUse" x1="0" y1="10" x2="0" y2="34">
    <stop offset="0" stop-color="#FFFFFF" stop-opacity="0.55"/><stop offset="1" stop-color="#FFFFFF" stop-opacity="0"/>
  </linearGradient>
  <mask id="m" maskUnits="userSpaceOnUse" x="0" y="0" width="64" height="64"><rect width="64" height="64" fill="#fff"/>{BANG}</mask>
  <clipPath id="c"><path d="{TRI}"/></clipPath>
  <filter id="sh" x="-20%" y="-20%" width="140%" height="150%"><feDropShadow dx="0" dy="1.2" stdDeviation="1.1" flood-color="#000" flood-opacity="0.45"/></filter>
</defs>
{body}
</svg>'''

def main():
    out = os.path.join(ROOT, "assets/images/premium")
    for suf, (top, mid, bot) in RAMPS.items():
        html = f'<!doctype html><html><head><meta charset="utf-8"><style>body{{margin:0;background:transparent;width:132px;height:132px}}</style></head><body>{svg(top, mid, bot)}</body></html>'
        with tempfile.TemporaryDirectory() as d:
            h = os.path.join(d, "g.html"); open(h, "w").write(html)
            png = os.path.join(out, f"hazard_candy{suf}.png")
            subprocess.run([CHROME, "--headless=new", "--disable-gpu", "--hide-scrollbars", "--force-device-scale-factor=1",
                            "--default-background-color=00000000", "--window-size=132,132", f"--screenshot={png}", f"file://{h}"], check=True, capture_output=True)
            print("wrote", png)

if __name__ == "__main__":
    main()
