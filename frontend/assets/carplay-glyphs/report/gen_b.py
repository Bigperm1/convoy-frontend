# Direction B (Apple symbol) — the six Report tiles Jeff picked, police shield with a P inside.
# Writes: sheet-b.html (24-cell bake sheet on transparent, 256 px cells) + mock-b.html (Report grid ×4 metals)
import html, pathlib, sys
OUT = pathlib.Path(sys.argv[1])
METALS = {
  "green":   dict(flat="#2DEC86", name="Green · yours"),
  "silver":  dict(flat="#C9D2D8", name="Silver · Premium"),
  "gold":    dict(flat="#E0A93E", name="Gold · Ultra Premium"),
  "diamond": dict(flat="#A9E7FF", name="Diamond · 1st 3D scan"),
}
BG = "#141416"
ORDER = ["police","crash","hazard","traffic","camera","compass"]
LABEL = dict(police="Police", crash="Crash", hazard="Hazard", traffic="Traffic", camera="Speed cam", compass="Compass")

def glyph(name, col, cut):
    """Silhouette in `col` with the punched details as REAL holes (SVG mask) — cut is ignored, kept for callers."""
    M = 'fill="none" stroke="#000" stroke-linecap="round" stroke-linejoin="round"'   # black in a mask = removed
    K = f'fill="none" stroke="{col}" stroke-linecap="round" stroke-linejoin="round"'
    mid = f"m-{name}"
    def masked(silhouette, holes):
        return (f'<defs><mask id="{mid}" maskUnits="userSpaceOnUse" x="0" y="0" width="64" height="64">'
                f'<rect x="0" y="0" width="64" height="64" fill="#fff"/>{holes}</mask></defs>'
                f'<g mask="url(#{mid})">{silhouette}</g>')
    if name == "police":
        return masked(f'<path d="M32 7 L52 14 V30 C52 43.5 43 52 32 57 C21 52 12 43.5 12 30 V14 Z" fill="{col}"/>',
                      f'<path d="M26.5 43 V21 H34.5 C39.5 21 42.5 24 42.5 28.5 C42.5 33 39.5 36 34.5 36 H26.5" {M} stroke-width="4.6"/>')
    if name == "crash":
        return (masked(f'<path d="M13 43 L17.5 30 C18.3 27.6 20 26 22.5 26 H41.5 C44 26 45.7 27.6 46.5 30 L51 43 V51 H44 V47 H20 V51 H13 Z" fill="{col}"/>',
                       '<circle cx="21.5" cy="42" r="2.4" fill="#000"/><circle cx="42.5" cy="42" r="2.4" fill="#000"/>')
                + f'<path d="M48 20 L52 10 M51 23 L60 17 M52 27 L62 28" {K} stroke-width="4.6"/>')
    if name == "hazard":
        return masked(f'<path d="M32 9 L57 51 H7 Z" fill="{col}" stroke="{col}" stroke-width="3" stroke-linejoin="round"/>',
                      f'<path d="M32 23 V37" {M} stroke-width="4.6"/><circle cx="32" cy="45" r="2.6" fill="#000"/>')
    if name == "traffic":
        return masked(f'<path d="M14 24 L18.5 13 C19.2 11.2 20.6 10 22.5 10 H41.5 C43.4 10 44.8 11.2 45.5 13 L50 24 V30 H44 V27 H20 V30 H14 Z M14 52 L18.5 41 C19.2 39.2 20.6 38 22.5 38 H41.5 C43.4 38 44.8 39.2 45.5 41 L50 52 V58 H44 V55 H20 V58 H14 Z" fill="{col}"/>',
                      f'<path d="M22 20 H42 M22 48 H42" {M} stroke-width="4"/>')
    if name == "camera":
        return (masked(f'<path d="M14 24 H22 L25 19 H39 L42 24 H50 C52.2 24 54 25.8 54 28 V46 C54 48.2 52.2 50 50 50 H14 C11.8 50 10 48.2 10 46 V28 C10 25.8 11.8 24 14 24 Z" fill="{col}"/>',
                       f'<circle cx="32" cy="37" r="7.5" {M} stroke-width="4"/>')
                + f'<path d="M53 16 L58 9 M56 22 L63 20 M49 13 L49 6" {K} stroke-width="4.2"/>')
    if name == "compass":
        return (f'<circle cx="32" cy="32" r="21" {K} stroke-width="5"/>'
                f'<path d="M32 11 L38.5 32 H25.5 Z" fill="{col}"/><path d="M32 53 L25.5 32 H38.5 Z" fill="{col}" opacity="0.35"/>')

