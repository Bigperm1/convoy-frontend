"""Garage hero renderer — full-detail iso model, studio light, transparent PNG.

Used when no official per-colour render exists (Toyota scene7 covered the Yaris;
Porsche/Honda/BMW/Lexus don't expose one). Renders the PRE-decimate isolated car
so the hero keeps every vent and badge, recoloured with the same body material(s)
paintscan identified, with the same glass/lamp tuning as normalize_car so windows
aren't chalk. Output: 1580x960 transparent PNG, front-3/4 matching the GR Corolla
hero angle (nose left). Composite onto the dark studio gradient happens in
Pillow afterwards (studio_bg), same as the Yaris set.

usage: blender --background --python hero.py -- <iso.glb> "<BodyMat|BodyMat2>" <hex> <out.png>
"""
import bpy, os, sys, math, mathutils

argv = sys.argv[sys.argv.index("--")+1:]
SRC, BODY_MAT, BODY_HEX, OUT = argv[0], argv[1], argv[2], argv[3]

bpy.ops.wm.read_factory_settings(use_empty=True)
bpy.ops.import_scene.gltf(filepath=os.path.abspath(SRC))

h = BODY_HEX.lstrip('#')
body_rgb = tuple(int(h[i:i+2], 16)/255 for i in (0, 2, 4))
body_lin = tuple(v/12.92 if v <= 0.04045 else ((v+0.055)/1.055)**2.4 for v in body_rgb)

def tune(mat, base=None, metallic=None, rough=None, emissive=None, strength=None):
    if not mat.use_nodes: return
    b = next((n for n in mat.node_tree.nodes if n.type == 'BSDF_PRINCIPLED'), None)
    if not b: return
    if base is not None:
        if os.environ.get('KEEP_TEX') == '1':
            # Tint mode (generated single-material cars). In Blender a texture
            # LINK overrides the socket value, so setting default_value does
            # nothing — the first tint pass rendered ten identical chrome cars.
            # Do it properly: multiply the texture through a Mix node (that IS
            # the glTF factor semantics Mapbox applies on the map), and CUT the
            # metallic/roughness links (their texture read near-metal and
            # chromed the whole car under studio light).
            links_in = list(b.inputs['Base Color'].links)
            if links_in:
                src_sock = links_in[0].from_socket
                mat.node_tree.links.remove(links_in[0])
                mix = mat.node_tree.nodes.new('ShaderNodeMixRGB')
                mix.blend_type = 'MULTIPLY'
                mix.inputs['Fac'].default_value = 1.0
                mix.inputs['Color2'].default_value = (*base, 1)
                mat.node_tree.links.new(src_sock, mix.inputs['Color1'])
                mat.node_tree.links.new(mix.outputs['Color'], b.inputs['Base Color'])
            else:
                b.inputs['Base Color'].default_value = (*base, 1)
            for inp in ('Metallic', 'Roughness'):
                for lk in list(b.inputs[inp].links):
                    mat.node_tree.links.remove(lk)
            b.inputs['Metallic'].default_value = metallic if metallic is not None else 0.25
            b.inputs['Roughness'].default_value = rough if rough is not None else 0.35
            return
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

# .strip(): the S2000 pack ships 'CarPaint ' with a TRAILING SPACE — an
# exact match silently skips the whole body.
BODY_MATS = set(x.strip() for x in BODY_MAT.split('|'))
for m in bpy.data.materials:
    n = m.name
    if n.strip() in BODY_MATS:
        METALLIC = float(os.environ.get('HERO_METALLIC', '0.15'))
        tune(m, base=body_lin, metallic=METALLIC, rough=0.3)
    elif 'red' in n.lower() and ('light' in n.lower() or 'glass' in n.lower()):
        tune(m, emissive=(1.0, 0.06, 0.06), strength=1.2, rough=0.3)
    elif ('glass' in n.lower() or n.lower().startswith('vidrio')) and 'head' not in n.lower():
        tune(m, base=(0.012, 0.014, 0.02), metallic=0.0, rough=0.05)
    elif n.lower().startswith(('light', 'headlight')):
        tune(m, emissive=(1.0, 0.97, 0.9), strength=0.6)

# studio world: soft grey dome so the paint has something to reflect
world = bpy.data.worlds.new("Studio"); bpy.context.scene.world = world
world.use_nodes = True
bg = world.node_tree.nodes["Background"]
bg.inputs["Color"].default_value = (0.28, 0.29, 0.31, 1.0)
bg.inputs["Strength"].default_value = 0.4

def lamp(kind, energy, size, loc, rot):
    ld = bpy.data.lights.new(kind, 'AREA'); ld.energy = energy; ld.size = size
    lo = bpy.data.objects.new(kind, ld); bpy.context.scene.collection.objects.link(lo)
    lo.location = loc; lo.rotation_euler = rot
    return lo

scene = bpy.context.scene
scene.render.engine = 'CYCLES'; scene.cycles.device = 'CPU'
scene.cycles.samples = 160; scene.cycles.use_denoising = True
# Standard, not AgX: AgX pastelizes saturated paint in highlights (Guards Red
# rendered salmon). Same lesson as paintscan's ID decode.
scene.view_settings.view_transform = 'Standard'
scene.view_settings.look = 'None'
scene.render.film_transparent = True
scene.render.resolution_x = 1580; scene.render.resolution_y = 960

meshes = [o for o in bpy.data.objects if o.type == 'MESH']
mn = mathutils.Vector((1e9,)*3); mx = mathutils.Vector((-1e9,)*3)
for o in meshes:
    for cb in o.bound_box:
        w = o.matrix_world @ mathutils.Vector(cb)
        mn = mathutils.Vector(map(min, mn, w)); mx = mathutils.Vector(map(max, mx, w))
center = (mn+mx)/2; size = mx-mn; L = max(size)

# key + fill + rim, scaled to the car
lamp('key',  330*L*L, L*1.4, (center.x - L*0.9, center.y - L*1.1, center.z + L*1.2), (math.radians(50), 0, math.radians(-35)))
lamp('fill', 120*L*L, L*1.8, (center.x + L*1.2, center.y - L*0.7, center.z + L*0.8), (math.radians(60), 0, math.radians(55)))
lamp('rim',  170*L*L, L*1.0, (center.x, center.y + L*1.2, center.z + L*1.4), (math.radians(-45), 0, math.radians(180)))

cam_data = bpy.data.cameras.new("Cam"); cam_data.lens = 62
cam = bpy.data.objects.new("Cam", cam_data)
scene.collection.objects.link(cam); scene.camera = cam
az, el = math.radians(float(os.environ.get('HERO_AZ','33'))), math.radians(11)    # front-3/4, nose left like the GRC set; HERO_AZ flips for post-bake models (orient differs from iso)
dist = L*2.05
cam.location = (center.x + dist*math.cos(el)*math.sin(az),
                center.y - dist*math.cos(el)*math.cos(az),
                center.z + dist*math.sin(el) + size.z*0.10)
d = cam.location - mathutils.Vector((center.x, center.y, center.z + size.z*0.05))
cam.rotation_euler = d.to_track_quat('Z', 'Y').to_euler()

scene.render.image_settings.file_format = 'PNG'
scene.render.filepath = os.path.abspath(OUT)
bpy.ops.render.render(write_still=True)
print("HERO_DONE", OUT)
