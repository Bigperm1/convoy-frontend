# Report-grid glyphs (CarPlay / Android Auto) — direction B "Apple symbol", picked by Jeff 2026-09-24

Six tiles × four metals, 224 px on a 256 px transparent canvas (cut-outs are true holes):
`police` (shield with a P) · `crash` · `hazard` · `traffic` · `camera` (speed cam) · `compass`, each as
`_green` (yours) · `_silver` (Premium) · `_gold` (Ultra Premium) · `_diamond` (unlocked by the first 3D scan).
Flat accent per metal from `src/tierTheme.ts` (`TIER_SKIN.*.accent`; brand `#2DEC86`; diamond `#A9E7FF`).

Masters live in `gen_b.py` (64-unit SVG box). Re-bake: `python3 gen_b.py .` then headless Chrome
`--default-background-color=00000000 --window-size=1536,1024 --screenshot=bake.png sheet-b.html` and crop 256 px cells
(`sips -c 256 256 --cropOffset <row*256> <col*256>`). No rsvg/cairosvg/sharp on the build Mac; Chrome is the renderer.

Not wired yet: CarPlay button/grid icons are baked base64 PNGs in `src/carplay/carButtonIcons.ts` (`carIcon(name, skin)`),
so these ship as four twins per glyph the same way the phone tab bar does. Android Auto tints grid icons white by platform
rule; the silhouettes are drawn so that still reads. Picked after the three-direction sheet (memory
`carplay-glyph-directions-2026-09-24`).
