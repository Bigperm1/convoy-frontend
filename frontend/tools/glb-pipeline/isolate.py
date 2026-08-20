import bpy, os, sys
BASE=os.getcwd()
SRC=sys.argv[sys.argv.index("--")+1]; ROOT=sys.argv[sys.argv.index("--")+2]; OUT=sys.argv[sys.argv.index("--")+3]
bpy.ops.wm.read_factory_settings(use_empty=True)
bpy.ops.import_scene.gltf(filepath=os.path.join(BASE,SRC))
def desc(o):
    out,st=[],list(o.children)
    while st:
        c=st.pop(); out.append(c); st.extend(c.children)
    return out
r=bpy.data.objects[ROOT]; keep=set([r]+desc(r))
for o in list(bpy.data.objects):
    if o not in keep: bpy.data.objects.remove(o, do_unlink=True)
bpy.ops.object.select_all(action='SELECT')
bpy.ops.export_scene.gltf(filepath=os.path.join(BASE,OUT), export_format='GLB', export_apply=False)
print("ISOLATE_DONE")