def _old_glyph(name, col, cut):
    S=f'fill="none" stroke="{cut}" stroke-linecap="round" stroke-linejoin="round"'
    K=f'fill="none" stroke="{col}" stroke-linecap="round" stroke-linejoin="round"'
    if name=="police":
        # shield + a P punched through: stem + bowl, SF-weight
        return (f'<path d="M32 7 L52 14 V30 C52 43.5 43 52 32 57 C21 52 12 43.5 12 30 V14 Z" fill="{col}"/>'
                f'<path d="M26.5 43 V21 H34.5 C39.5 21 42.5 24 42.5 28.5 C42.5 33 39.5 36 34.5 36 H26.5" {S} stroke-width="4.6"/>')
    if name=="crash":
        return (f'<path d="M13 43 L17.5 30 C18.3 27.6 20 26 22.5 26 H41.5 C44 26 45.7 27.6 46.5 30 L51 43 V51 H44 V47 H20 V51 H13 Z" fill="{col}"/>'
                f'<circle cx="21.5" cy="42" r="2.4" fill="{cut}"/><circle cx="42.5" cy="42" r="2.4" fill="{cut}"/>'
                f'<path d="M48 20 L52 10 M51 23 L60 17 M52 27 L62 28" {K} stroke-width="4.6"/>')
    if name=="hazard":
        return (f'<path d="M32 9 L57 51 H7 Z" fill="{col}" stroke="{col}" stroke-width="3" stroke-linejoin="round"/>'
                f'<path d="M32 23 V37" {S} stroke-width="4.6"/><circle cx="32" cy="45" r="2.6" fill="{cut}"/>')
    if name=="traffic":
        return (f'<path d="M14 24 L18.5 13 C19.2 11.2 20.6 10 22.5 10 H41.5 C43.4 10 44.8 11.2 45.5 13 L50 24 V30 H44 V27 H20 V30 H14 Z '
                f'M14 52 L18.5 41 C19.2 39.2 20.6 38 22.5 38 H41.5 C43.4 38 44.8 39.2 45.5 41 L50 52 V58 H44 V55 H20 V58 H14 Z" fill="{col}"/>'
                f'<path d="M22 20 H42 M22 48 H42" {S} stroke-width="4"/>')
    if name=="camera":
        return (f'<path d="M14 24 H22 L25 19 H39 L42 24 H50 C52.2 24 54 25.8 54 28 V46 C54 48.2 52.2 50 50 50 H14 C11.8 50 10 48.2 10 46 V28 C10 25.8 11.8 24 14 24 Z" fill="{col}"/>'
                f'<circle cx="32" cy="37" r="7.5" {S} stroke-width="4"/>'
                f'<path d="M53 16 L58 9 M56 22 L63 20 M49 13 L49 6" {K} stroke-width="4.2"/>')
    if name=="compass":
        return (f'<circle cx="32" cy="32" r="21" {K} stroke-width="5"/>'
                f'<path d="M32 11 L38.5 32 H25.5 Z" fill="{col}"/><path d="M32 53 L25.5 32 H38.5 Z" fill="{col}" opacity="0.35"/>')

def svg(name, metal, size, cut=BG):
    return f'<svg viewBox="0 0 64 64" width="{size}" height="{size}">{glyph(name, METALS[metal]["flat"], cut)}</svg>'

