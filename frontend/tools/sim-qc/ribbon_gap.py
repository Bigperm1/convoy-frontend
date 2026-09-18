# ribbon_gap.py <video.mov> — per-frame nose→route-line-start gap from a sim nav recording (heading-up chase view).
# Streams frames (cropped) from ffmpeg; no files. Car nose = top of the dark body near screen centre-bottom;
# line start = lowest row of SOLID route-green above the nose (route #2DEC86: g-r big, b>r — parks are g-r≈g-b).
import subprocess, sys, json
import numpy as np
src = sys.argv[1]
X0, X1, Y0, Y1 = 330, 900, 1100, 2000            # crop (full-res px): car ~ (600,1824), line up and right of it
W, H = X1 - X0, Y1 - Y0
pts = [float(x.strip(",")) for x in subprocess.run(["ffprobe", "-v", "error", "-select_streams", "v:0", "-show_entries", "frame=pts_time",
       "-of", "csv=p=0", src], capture_output=True, text=True).stdout.split()]
p = subprocess.Popen(["ffmpeg", "-v", "error", "-i", src, "-vf", f"crop={W}:{H}:{X0}:{Y0}", "-fps_mode", "passthrough",
                      "-f", "rawvideo", "-pix_fmt", "rgb24", "-"], stdout=subprocess.PIPE)
rows = []; i = 0
while True:
    buf = p.stdout.read(W * H * 3)
    if len(buf) < W * H * 3: break
    a = np.frombuffer(buf, np.uint8).reshape(H, W, 3).astype(np.int16)
    r, g, b = a[..., 0], a[..., 1], a[..., 2]
    t = pts[i] if i < len(pts) else None; i += 1
    # car: dark body in a window around the expected car position
    cy0, cy1, cx0, cx1 = 1650 - Y0, 1990 - Y0, 520 - X0, 690 - X0
    dark = (np.maximum(np.maximum(r, g), b) < 110)
    ys, xs = np.where(dark[cy0:cy1, cx0:cx1])
    if len(ys) < 40: rows.append((t, None, None)); continue
    nose = cy0 + np.percentile(ys, 2)
    solid = (g - r > 110) & (b - r > 40)          # the route core, well into its fade
    above = solid[: int(nose) - 1, :]
    cnt = above.sum(axis=1)
    if cnt.max() < 6: rows.append((t, nose, None)); continue
    line_rows = np.where(cnt >= max(4, 0.3 * np.median(cnt[cnt > 0])))[0]
    start = line_rows.max()                         # lowest solid-green row = the visible line start
    rows.append((t, float(nose), float(start)))
p.wait()
ok = [(t, n, s) for t, n, s in rows if n is not None and s is not None]
gap = np.array([(n - s) / 3.0 for t, n, s in ok])          # pt
st = np.array([s for t, n, s in ok]); tt = np.array([t for t, n, s in ok])
d = np.diff(st)                                              # per-frame movement of the line start (px), + = toward the car
print(json.dumps({"frames": len(rows), "measured": len(ok),
    "gap_pt_median": round(float(np.median(gap)), 1), "gap_pt_p5": round(float(np.percentile(gap, 5)), 1), "gap_pt_p95": round(float(np.percentile(gap, 95)), 1),
    "gap_pt_std": round(float(np.std(gap)), 2),
    "start_static_frac": round(float(np.mean(np.abs(d) < 0.5)), 3),
    "jump_px_p95": round(float(np.percentile(np.abs(d), 95)), 1), "jump_px_max": round(float(np.abs(d).max()), 1),
    "jumps_gt3px_per_s": round(float((np.abs(d) > 3).sum() / max(1e-6, tt[-1] - tt[0])), 2)}))
np.savetxt(sys.argv[2] if len(sys.argv) > 2 else "/dev/null", np.column_stack([tt, gap]), fmt="%.4f")
