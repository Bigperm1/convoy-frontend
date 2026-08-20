import bpy, sys, os, math, mathutils
BASE=os.getcwd()
SRC=sys.argv[sys.argv.index("--")+1]; OUT=sys.argv[sys.argv.index("--")+2]
bpy.ops.wm.read_factory_settings(use_empty=True)
bpy.ops.import_scene.gltf(filepath=os.path.join(BASE,SRC))
world=bpy.data.worlds.new("W"); bpy.context.scene.world=world; world.use_nodes=True
bgn=world.node_tree.nodes["Background"]; bgn.inputs["Color"].default_value=(0.9,0.9,0.92,1); bgn.inputs["Strength"].default_value=1.0
sd=bpy.data.lights.new("Sun",'SUN'); sd.energy=3.0
sun=bpy.data.objects.new("Sun",sd); bpy.context.scene.collection.objects.link(sun)
sun.rotation_euler=(math.radians(18),0,math.radians(15))
sc=bpy.context.scene; sc.render.engine='CYCLES'; sc.cycles.device='CPU'; sc.cycles.samples=128; sc.cycles.use_denoising=True
sc.render.film_transparent=True
sc.render.resolution_x=396; sc.render.resolution_y=396   # @3x of 132
meshes=[o for o in bpy.data.objects if o.type=='MESH']
mn=mathutils.Vector((1e9,)*3); mx=mathutils.Vector((-1e9,)*3)
for o in meshes:
    for cb in o.bound_box:
        w=o.matrix_world @ mathutils.Vector(cb)
        mn=mathutils.Vector(map(min,mn,w)); mx=mathutils.Vector(map(max,mx,w))
c=(mn+mx)/2; size=mx-mn
cd=bpy.data.cameras.new("Cam"); cd.type='ORTHO'
# car length on X: ink 129/132 of frame -> ortho scale = length * 132/129
cd.ortho_scale = max(size.x, size.y) * (132.0/129.0)
cam=bpy.data.objects.new("Cam",cd); sc.collection.objects.link(cam); sc.camera=cam
cam.location=(c.x, c.y, mx.z+3); cam.rotation_euler=(0,0,math.radians(90))  # top-down, nose up
sc.render.filepath=os.path.join(BASE,OUT)
bpy.ops.render.render(write_still=True)
print("SPRITE_DONE")
