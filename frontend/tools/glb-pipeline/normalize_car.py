"""Generic car-asset normaliser for the Hairpin map marker pipeline.

Usage:
  blender --background --python normalize_car.py -- <src.glb> <ROOT_NAME> <BODY_MAT> <hex> <out.glb>

Env:
  LIT=1     bake the lights-on variant (dawn/dusk/night preset)
  MATTE=1   matte paint (lower metallic / higher roughness)
  DIAG=1    print diagnostics and skip the export

Built from the GR Corolla pipeline, generalised after the 8/19 findings on Jeff's
Drive pack:
  * the .glb files are multi-car SCENES — one car per root hierarchy, so the car
    of interest has to be isolated by root name before anything else;
  * the roots are ARMATURES and the wheels are placed by the deform, so the rig
    must be BAKED into geometry (convert), never stripped;
  * the pack lost its MIRROR modifiers on export, so body panels arrive as half
    a car — measured on the GT86 ('Car.Body' 0.92 m wide starting exactly at
    x=0) and again on the 2022 Supra. Half-panels are re-mirrored about the
    world centreline here.
"""
import bpy, sys, os, math, mathutils

BASE = os.getcwd()
a = sys.argv[sys.argv.index("--")+1:]
SRC, ROOT_NAME, BODY_MAT, BODY_HEX, OUT = a[0], a[1], a[2], a[3], a[4]
LIT   = os.environ.get('LIT') == '1'
MATTE = os.environ.get('MATTE') == '1'
DIAG  = os.environ.get('DIAG') == '1'
TARGET_LEN = float(os.environ.get('TARGET_LEN', '1.9101'))   # marker world length
TRI_BUDGET = int(os.environ.get('TRI_BUDGET', '6000'))       # per-object cap before decimation
IMG_MAX = int(os.environ.get('IMG_MAX', '0'))                 # >0: downscale embedded textures to this max edge (map cars don't need 1024+ logos)

bpy.ops.wm.read_factory_settings(use_empty=True)
bpy.ops.import_scene.gltf(filepath=os.path.join(BASE, SRC))

def wbb(objs):
    mn = mathutils.Vector((1e9,)*3); mx = mathutils.Vector((-1e9,)*3)
    for o in objs:
        if o.type != 'MESH':
            continue
        for cb in o.bound_box:
            w = o.matrix_world @ mathutils.Vector(cb)
            mn = mathutils.Vector(map(min, mn, w)); mx = mathutils.Vector(map(max, mx, w))
    return mn, mx

# ── 1. ISOLATE ONE CAR ───────────────────────────────────────────────────────
def desc(o):
    out, st = [], list(o.children)
    while st:
        c = st.pop(); out.append(c); st.extend(c.children)
    return out
root = bpy.data.objects.get(ROOT_NAME)
assert root is not None, f"root {ROOT_NAME!r} not found"
keep = set([root] + desc(root))
for o in list(bpy.data.objects):
    if o not in keep:
        bpy.data.objects.remove(o, do_unlink=True)

# ── 2. BAKE THE RIG INTO GEOMETRY ────────────────────────────────────────────
bpy.ops.object.select_all(action='DESELECT')
for o in [x for x in bpy.data.objects if x.type == 'MESH']:
    bpy.context.view_layer.objects.active = o
    o.select_set(True)
bpy.ops.object.convert(target='MESH')
bpy.ops.object.select_all(action='DESELECT')
for o in [x for x in bpy.data.objects if x.type == 'MESH']:
    o.select_set(True); bpy.context.view_layer.objects.active = o
bpy.ops.object.parent_clear(type='CLEAR_KEEP_TRANSFORM')
for o in list(bpy.data.objects):
    if o.type != 'MESH':
        bpy.data.objects.remove(o, do_unlink=True)
bpy.context.view_layer.update()

