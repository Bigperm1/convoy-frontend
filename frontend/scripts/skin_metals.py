# Skin image generator — Diamond (faceted, prismatic, glints; Jeff 2026-09-17: "go with diamond scrap the other 2"). Source = the GOLD asset: its metal pixels (gold hue band) are the mask and their
# value is the shading; every other pixel is taken from the SILVER twin so all skins share silver's neutral ground.
import colorsys, os, sys, math
import numpy as np
from PIL import Image
rng = np.random.default_rng(7)

def hsv2rgb(h, s, v):  # vectorised, h in [0,1)
    h = (h % 1.0) * 6; i = np.floor(h).astype(int); f = h - i
    p, q, t = v * (1 - s), v * (1 - s * f), v * (1 - s * (1 - f))
    i = i % 6
    r = np.choose(i, [v, q, p, p, t, v]); g = np.choose(i, [t, v, v, q, p, p]); b = np.choose(i, [p, p, t, v, v, q])
    return np.stack([r, g, b], -1)

def rgb2hsv(a):
    r, g, b = a[..., 0], a[..., 1], a[..., 2]; mx = a.max(-1); mn = a.min(-1); d = mx - mn
    h = np.zeros_like(mx); nz = d > 1e-6
    rr = (mx == r) & nz; gg = (mx == g) & nz & ~rr; bb = nz & ~rr & ~gg
    h[rr] = ((g - b)[rr] / d[rr]) % 6; h[gg] = (b - r)[gg] / d[gg] + 2; h[bb] = (r - g)[bb] / d[bb] + 4
    return h / 6, np.where(mx > 0, d / np.maximum(mx, 1e-6), 0), mx

def smooth(e0, e1, x): t = np.clip((x - e0) / (e1 - e0), 0, 1); return t * t * (3 - 2 * t)

def erode(m, r):
    for _ in range(r):
        n = m.copy(); n[1:] &= m[:-1]; n[:-1] &= m[1:]; n[:, 1:] &= m[:, :-1]; n[:, :-1] &= m[:, 1:]; m = n
    return m

def voronoi(h, w, cell, seed):
    r = np.random.default_rng(seed); n = max(6, int(h * w / cell ** 2))
    sy, sx = r.uniform(0, h, n), r.uniform(0, w, n)
    yy, xx = np.mgrid[0:h, 0:w]; best = np.full((h, w), 1e18); idx = np.zeros((h, w), int)
    for k in range(n):
        d = (yy - sy[k]) ** 2 + (xx - sx[k]) ** 2; sel = d < best; best[sel] = d[sel]; idx[sel] = k
    return idx, n, sy, sx

def glint(h, w, cy, cx, size):
    yy, xx = np.mgrid[0:h, 0:w]; dy, dx = yy - cy, xx - cx; s = max(0.8, size * 0.06)
    a = np.exp(-(dy ** 2) / (2 * s * s)) * np.exp(-np.abs(dx) / size) + np.exp(-(dx ** 2) / (2 * s * s)) * np.exp(-np.abs(dy) / size)
    a += 0.6 * np.exp(-((np.abs(dx) - np.abs(dy)) ** 2) / (2 * s * s)) * np.exp(-(np.abs(dx) + np.abs(dy)) / (size * 0.55))
    return np.clip(a, 0, 1)

def finish(skin, rgb, M, L, U, V, edge, h, w, big):
    out = rgb.copy()
    if skin == 'diamond':
        idx, n, sy, sx = voronoi(h, w, max(7, min(h, w) / 7), 11)
        fr = np.random.default_rng(5); kind = fr.random(n)
        fh = np.where(kind < 0.88, fr.uniform(0.53, 0.575, n), np.where(kind < 0.94, fr.uniform(0.80, 0.86, n), fr.uniform(0.45, 0.48, n)))
        fs = np.where(kind < 0.88, fr.uniform(0.30, 0.62, n), fr.uniform(0.16, 0.30, n)); fo = fr.uniform(-0.22, 0.30, n)
        hz = np.where(V < 0.48, 0.12, -0.10)
        val = np.clip(0.60 + 0.45 * L + 0.5 * fo[idx] + hz, 0.30, 1.0)
        col = hsv2rgb(fh[idx], fs[idx] * (1.15 - 0.55 * val), val)
        col = np.where(edge[..., None], np.clip(col * 0.35 + 0.72, 0, 1), col)
        if big:
            g = np.zeros((h, w))
            cand = [(sy[k], sx[k]) for k in np.argsort(-fo) if 0 <= int(sy[k]) < h and 0 <= int(sx[k]) < w and M[int(sy[k]), int(sx[k])]][:4]
            for j, (cy, cx) in enumerate(cand): g = np.maximum(g, glint(h, w, cy, cx, min(h, w) * (0.07 if j else 0.11)))
            col = col * (1 - g[..., None]) + g[..., None]
        out[M] = col[M]
    return out

