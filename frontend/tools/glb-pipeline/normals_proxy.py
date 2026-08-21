"""Smooth the SHADING of a noisy scan without moving its surface.

Measured on Jeff's Widebody (8/21): the surface noise is ~0.3% of car length
(6 mm) but the median angle between neighbouring faces is 12.6 deg - the bumps
are mostly noisy normals, not silhouette. Moving vertices (Smooth modifier)
tears thin parts; Laplacian doesn't reduce the angle noise at all. So: build a
heavily smoothed PROXY copy, then transfer its normals onto the ORIGINAL
positions (Data Transfer, custom normals, nearest-face interpolated). Optional
gentle position smoothing first (POS_ITERS) for the worst ripples.

usage: blender -b --python normals_proxy.py -- in.glb out_prefix
env:   VARIANTS="N1:0:20 N2:5:20 N3:20:0"   name:pos_iters:proxy_iters (proxy 0 = no transfer)
"""
import bpy, bmesh, os, sys, math
argv = sys.argv[sys.argv.index("--")+1:]
SRC, PREFIX = argv[0], argv[1]
VARIANTS = os.environ.get('VARIANTS', 'N1:0:20 N2:5:20').split()

def prep():
    bpy.ops.wm.read_factory_settings(use_empty=True)
    bpy.ops.import_scene.gltf(filepath=os.path.abspath(SRC))
    o = [o for o in bpy.data.objects if o.type == 'MESH'][0]
    bpy.context.view_layer.objects.active = o; o.select_set(True)
    try: bpy.ops.mesh.customdata_custom_splitnormals_clear()
    except Exception as e: print('clear:', e)
    bm = bmesh.new(); bm.from_mesh(o.data); bmesh.ops.remove_doubles(bm, verts=bm.verts, dist=1e-5)
    bm.to_mesh(o.data); bm.free(); o.data.update()
    for p in o.data.polygons: p.use_smooth = True
    return o

def smooth_pos(obj, iters):
    if iters <= 0: return
    m = obj.modifiers.new('s', 'SMOOTH'); m.factor = 0.5; m.iterations = iters
    bpy.context.view_layer.objects.active = obj
    bpy.ops.object.modifier_apply(modifier=m.name)

def edge_angle_stats(obj, label):
    bm = bmesh.new(); bm.from_mesh(obj.data)
    ang = sorted(math.degrees(e.calc_face_angle(0.0)) for e in bm.edges if len(e.link_faces) == 2)
    # shading noise: angle between the two vertex normals of each edge (custom normals via loops)
    obj.data.calc_normals_split() if hasattr(obj.data, 'calc_normals_split') else None
    ln = obj.data.corner_normals if hasattr(obj.data, 'corner_normals') else None
    print(f'[{label}] geometry edge-angle median {ang[len(ang)//2]:.1f} p75 {ang[len(ang)*3//4]:.1f}')
    bm.free()

for spec in VARIANTS:
    name, pos_iters, proxy_iters = spec.split(':'); pos_iters, proxy_iters = int(pos_iters), int(proxy_iters)
    o = prep()
    smooth_pos(o, pos_iters)
    if proxy_iters > 0:
        bpy.ops.object.select_all(action='DESELECT'); o.select_set(True); bpy.context.view_layer.objects.active = o
        bpy.ops.object.duplicate(); proxy = bpy.context.active_object; proxy.name = 'proxy'
        smooth_pos(proxy, proxy_iters)
        bpy.context.view_layer.objects.active = o
        dt = o.modifiers.new('nt', 'DATA_TRANSFER'); dt.object = proxy
        dt.use_loop_data = True; dt.data_types_loops = {'CUSTOM_NORMAL'}; dt.loop_mapping = 'POLYINTERP_NEAREST'
        bpy.ops.object.modifier_apply(modifier=dt.name)
        bpy.data.objects.remove(proxy)
    edge_angle_stats(o, name)
    out = f"{PREFIX}_{name}.glb"
    bpy.ops.export_scene.gltf(filepath=out, export_format='GLB', export_apply=True, export_yup=True, use_selection=False)
    print("WROTE", out, os.path.getsize(out)//1024, "KB")
