#!/usr/bin/env python3
"""scan_finish.py — the SCAN pipeline's material pass. Pure Python (PIL + numpy),
runs anywhere the worker runs. See SCAN-PIPELINE.md; this is a pipeline step, not a
bench tool.

WHY: Tripo ships one material whose pbrMetallicRoughness has a metallicRoughness
TEXTURE and NO factors — glTF defaults both factors to 1.0, so the texture is taken
raw. Measured on the first real scan (jeff-20260829-141551): the roughness channel
sits low enough that body panels read as chrome under Mapbox's lighting — "the
reflection is maybe a little too much" (Jeff, 2026-08-29). Factors can't fix it:
final = texture x factor, and a factor can only LOWER a channel, never raise it. So
the texture itself gets remapped:

    roughness' = ROUGH_FLOOR + (1 - ROUGH_FLOOR) * roughness   (lifts the floor,
                                                                keeps variation —
                                                                glass stays glassier
                                                                than paint)
    metallic'  = metallic * METAL_SCALE                        (takes the chrome
                                                                edge off)

Glb surgery only: decode JSON + BIN chunks, re-encode the one MR image, append it to
the BIN, repoint the bufferView, fix alignment. Geometry, UVs, normals and the base
colour are untouched.

Usage:
    python3 scan_finish.py in.glb out.glb [--rough-floor 0.35] [--metal-scale 0.85]
"""
import argparse
import io
import json
import struct
import sys

import numpy as np
from PIL import Image

JSON_T = 0x4E4F534A
BIN_T = 0x004E4942


def read_glb(path):
    d = open(path, "rb").read()
    magic, ver, _total = struct.unpack("<III", d[:12])
    assert magic == 0x46546C67 and ver == 2, "not a glTF 2.0 GLB"
    off, js, bn = 12, None, b""
    while off < len(d):
        ln, ty = struct.unpack("<II", d[off:off + 8])
        chunk = d[off + 8:off + 8 + ln]
        if ty == JSON_T:
            js = json.loads(chunk)
        elif ty == BIN_T:
            bn = chunk
        off += 8 + ln
    return js, bytearray(bn)


def write_glb(path, js, bn):
    jb = json.dumps(js, separators=(",", ":")).encode()
    jb += b" " * (-len(jb) % 4)          # JSON chunk pads with spaces
    bn = bytes(bn) + b"\x00" * (-len(bn) % 4)  # BIN chunk pads with zeros
    total = 12 + 8 + len(jb) + 8 + len(bn)
    with open(path, "wb") as f:
        f.write(struct.pack("<III", 0x46546C67, 2, total))
        f.write(struct.pack("<II", len(jb), JSON_T)); f.write(jb)
        f.write(struct.pack("<II", len(bn), BIN_T)); f.write(bn)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("src"); ap.add_argument("dst")
    ap.add_argument("--rough-floor", type=float, default=0.35,
                    help="minimum roughness after remap (0..1). 0.35 keeps a satin "
                         "clearcoat; raise toward 0.5 for a flatter finish")
    ap.add_argument("--metal-scale", type=float, default=0.85,
                    help="multiplier on the metallic channel")
    a = ap.parse_args()

    js, bn = read_glb(a.src)

    # Find every MR image actually referenced by a material (not by index guess).
    mr_images = set()
    for mat in js.get("materials", []):
        t = (mat.get("pbrMetallicRoughness") or {}).get("metallicRoughnessTexture")
        if t is not None:
            tex = js["textures"][t["index"]]
            mr_images.add(tex["source"])
    if not mr_images:
        print("no metallicRoughness texture — nothing to do"); sys.exit(0)

    for img_i in sorted(mr_images):
        img = js["images"][img_i]
        bv = js["bufferViews"][img["bufferView"]]
        o, n = bv.get("byteOffset", 0), bv["byteLength"]
        pil = Image.open(io.BytesIO(bytes(bn[o:o + n]))).convert("RGB")
        arr = np.asarray(pil).astype(np.float32) / 255.0
        g, b = arr[:, :, 1], arr[:, :, 2]
        print(f"image {img_i}: rough p5/p50/p95 = "
              f"{np.percentile(g,5):.3f}/{np.percentile(g,50):.3f}/{np.percentile(g,95):.3f}  "
              f"metal p50 = {np.percentile(b,50):.3f}")
        arr[:, :, 1] = a.rough_floor + (1.0 - a.rough_floor) * g
        arr[:, :, 2] = np.clip(b * a.metal_scale, 0.0, 1.0)
        out = Image.fromarray((arr * 255.0 + 0.5).astype(np.uint8))
        buf = io.BytesIO(); out.save(buf, format="PNG", optimize=True)
        payload = buf.getvalue()
        # Append the new image at the (4-aligned) end of BIN and repoint the view.
        bn.extend(b"\x00" * (-len(bn) % 4))
        bv["byteOffset"], bv["byteLength"] = len(bn), len(payload)
        bn.extend(payload)
        img["mimeType"] = "image/png"
        print(f"image {img_i}: remapped (floor={a.rough_floor}, metal x{a.metal_scale}), "
              f"{n:,} -> {len(payload):,} bytes")

    js["buffers"][0]["byteLength"] = len(bn)
    write_glb(a.dst, js, bn)
    print(f"wrote {a.dst}")


if __name__ == "__main__":
    main()
