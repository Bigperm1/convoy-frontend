# ribbon_shift.py <video> — per-frame SUB-PIXEL shift of the route line's fade-in profile relative to the car's nose.
# Straight-ahead route (0 Ave): the line runs up the screen centre above the car. For each frame take the green
# profile (g - r, averaged across the line) along the column from just above the nose upward, then cross-correlate
# with the previous frame's profile: the best lag (parabola-refined) = how far the line's start moved relative to
# the car that frame. Smooth line = ~0 every frame; a stepping cut = drift then a jump back, over and over.
import subprocess, sys, json
import numpy as np
src = sys.argv[1]
X0, X1, Y0, Y1 = 540, 660, 1100, 2000
W, H = X1 - X0, Y1 - Y0
p = subprocess.Popen(["ffmpeg", "-v", "error", "-i", src, "-vf", f"crop={W}:{H}:{X0}:{Y0}", "-fps_mode", "passthrough",
                      "-f", "rawvideo", "-pix_fmt", "rgb24", "-"], stdout=subprocess.PIPE)
prev = None; shifts = []; n = 0
while True:
    buf = p.stdout.read(W * H * 3)
    if len(buf) < W * H * 3: break
    a = np.frombuffer(buf, np.uint8).reshape(H, W, 3).astype(np.float32)
    r, g, b = a[..., 0], a[..., 1], a[..., 2]
    dark = np.maximum(np.maximum(r, g), b) < 110
    ys, xs = np.where(dark[550:890, 20:100])
    if len(ys) < 40: prev = None; continue
    nose = 550 + int(np.percentile(ys, 2))
    green = np.clip(g - r, 0, None)
    col = green[:, :].copy()
    cx = int(np.argmax(col[max(0, nose - 400):nose - 60].mean(axis=0)))       # line centre column
    prof = col[max(0, nose - 420):nose - 8, max(0, cx - 5):cx + 6].mean(axis=1)[::-1]   # index 0 = just above the nose
    n += 1
    if prev is not None and len(prof) == len(prev):
        best, bl = -1e18, 0; cc = {}
        for lag in range(-10, 11):
            A = prof[max(0, lag):len(prof) + min(0, lag)]; B = prev[max(0, -lag):len(prev) + min(0, -lag)]
            A = A - A.mean(); B = B - B.mean(); v = float((A * B).sum() / (np.sqrt((A * A).sum() * (B * B).sum()) + 1e-9)); cc[lag] = v
            if v > best: best, bl = v, lag
        if -10 < bl < 10:
            y0, y1, y2 = cc[bl - 1], cc[bl], cc[bl + 1]; den = y0 - 2 * y1 + y2
            sub = bl + (0.5 * (y0 - y2) / den if abs(den) > 1e-9 else 0.0)
        else: sub = float(bl)
        shifts.append(sub)
    prev = prof
p.wait()
s = np.array(shifts)
print(json.dumps({"frames": n, "pairs": len(s), "rms_px": round(float(np.sqrt((s ** 2).mean())), 3),
                  "p95_abs_px": round(float(np.percentile(np.abs(s), 95)), 2), "max_abs_px": round(float(np.abs(s).max()), 2),
                  "frames_moving_gt1px": int((np.abs(s) > 1).sum()), "frames_moving_gt2px": int((np.abs(s) > 2).sum())}))
np.savetxt(sys.argv[2] if len(sys.argv) > 2 else "/dev/null", s, fmt="%.3f")
