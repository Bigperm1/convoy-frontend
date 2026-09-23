import sys, numpy as np
from PIL import Image
O=sys.argv[1]
def ld(p): return np.asarray(Image.open(p).convert('RGBA')).astype(float)/255
def over(dst, src):
    a=src[...,3:4]; return dst*(1-a)+src[...,:3]*a
def hexc(h): h=h.lstrip('#'); return np.array([int(h[i:i+2],16)/255 for i in (0,2,4)])
def comp(name, bands, paints):
    base=ld(f'{O}/{name}.png'); H,W=base.shape[:2]
    out=np.zeros((H,W,3)); out[:]=np.array([0.06,0.07,0.08])
    out=over(out,base)
    for band,col in zip(bands,paints):
        if col is None: continue
        blk=ld(f'{O}/{name}_{band}black.png'); msk=ld(f'{O}/{name}_{band}mask.png')
        out=over(out,blk); t=msk.copy(); t[...,:3]=hexc(col); out=over(out,t)
    return (out*255).astype(np.uint8)
rows=[]
for name,bands,sets in [
  ('garage-arrow-2d',['body','rim'],[(None,None),('#FF3B30',None),('#0A84FF','#FFD60A')]),
  ('garage-arrow-3d',['body','rim'],[(None,None),('#FF3B30',None),('#0A84FF','#FFD60A')]),
]:
    ims=[Image.fromarray(comp(name,bands,s)) for s in sets]
    h=220; ims=[i.resize((int(i.width*h/i.height),h)) for i in ims]
    row=Image.new('RGB',(sum(i.width for i in ims),h)); x=0
    for i in ims: row.paste(i,(x,0)); x+=i.width
    rows.append(row)
W=max(r.width for r in rows); sheet=Image.new('RGB',(W,sum(r.height for r in rows)),(15,17,20)); y=0
for r in rows: sheet.paste(r,(0,y)); y+=r.height
sheet.save(sys.argv[2])