# ── 3. REBUILD MISSING HALVES ────────────────────────────────────────────────
# A panel whose world bbox sits wholly on one side of the centreline AND touches
# it is half a part. Mirror about an EMPTY at the world origin (not the object's
# own origin, which is arbitrary in this pack).
pivot = bpy.data.objects.new("MirrorPivot", None)
bpy.context.scene.collection.objects.link(pivot)
pivot.location = (0, 0, 0)
EPS = 0.02
halves = []
for o in [x for x in bpy.data.objects if x.type == 'MESH']:
    mn, mx = wbb([o])
    width = mx.x - mn.x
    if width < 1e-4:
        continue
    # A half-panel has one EDGE ON the mirror plane. Merely sitting on one side
    # is NOT enough — that describes every left-hand door trim and seat, which
    # already have their own right-hand twin; mirroring those duplicates parts
    # into each other (caught on the Supra: 23 "halves" included Body.001 at
    # x=[0.67,0.86] and a door trim at x=[-0.74,-0.65]).
    plus  = abs(mn.x) <= EPS and mx.x >  EPS
    minus = abs(mx.x) <= EPS and mn.x < -EPS
    if plus or minus:
        if o.data.users > 1:
            o.data = o.data.copy()   # modifier_apply refuses multi-user data (S2000 shares wheel meshes)
        m = o.modifiers.new('mir', 'MIRROR')
        m.use_axis = (True, False, False)
        m.mirror_object = pivot
        m.use_clip = True
        # APPLY IT NOW, then recalculate normals outward. Left as a live modifier
        # the mirrored half exported with inverted winding and rendered pure
        # BLACK (its normals faced into the car, so every light missed it).
        # Applying here also means the decimator downstream sees the whole panel.
        bpy.ops.object.select_all(action='DESELECT')
        bpy.context.view_layer.objects.active = o
        o.select_set(True)
        bpy.ops.object.modifier_apply(modifier=m.name)
        try:
            bpy.ops.object.mode_set(mode='EDIT')
            bpy.ops.mesh.select_all(action='SELECT')
            bpy.ops.mesh.normals_make_consistent(inside=False)
            bpy.ops.object.mode_set(mode='OBJECT')
        except Exception:
            if bpy.context.object and bpy.context.object.mode != 'OBJECT':
                bpy.ops.object.mode_set(mode='OBJECT')
        halves.append((o.name, round(mn.x, 3), round(mx.x, 3)))


# ── 3b. ORPHAN-MIRROR (env MIRROR_ORPHANS=1) ─────────────────────────────────
# The LFA ships its ENTIRE left side missing — 26 right-only panels, none with
# an edge on the centreline, so the half-panel rule above can't see them. In
# this mode, any mesh sitting wholly on +X is mirrored UNLESS a left-side twin
# already exists (bbox centre ≈ mirrored, similar size) — the twin check is what
# keeps wheels/mirrors from being duplicated onto their real counterparts.
if os.environ.get('MIRROR_ORPHANS') == '1':
    meshes_all = [x for x in bpy.data.objects if x.type == 'MESH']
    boxes = {}
    for o in meshes_all:
        mn2, mx2 = wbb([o])
        boxes[o.name] = (mn2, mx2)
    lefts = [(n, b) for n, b in boxes.items() if b[1].x < EPS]
    for o in list(meshes_all):
        mn2, mx2 = boxes[o.name]
        if mn2.x < -EPS or (mx2.x - mn2.x) < 1e-4:
            continue  # not wholly right-side
        c2 = (mn2 + mx2) / 2
        s2 = mx2 - mn2
        twin = False
        for n, (lmn, lmx) in lefts:
            lc = (lmn + lmx) / 2
            lsz = lmx - lmn
            if abs(lc.x + c2.x) < 0.1 and abs(lc.y - c2.y) < 0.15 and abs(lc.z - c2.z) < 0.15 \
               and abs(lsz.x - s2.x) < 0.2 and abs(lsz.y - s2.y) < 0.2:
                twin = True; break
        if twin:
            continue
        if o.data.users > 1:
            o.data = o.data.copy()   # modifier_apply refuses multi-user data (S2000 shares wheel meshes)
        m = o.modifiers.new('mir', 'MIRROR')
        m.use_axis = (True, False, False)
        m.mirror_object = pivot
        m.use_clip = True
        bpy.ops.object.select_all(action='DESELECT')
        bpy.context.view_layer.objects.active = o
        o.select_set(True)
        bpy.ops.object.modifier_apply(modifier=m.name)
        try:
            bpy.ops.object.mode_set(mode='EDIT')
            bpy.ops.mesh.select_all(action='SELECT')
            bpy.ops.mesh.normals_make_consistent(inside=False)
            bpy.ops.object.mode_set(mode='OBJECT')
        except Exception:
            if bpy.context.object and bpy.context.object.mode != 'OBJECT':
                bpy.ops.object.mode_set(mode='OBJECT')
        halves.append((o.name + '(orphan)', round(mn2.x, 3), round(mx2.x, 3)))

