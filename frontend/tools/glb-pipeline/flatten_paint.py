"""Flatten baked shading noise in a scan's paint texels, leave everything else.

Meshy's remove_lighting is meshy-6 only (verified in their docs 8/21) - the
meshy-7 albedo still carries capture-time stipple/shading on the paint. Paint on
a grey car = low-saturation texels in a mid-luminance band; we median-filter
those (median resists the dark panel-gap lines bleeding in) and keep glass,
lamps, badges, gaps, wheels untouched. Mask edges are feathered.

usage: python3 flatten_paint.py in.glb out.glb [median_px] [max_edge]
"""
import sys, json, struct, io
from PIL import Image, ImageFilter, ImageChops
src, dst = sys.argv[1], sys.argv[2]
MED = int(sys.argv[3]) if len(sys.argv) > 3 else 9
MAXE = int(sys.argv[4]) if len(sys.argv) > 4 else 2048
BLEND = float(sys.argv[5]) if len(sys.argv) > 5 else 1.0   # 0..1 how much of the median to use
FEATHER = float(sys.argv[6]) if len(sys.argv) > 6 else 1.5
b = open(src,'rb').read()
magic, ver, ln = struct.unpack_from('<III', b, 0)
jl, jt = struct.unpack_from('<II', b, 12); js = json.loads(b[20:20+jl])
bl, bt = struct.unpack_from('<II', b, 20+jl); bin_ = b[28+jl:28+jl+bl]
views = js['bufferViews']
img = js['images'][0]; bv = views[img['bufferView']]
data = bin_[bv['byteOffset']:bv['byteOffset']+bv['byteLength']]
im = Image.open(io.BytesIO(data)).convert('RGB')
print('texture', im.size, img.get('mimeType'))
if max(im.size) > MAXE: im = im.resize((MAXE, MAXE), Image.LANCZOS)
hsv = im.convert('HSV'); h, s, v = hsv.split()
# paint mask: sat < 36/255 (~0.14) AND 72 < value < 238
sat_ok = s.point(lambda x: 255 if x < 36 else 0)
val_ok = v.point(lambda x: 255 if 72 < x < 238 else 0)
mask = ImageChops.multiply(sat_ok, val_ok)
mask = mask.filter(ImageFilter.MinFilter(3)).filter(ImageFilter.MaxFilter(3))   # drop specks
cov = sum(mask.histogram()[128:]) / (mask.size[0]*mask.size[1])
print(f'paint mask covers {cov*100:.1f}% of texels')
feather = mask.filter(ImageFilter.GaussianBlur(FEATHER)).point(lambda x: int(x*BLEND))
smooth = im.filter(ImageFilter.MedianFilter(MED if MED % 2 else MED+1)).filter(ImageFilter.GaussianBlur(1.0))
out = Image.composite(smooth, im, feather)
buf = io.BytesIO(); out.save(buf, 'JPEG', quality=92, subsampling=0); nd = buf.getvalue()
print('image bytes', len(data), '->', len(nd))
# repack: rebuild bin in bufferView order with 4-byte alignment
chunks = []; off = 0
for i, v in enumerate(views):
    d = nd if i == img['bufferView'] else bin_[v['byteOffset']:v['byteOffset']+v['byteLength']]
    v['byteOffset'] = off; v['byteLength'] = len(d); chunks.append(d); off += len(d)
    pad = (4 - off % 4) % 4; chunks.append(b'\x00'*pad); off += pad
newbin = b''.join(chunks); js['buffers'][0]['byteLength'] = len(newbin)
img['mimeType'] = 'image/jpeg'
jb = json.dumps(js, separators=(',',':')).encode(); jb += b' ' * ((4 - len(jb) % 4) % 4)
o = struct.pack('<III', magic, ver, 12+8+len(jb)+8+len(newbin)) + struct.pack('<II', len(jb), jt) + jb + struct.pack('<II', len(newbin), bt) + newbin
open(dst,'wb').write(o); print('WROTE', dst, len(o)//1024, 'KB')
