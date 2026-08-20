import bpy, os, sys, mathutils
# usage: blender --background --python inspect_pack.py -- <pack.glb>
SRC=sys.argv[sys.argv.index("--")+1]
bpy.ops.wm.read_factory_settings(use_empty=True)
bpy.ops.import_scene.gltf(filepath=os.path.abspath(SRC))
for o in bpy.data.objects:
    if o.type=='MESH': o.data.calc_loop_triangles()
def desc(o):
    out,st=[],list(o.children)
    while st:
        c=st.pop(); out.append(c); st.extend(c.children)
    return out
def bb(objs):
    mn=mathutils.Vector((1e9,)*3); mx=mathutils.Vector((-1e9,)*3); ok=False
    for o in objs:
        if o.type!='MESH': continue
        ok=True
        for cb in o.bound_box:
            w=o.matrix_world @ mathutils.Vector(cb)
            mn=mathutils.Vector(map(min,mn,w)); mx=mathutils.Vector(map(max,mx,w))
    return (mn,mx) if ok else (None,None)
roots=[o for o in bpy.data.objects if o.parent is None]
rows=[]
for r in roots:
    fam=[r]+desc(r)
    tris=sum(len(o.data.loop_triangles) for o in fam if o.type=='MESH')
    mn,mx=bb(fam)
    size=tuple(round(v,2) for v in (mx-mn)) if mn else None
    rows.append((tris, r.name, r.type, len(fam), size))
rows.sort(reverse=True)
for t,name,typ,n,size in rows[:15]:
    print(f"ROOT tris={t:8d} n={n:3d} {typ:9s} size={size}  {name!r}")
print("TOTAL", sum(r[0] for r in rows), "MATERIALS", len(bpy.data.materials))
