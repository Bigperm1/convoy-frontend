import bpy, sys, os, math, mathutils
BASE = os.path.dirname(os.path.abspath(__file__)) if '__file__' in dir() else os.getcwd()
SRC = sys.argv[sys.argv.index("--")+1]; PREFIX = sys.argv[sys.argv.index("--")+2]
bpy.ops.wm.read_factory_settings(use_empty=True)
bpy.ops.import_scene.gltf(filepath=SRC)
world = bpy.data.worlds.new("Flat"); bpy.context.scene.world = world
world.use_nodes = True
bg = world.node_tree.nodes["Background"]
bg.inputs["Color"].default_value = (0.85, 0.85, 0.88, 1.0)   # flat neutral ambient ~ Mapbox constant
bg.inputs["Strength"].default_value = 0.9
# one directional sun ~ the style's directional light
sun_data = bpy.data.lights.new("Sun", 'SUN'); sun_data.energy = 2.2
sun = bpy.data.objects.new("Sun", sun_data); bpy.context.scene.collection.objects.link(sun)
sun.rotation_euler = (math.radians(45), 0, math.radians(30))
scene = bpy.context.scene
scene.render.engine = 'CYCLES'; scene.cycles.device='CPU'; scene.cycles.samples=64; scene.cycles.use_denoising=True
scene.render.film_transparent = True
scene.render.resolution_x = 640; scene.render.resolution_y = 460
meshes=[o for o in bpy.data.objects if o.type=='MESH']
mn=mathutils.Vector((1e9,)*3); mx=mathutils.Vector((-1e9,)*3)
for o in meshes:
    for cb in o.bound_box:
        w=o.matrix_world @ mathutils.Vector(cb)
        mn=mathutils.Vector(map(min,mn,w)); mx=mathutils.Vector(map(max,mx,w))
bb_center=(mn+mx)/2; bb_size=(mx-mn); frame=max(bb_size)*1.55
mesh_obj = meshes[0]
cam_data = bpy.data.cameras.new("Cam"); cam = bpy.data.objects.new("Cam", cam_data)
scene.collection.objects.link(cam); scene.camera = cam
center = bb_center
for az, el, dist, name in [(35, 26, frame, "front34"), (215, 26, frame, "other34"), (0, 60, frame*1.05, "chase")]:
    a=math.radians(az); e=math.radians(el)
    cam.location=(center.x+dist*math.cos(e)*math.sin(a), center.y-dist*math.cos(e)*math.cos(a), center.z+dist*math.sin(e))
    d=mathutils.Vector(center)+mathutils.Vector((0,0,bb_size.z*0.12))-cam.location
    cam.rotation_euler = d.to_track_quat('-Z','Y').to_euler()
    scene.render.filepath = os.path.join(BASE, f"{PREFIX}_{name}.png")
    bpy.ops.render.render(write_still=True)
print("FLAT_DONE")