# ── 4. DROP DETAIL A 44-132px MARKER CANNOT SHOW ─────────────────────────────
DROP_PREFIX = ('BrakeDisk', 'Brake Disk', 'Toyota Logo', 'Brembo', 'WheelBolts',
               'Bolts.', 'Wheelbrake', 'WheelBrake', 'Caliper')
dropped = []
for o in list(bpy.data.objects):
    if o.type == 'MESH' and o.name.startswith(DROP_PREFIX):
        dropped.append(o.name)
        bpy.data.objects.remove(o, do_unlink=True)

# ── 5. DECIMATE ──────────────────────────────────────────────────────────────
for o in [x for x in bpy.data.objects if x.type == 'MESH']:
    o.data.calc_loop_triangles()
    n = len(o.data.loop_triangles)
    if n > TRI_BUDGET:
        m = o.modifiers.new('dec', 'DECIMATE')
        m.ratio = max(0.05, min(1.0, float(TRI_BUDGET) / n))
        m.use_collapse_triangulate = True

# ── 6. ORIENT + SCALE + GROUND ───────────────────────────────────────────────
# Source length lies on Y; the marker asset wants it on X, nose in the same
# direction the GR Corolla asset uses (-90°, verified for that car by rendering
# old vs new through one camera; re-verify per car with a preview render).
holder = bpy.data.objects.new("CarRoot", None)
bpy.context.scene.collection.objects.link(holder)
# The mirror PIVOT must ride along with the car. A MIRROR modifier mirrors in its
# mirror_object's local space, so leaving the pivot behind while the body rotates
# -90° turned the mirror plane 90° off — it duplicated the car nose-to-nose along
# its length instead of left-to-right, and the sprite still showed a lengthwise
# cut edge with the far wheels stranded outside it.
for o in [x for x in bpy.data.objects if x is not holder and x.parent is None]:
    o.parent = holder
holder.rotation_euler = (0, 0, math.radians(-90))
bpy.context.view_layer.update()
mn, mx = wbb([x for x in bpy.data.objects if x.type == 'MESH'])
src_len = max(mx.x - mn.x, mx.y - mn.y)
holder.scale = (TARGET_LEN / src_len,) * 3
bpy.context.view_layer.update()
mn, mx = wbb([x for x in bpy.data.objects if x.type == 'MESH'])
c = (mn + mx) / 2
holder.location = (holder.location.x - c.x, holder.location.y - c.y, holder.location.z - mn.z)
bpy.context.view_layer.update()

# ── 7. MATERIALS for Mapbox's no-IBL renderer ────────────────────────────────
def tune(mat, base=None, metallic=None, rough=None, emissive=None, strength=None):
    if not mat.use_nodes: return
    b = next((n for n in mat.node_tree.nodes if n.type == 'BSDF_PRINCIPLED'), None)
    if not b: return
    if base is not None:
        # A baseColorTexture MULTIPLIES the factor — the LFA ships a carbon-weave
        # texture on its body, and painting the factor alone rendered charcoal.
        # ...and its normal/roughness/metallic maps (carbon weave embossed the
        # paint even after the base texture was cut).
        for inp in ('Base Color', 'Normal', 'Roughness', 'Metallic'):
            for lk in list(b.inputs[inp].links):
                mat.node_tree.links.remove(lk)
        b.inputs['Base Color'].default_value = (*base, 1)
    if metallic is not None: b.inputs['Metallic'].default_value = metallic
    if rough is not None:    b.inputs['Roughness'].default_value = rough
    if emissive is not None:
        b.inputs['Emission Color'].default_value = (*emissive, 1)
        b.inputs['Emission Strength'].default_value = strength or 1.0

h = BODY_HEX.lstrip('#')
body_rgb = tuple(int(h[i:i+2], 16) / 255 for i in (0, 2, 4))
body_lin = tuple(v/12.92 if v <= 0.04045 else ((v + 0.055)/1.055) ** 2.4 for v in body_rgb)

