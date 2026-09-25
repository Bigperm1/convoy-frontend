# Report-grid glyphs (CarPlay / Android Auto) — direction B "Apple symbol", picked by Jeff 2026-09-24

Six tiles × four metals, 224 px on a 256 px transparent canvas (cut-outs are true holes):
`police` (shield with a P) · `crash` · `hazard` · `traffic` · `camera` (speed cam) · `compass`, each as
`_green` (yours) · `_silver` (Premium) · `_gold` (Ultra Premium) · `_diamond` (unlocked by the first 3D scan).
Flat accent per metal from `src/tierTheme.ts` (`TIER_SKIN.*.accent`; brand `#2DEC86`; diamond `#A9E7FF`).

Masters live in `gen_b.py` (64-unit SVG box; cut-outs are SVG mask holes). Re-bake: render EACH glyph on its own 256 px
transparent canvas with headless Chrome (`--default-background-color=00000000 --window-size=256,256`). ⛔ Do NOT bake a
sheet and crop it with `sips --cropOffset` — that produced the mis-cropped Police tile and garbage head-unit icons shipped in
OTA-BX/BY (fixed in `976e8734`). No rsvg/cairosvg/sharp on the build Mac; Chrome is the renderer.

Wired since OTA-BX (2026-09-24): the phone reads these PNGs (`src/components/HazardSheet.tsx` `HAZARD_ART`); the head units
carry them as base64 in `src/carplay/carButtonIcons.ts` (`CAR_ICON_HZ_*`, `sips -Z 132` → base64, pasted by hand — no script
writes them). The Hazards map button uses the candy triangle instead (`tools/poi-pins/bake_hazard_candy.py`). Spec: `HAZARDS.md`. Android Auto tints grid icons white by platform
rule; the silhouettes are drawn so that still reads. Picked after the three-direction sheet (memory
`carplay-glyph-directions-2026-09-24`).