# bake sheet: transparent page, cells 256 px at (col*256, row*256), glyph drawn 224 px centred → cut colour = transparent
bake = ['<!doctype html><html><head><meta charset="utf-8"><style>body{margin:0;background:transparent;width:1536px;height:1024px}.c{position:absolute;width:256px;height:256px;display:flex;align-items:center;justify-content:center}</style></head><body>']
for r,m in enumerate(METALS):
    for c,n in enumerate(ORDER):
        bake.append(f'<div class="c" style="left:{c*256}px;top:{r*256}px">{svg(n,m,224,cut="rgba(0,0,0,0)")}</div>')
bake.append('</body></html>')
(OUT/"sheet-b.html").write_text("".join(bake))

# mock: the Report grid × 4 metals, 2000 wide
def panel(m):
    tiles="".join(f'<div class="tile">{svg(n,m,96)}<div class="tlab">{LABEL[n]}</div></div>' for n in ORDER)
    return f'<div class="cp"><div class="cphead"><span class="back" style="color:{METALS[m]["flat"]}">‹ Back</span><span class="cptitle">Report</span><span></span></div><div class="cpgrid">{tiles}</div><div class="cpcap">{html.escape(METALS[m]["name"])}</div></div>'
mock=f'''<!doctype html><html><head><meta charset="utf-8"><style>
body{{margin:0;background:#0b0b0d;color:#f2f2f4;font-family:-apple-system,"SF Pro Text","Helvetica Neue",Helvetica,Arial,sans-serif;width:2000px}}
.wrap{{padding:40px 48px}} h1{{font-size:34px;margin:0 0 6px}} .sub{{color:#8E8E93;font-size:18px;margin:0 0 26px}}
.grid{{display:grid;grid-template-columns:1fr 1fr;gap:34px}}
.cp{{background:#000;border-radius:22px;overflow:hidden;border:1px solid rgba(255,255,255,.08)}}
.cphead{{display:flex;justify-content:space-between;align-items:center;padding:16px 26px;background:#1a1a1c;font-size:26px}} .cptitle{{font-weight:700}} .back{{font-size:24px}}
.cpgrid{{display:grid;grid-template-columns:repeat(6,1fr);padding:34px 22px 24px;gap:8px}}
.tile{{display:flex;flex-direction:column;align-items:center;gap:14px}} .tlab{{font-size:21px}}
.cpcap{{color:#8E8E93;font-size:16px;padding:0 26px 18px}}
.row{{display:flex;gap:22px;margin-top:34px;align-items:flex-end}} .face{{width:88px;height:88px;border-radius:50%;background:radial-gradient(circle at 50% 30%,#232327,#151517 70%);border:1px solid rgba(255,255,255,.09);display:flex;align-items:center;justify-content:center;box-shadow:0 6px 18px rgba(0,0,0,.55)}}
.lab{{color:#8E8E93;font-size:14px;text-align:center;margin-top:8px}} .foot{{color:#6e6e73;font-size:15px;margin-top:26px}}
</style></head><body><div class="wrap"><h1>Report tiles — Apple symbol, P in the shield</h1><p class="sub">The six you picked, in each metal. Top row = the map button they replace (44 pt), drawn on the CarPlay button chrome.</p>
<div class="row">{"".join(f'<div><div class="face">{svg(n,"green",54)}</div><div class="lab">{LABEL[n]}</div></div>' for n in ORDER)}
<div style="width:30px"></div>{"".join(f'<div><div class="face">{svg(n,"gold",54)}</div><div class="lab">{LABEL[n]}</div></div>' for n in ORDER)}</div>
<div class="grid" style="margin-top:34px">{panel("green")}{panel("silver")}{panel("gold")}{panel("diamond")}</div>
<p class="foot">MOCKUP. Masters are SVG on a 64-unit box; baked PNGs are 224 px on transparent (cut-outs are true holes, so they sit on any button chrome).</p></div></body></html>'''
(OUT/"mock-b.html").write_text(mock); print("wrote sheet-b.html + mock-b.html")
