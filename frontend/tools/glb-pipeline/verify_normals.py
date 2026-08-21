"""Topology-independent smoothness of the shading normal field: for every vertex,
mean angle between its (custom) normal and the normals of all vertices within
1% of car length — works on triangle soup and welded meshes alike."""
import bpy, math, sys, mathutils
for src in sys.argv[sys.argv.index("--")+1:]:
    bpy.ops.wm.read_factory_settings(use_empty=True); bpy.ops.import_scene.gltf(filepath=src)
    pts=[]; nrm=[]
    for o in [o for o in bpy.data.objects if o.type=='MESH']:
        me=o.data; M=o.matrix_world; R=M.to_3x3()
        acc={}
        for l in me.loops:
            acc.setdefault(l.vertex_index, mathutils.Vector()); acc[l.vertex_index]+=l.normal
        for vi,nv in acc.items():
            if nv.length>1e-9: pts.append(M@me.vertices[vi].co); nrm.append((R@nv).normalized())
    xs=[p.x for p in pts]; L=max(max(xs)-min(xs), max(p.y for p in pts)-min(p.y for p in pts), max(p.z for p in pts)-min(p.z for p in pts))
    kd=mathutils.kdtree.KDTree(len(pts))
    for i,p in enumerate(pts): kd.insert(p,i)
    kd.balance(); r=L*0.01; tot=0; n=0
    step=max(1,len(pts)//20000)
    for i in range(0,len(pts),step):
        for (co,j,d) in kd.find_range(pts[i], r):
            if j==i: continue
            dd=max(-1.0,min(1.0,nrm[i].dot(nrm[j]))); tot+=math.degrees(math.acos(dd)); n+=1
    print(f"{src.split('/')[-1]}: verts {len(pts)} | mean normal angle to neighbours within 1% L = {tot/max(n,1):.2f} deg")
