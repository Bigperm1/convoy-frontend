"""Split a single huge mesh into per-axis chunks so every exported primitive
fits 16-bit indices (<=65535 verts). Mapbox silently refuses models with
uint32 indices (found 8/20: Jeff's scanned car invisible on the map while the
authored fleet - many small meshes, uint16 - renders fine).
usage: blender --background --python split_u16.py -- <in.glb> <out.glb> <chunks>
"""
import bpy, sys, os
argv=sys.argv[sys.argv.index("--")+1:]
SRC,OUT,CH=argv[0],argv[1],int(argv[2])
bpy.ops.wm.read_factory_settings(use_empty=True)
bpy.ops.import_scene.gltf(filepath=os.path.abspath(SRC))
obj=[o for o in bpy.data.objects if o.type=='MESH'][0]
bpy.context.view_layer.objects.active=obj
obj.select_set(True)
# sort faces along X and separate into CH chunks by index ranges
import bmesh
for c in range(CH-1):
    ob=[o for o in bpy.data.objects if o.type=='MESH']
    ob.sort(key=lambda o:len(o.data.polygons), reverse=True)
    big=ob[0]
    bpy.ops.object.select_all(action='DESELECT')
    big.select_set(True); bpy.context.view_layer.objects.active=big
    bpy.ops.object.mode_set(mode='EDIT')
    bm=bmesh.from_edit_mesh(big.data)
    faces=sorted(bm.faces, key=lambda f: f.calc_center_median().x)
    half=len(faces)//2
    for f in bm.faces: f.select=False
    for f in faces[:half]: f.select=True
    bmesh.update_edit_mesh(big.data)
    bpy.ops.mesh.separate(type='SELECTED')
    bpy.ops.object.mode_set(mode='OBJECT')
for o in bpy.data.objects:
    if o.type=='MESH': print("CHUNK", o.name, len(o.data.vertices))
bpy.ops.object.select_all(action='SELECT')
bpy.ops.export_scene.gltf(filepath=os.path.abspath(OUT), export_format='GLB', export_apply=True)
print("SPLIT_DONE")
