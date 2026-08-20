"""Classify which materials of a car GLB are BODY PAINT, by measurement.

The Drive asset pack names materials arbitrarily — on the 2022 Supra the left
flank is 'Pure black', the right flank 'Rough-rubber.001' and the bonnet 'Gears'
— so no name-based rule can find the paint. Instead:

  1. render a material-ID pass from 5 exterior cameras (top + 4 obliques),
  2. count how many pixels each material owns (= exterior-visible area),
  3. read each material's own PBR properties,
  4. call it paint when it is broadly visible AND not glass / lamp / tyre /
     chrome / near-black trim.

Prints a PAINT= line listing the chosen materials, for the baker to consume.
"""
import bpy, os, sys, math, mathutils, colorsys, json

BASE = os.getcwd()
SRC = sys.argv[sys.argv.index("--")+1]

bpy.ops.wm.read_factory_settings(use_empty=True)
bpy.ops.import_scene.gltf(filepath=os.path.join(BASE, SRC))

mats = sorted({m.name for m in bpy.data.materials})
N = max(1, len(mats))
props = {}
for i, name in enumerate(mats):
    m = bpy.data.materials[name]
    if not m.use_nodes:
        m.use_nodes = True
    b = next((n for n in m.node_tree.nodes if n.type == 'BSDF_PRINCIPLED'), None)
    if not b:
        props[name] = dict(idx=i, lum=0.5, metallic=0, transmission=0, emission=0, alpha=1)
        continue
    bc = b.inputs['Base Color'].default_value
    lum = 0.2126*bc[0] + 0.7152*bc[1] + 0.0722*bc[2]
    em  = b.inputs['Emission Strength'].default_value
    emc = b.inputs['Emission Color'].default_value
    emv = max(emc[0], emc[1], emc[2]) * em
    tr  = b.inputs['Transmission Weight'].default_value if 'Transmission Weight' in b.inputs else 0.0
    props[name] = dict(idx=i, lum=lum, metallic=b.inputs['Metallic'].default_value,
                       transmission=tr, emission=emv, alpha=b.inputs['Alpha'].default_value)
    # flat unlit ID colour
    r, g, bl = colorsys.hsv_to_rgb((i/N) % 1.0, 0.95, 1.0)
    b.inputs['Base Color'].default_value = (0, 0, 0, 1)
    b.inputs['Metallic'].default_value = 0
    b.inputs['Roughness'].default_value = 1
    b.inputs['Emission Color'].default_value = (r, g, bl, 1)
    b.inputs['Emission Strength'].default_value = 1.0
    b.inputs['Alpha'].default_value = 1
    if 'Transmission Weight' in b.inputs:
        b.inputs['Transmission Weight'].default_value = 0

w = bpy.data.worlds.new("W"); bpy.context.scene.world = w; w.use_nodes = True
w.node_tree.nodes["Background"].inputs["Strength"].default_value = 0.0
sc = bpy.context.scene
sc.render.engine = 'BLENDER_EEVEE'
# EXACT colours out: the default view transform (AgX/Filmic) tone-maps the ID
# colours and shifted their hues enough to mis-decode adjacent material indices —
# that is what made the first classification name the wrong panels.
sc.view_settings.view_transform = 'Standard'
sc.view_settings.look = 'None'
sc.display_settings.display_device = 'sRGB'
sc.render.film_transparent = True
sc.render.resolution_x = 300; sc.render.resolution_y = 300
sc.render.image_settings.file_format = 'PNG'

meshes = [o for o in bpy.data.objects if o.type == 'MESH']
mn = mathutils.Vector((1e9,)*3); mx = mathutils.Vector((-1e9,)*3)
for o in meshes:
    for cb in o.bound_box:
        wv = o.matrix_world @ mathutils.Vector(cb)
        mn = mathutils.Vector(map(min, mn, wv)); mx = mathutils.Vector(map(max, mx, wv))
c = (mn + mx) / 2; size = mx - mn; frame = max(size) * 1.35

cd = bpy.data.cameras.new("C"); cd.type = 'ORTHO'; cd.ortho_scale = max(size) * 1.05
cam = bpy.data.objects.new("C", cd); sc.collection.objects.link(cam); sc.camera = cam

VIEWS = [(0, 89.9, 'top'), (35, 20, 'fl'), (145, 20, 'rl'), (215, 20, 'rr'), (325, 20, 'fr')]
paths = []
for az, el, tag in VIEWS:
    a = math.radians(az); e = math.radians(el)
    cam.location = (c.x + frame*math.cos(e)*math.sin(a),
                    c.y - frame*math.cos(e)*math.cos(a),
                    c.z + frame*math.sin(e))
    d = mathutils.Vector(c) - cam.location
    cam.rotation_euler = d.to_track_quat('-Z', 'Y').to_euler()
    p = os.path.join(BASE, f"_pscan_{tag}.png")
    sc.render.filepath = p
    bpy.ops.render.render(write_still=True)
    paths.append(p)

print("PSCAN_VIEWS " + json.dumps(paths))
print("PSCAN_MATS " + json.dumps({k: v for k, v in props.items()}))
print("PSCAN_N " + str(N))
print("PSCAN_DONE")
