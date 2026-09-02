import json, struct, sys, io
import numpy as np
from PIL import Image
CT={5121:('u8',1),5123:('u16',2),5125:('u32',4),5126:('f32',4)}
def read(p):
    d=open(p,'rb').read()
    magic,ver,total=struct.unpack('<III',d[:12]); off=12; js=None; bn=b''
    while off<len(d):
        ln,ty=struct.unpack('<II',d[off:off+8]); ch=d[off+8:off+8+ln]
        if ty==0x4E4F534A: js=json.loads(ch)
        elif ty==0x004E4942: bn=ch
        off+=8+ln
    return js,bn,len(d)
for p in sys.argv[1:]:
    js,bn,size=read(p)
    print("=====",p,"bytes",size)
    print("asset",js.get('asset'))
    print("nodes",len(js.get('nodes',[])),"meshes",len(js.get('meshes',[])),"materials",len(js.get('materials',[])),"images",len(js.get('images',[])),"textures",len(js.get('textures',[])))
    for n in js.get('nodes',[]): 
        if any(k in n for k in ('translation','rotation','scale','matrix')): print("node xform",{k:n[k] for k in n if k in('name','translation','rotation','scale','matrix')})
    tv=0; mn=np.array([1e9]*3); mx=np.array([-1e9]*3)
    for mi,m in enumerate(js['meshes']):
        for pi,pr in enumerate(m['primitives']):
            pa=js['accessors'][pr['attributes']['POSITION']]; tv+=pa['count']
            idx=pr.get('indices'); it=js['accessors'][idx]['componentType'] if idx is not None else None
            print(f" mesh{mi} prim{pi} verts={pa['count']} idx={CT.get(it,(it,))[0]} idxcount={js['accessors'][idx]['count'] if idx is not None else None} tris={(js['accessors'][idx]['count']//3) if idx is not None else pa['count']//3} mat={pr.get('material')} attrs={list(pr['attributes'])} min={pa.get('min')} max={pa.get('max')}")
            mn=np.minimum(mn,pa['min']); mx=np.maximum(mx,pa['max'])
    print("TOTAL verts",tv,"bbox min",mn.round(4).tolist(),"max",mx.round(4).tolist(),"size",(mx-mn).round(4).tolist(),"centre",((mx+mn)/2).round(4).tolist())
    for mi,mat in enumerate(js.get('materials',[])):
        print(" material",mi,json.dumps(mat)[:400])
    for ii,img in enumerate(js.get('images',[])):
        bv=js['bufferViews'][img['bufferView']]; o=bv.get('byteOffset',0); n=bv['byteLength']
        im=Image.open(io.BytesIO(bn[o:o+n])); arr=np.asarray(im.convert('RGB')).astype(np.float32)/255
        g,b=arr[:,:,1],arr[:,:,2]
        print(f" image{ii} mime={img.get('mimeType')} fmt={im.format} size={im.size} bytes={n} G(rough) p5/p50/p95={np.percentile(g,5):.3f}/{np.percentile(g,50):.3f}/{np.percentile(g,95):.3f} B(metal) p50={np.percentile(b,50):.3f} R p50={np.percentile(arr[:,:,0],50):.3f}")