# BODY_MAT may be a PIPE-SEPARATED SET. This pack scatters the exterior shell
# across arbitrarily-named materials (measured on the 2022 Supra: 'Pure black'
# 36% of exterior pixels, 'Rough-rubber.001' 31%, 'Gears' 11% — the flanks and
# the bonnet), so the paint target is whatever paintscan.py measured, not a name
# anyone could have guessed.
# .strip(): the S2000 pack ships 'CarPaint ' with a TRAILING SPACE — an
# exact match silently skips the whole body.
BODY_MATS = set(x.strip() for x in BODY_MAT.split('|'))
painted = False
for m in bpy.data.materials:
    n = m.name
    if n.strip() in BODY_MATS:
        tune(m, base=body_lin, metallic=0.1 if MATTE else 0.25, rough=0.55 if MATTE else 0.35)
        painted = True
    elif 'red' in n.lower() and ('light' in n.lower() or 'glass' in n.lower()):
        # Taillight covers named like GlassRed / Red_Light (the Yaris asset) — must
        # be caught BEFORE the generic glass rule or they render as clear glass and
        # the tail never glows.
        tune(m, emissive=(1.0, 0.06, 0.06), strength=(5.0 if LIT else 2.0), rough=0.3)
    elif ('glass' in n.lower() or n.lower().startswith('vidrio')) and 'head' not in n.lower():
        # Base forced DARK: this pack authors glass with a WHITE base + transmission,
        # which Mapbox's renderer ignores — the Yaris rendered chalk-white windows
        # until this. Near-black tinted glass matches the GR Corolla's look.
        tune(m, base=(0.012, 0.014, 0.02), metallic=0.0, rough=0.12)
    elif 'red emission' in n.lower() or 'taillight' in n.lower():
        tune(m, emissive=(1.0, 0.06, 0.06), strength=(5.0 if LIT else 2.0), rough=0.3)
    elif 'white emission' in n.lower() or n.lower().startswith(('light', 'headlight')):  # startswith: this pack names its lamps 'Light.001'
        tune(m, emissive=(1.0, 0.97, 0.9), strength=(5.0 if LIT else 1.0))
    elif 'headlightglass' in n.lower().replace(' ', '') or ('glass' in n.lower() and 'head' in n.lower()):
        # 'glass headlights' (S2000 pack) — any glass+head combo, else chalk lenses
        tune(m, emissive=((1.0, 0.95, 0.8) if LIT else None), strength=(2.5 if LIT else None), rough=0.15)
    elif n.lower().startswith(('rubber', 'tire', 'tyre')):
        tune(m, metallic=0.0, rough=0.9)
    elif 'chrome' in n.lower() or n.lower().startswith(('silver', 'mirror')):
        tune(m, metallic=0.8, rough=0.25)
    elif 'plastic' in n.lower():
        tune(m, metallic=0.0, rough=0.7)

# Count the EVALUATED mesh (mirror + decimate applied) — the raw o.data counts
# are pre-modifier and were reporting the untouched 2.37M for a car that exports
# at a fraction of it.
dg = bpy.context.evaluated_depsgraph_get()
final_tris = 0
for o in [x for x in bpy.data.objects if x.type == 'MESH']:
    ev = o.evaluated_get(dg)
    me = ev.to_mesh()
    me.calc_loop_triangles()
    final_tris += len(me.loop_triangles)
    ev.to_mesh_clear()
mn, mx = wbb([x for x in bpy.data.objects if x.type == 'MESH'])

print("HALVES_MIRRORED", len(halves), halves[:12])
print("DROPPED", len(dropped))
print("BODY_MAT_PAINTED", painted)
print("FINAL_TRIS", final_tris)
print("FINAL_BBOX", tuple(round(v, 3) for v in (mx - mn)))

if not DIAG:
    assert painted, f"body material {BODY_MAT!r} never matched — refusing to export an unpainted car"
    bpy.ops.object.select_all(action='SELECT')
    if IMG_MAX > 0:
        for img in bpy.data.images:
            if img.size[0] > IMG_MAX or img.size[1] > IMG_MAX:
                f = IMG_MAX / max(img.size[0], img.size[1])
                img.scale(max(1, int(img.size[0]*f)), max(1, int(img.size[1]*f)))
    bpy.ops.export_scene.gltf(filepath=os.path.join(BASE, OUT), export_format='GLB', export_apply=True)
print("NORMCAR_DONE")