def road(skin, rgb, M, h, w):          # soft glows (wallpaper road, mic glow): colour transform only, no texture
    H, S, Vv = rgb2hsv(rgb); out = rgb.copy()
    yy, xx = np.mgrid[0:h, 0:w]; hue = 0.547 + 0.045 * np.sin(2 * math.pi * (yy / h * 3.0 + xx / w)); col = hsv2rgb(hue, S * 0.42, np.clip(Vv * 1.12, 0, 1))
    out[M] = col[M]; return out

def make(pattern, skin, soft=False):
    g = np.asarray(Image.open(pattern.format(m='gold')).convert('RGBA')).astype(float) / 255
    sp = pattern.format(m='silver'); s = None
    if os.path.exists(sp):
        s = np.asarray(Image.open(sp).convert('RGBA')).astype(float) / 255
        if s.shape != g.shape: s = None
    h, w = g.shape[:2]; rgb, a = g[..., :3], g[..., 3]
    H, S, Vv = rgb2hsv(rgb); M = (a > 0) & (S >= 0.12) & (H >= 10 / 360) & (H <= 75 / 360)
    base = s[..., :3].copy() if s is not None else rgb.copy()
    if soft: out = road(skin, rgb, M, h, w)
    else:
        lo, hi = np.percentile(Vv[M], 2), np.percentile(Vv[M], 98); L = np.clip((Vv - lo) / max(hi - lo, 1e-6), 0, 1)
        ys, xs = np.nonzero(M); y0, y1, x0, x1 = ys.min(), ys.max(), xs.min(), xs.max()
        yy, xx = np.mgrid[0:h, 0:w]; V = (yy - y0) / max(1, y1 - y0); U = (xx - x0) / max(1, x1 - x0)
        edge = M & ~erode(M, max(1, round(min(h, w) / 110)))
        out = finish(skin, rgb, M, L, U, V, edge, h, w, big=min(h, w) >= 180)
    res = np.where(M[..., None], out, base)
    alpha = np.where(M, a, s[..., 3] if s is not None else a)
    img = np.concatenate([res, alpha[..., None]], -1)
    dst = pattern.format(m=skin); Image.fromarray((np.clip(img, 0, 1) * 255).round().astype(np.uint8), 'RGBA').save(dst)
    return dst, int(M.sum())

def sheen(skin, dst, w=512, h=256):
    yy, xx = np.mgrid[0:h, 0:w]; V = yy / h; U = xx / w
    rgb = np.ones((h, w, 3)); a = np.zeros((h, w))
    if skin == 'diamond':
        idx, n, sy, sx = voronoi(h, w, 34, 3); fr = np.random.default_rng(9); kind = fr.random(n)
        fa = np.where(fr.random(n) < 0.35, 0.0, fr.uniform(0.08, 0.5, n))
        fh = np.where(kind < 0.86, 0.55, np.where(kind < 0.93, 0.82, 0.46)); fs = np.where(kind < 0.86, 0.12, 0.30)
        rgb = hsv2rgb(fh[idx], fs[idx], np.ones((h, w))); a = fa[idx] * np.where(V < 0.48, 1.0, 0.6)
        for cy, cx, sz in [(h * .28, w * .22, 26), (h * .62, w * .7, 18), (h * .2, w * .82, 14), (h * .8, w * .35, 12)]:
            g = glint(h, w, cy, cx, sz); a = np.maximum(a, g); rgb = rgb * (1 - g[..., None]) + g[..., None]
    img = np.concatenate([rgb, a[..., None]], -1)
    Image.fromarray((np.clip(img, 0, 1) * 255).round().astype(np.uint8), 'RGBA').save(dst); return dst

ASSETS = ['assets/images/tabicons/map_on_{m}.png', 'assets/images/tabicons/mic_on_{m}.png', 'assets/images/tabicons/music_on_{m}.png',
          'assets/images/premium/crew_candy_{m}.png', 'assets/images/premium/view2d_candy_{m}.png', 'assets/images/premium/view3d_candy_{m}.png',
          'assets/images/premium/mic_candy_{m}.png', 'assets/images/brand-pin-{m}.png', 'assets/HAIRPIN-{m}3.png',
          'assets/images/tier/h-{m}.png', 'assets/images/tier/h-{m}@2x.png', 'assets/images/tier/h-{m}@3x.png']
SOFT = ['assets/images/mic-glow_{m}.png', 'assets/images/glass-bgt-{m}.png']
if __name__ == '__main__':
    for skin in sys.argv[1:]:
        for p in ASSETS: print(*make(p, skin))
        for p in SOFT: print(*make(p, skin, soft=True))
        print(sheen(skin, f'assets/images/skin/{skin}_sheen.png'))
