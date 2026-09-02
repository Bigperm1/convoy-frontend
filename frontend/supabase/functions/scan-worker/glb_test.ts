// glb_test.ts — the QC gates and the material pass.
//
// Two layers: (1) synthetic GLBs, always run; (2) the REAL Tripo converts of the
// enablewhore scan plus scan_finish.py's reference output, when GLB_FIXTURES_DIR is set
// (tools/glb-pipeline/scan_worker_dryrun.sh prepares it). Layer 2 asserts the numbers
// SCAN-PIPELINE.md already measured and pixel-for-pixel parity with the Python pass.

import { assert, assertEquals } from "jsr:@std/assert@1";
import { decodeImage, expectedBinLength, finishMaterial, metallicRoughnessImages, parseGlb, qcHero, qcTwin, remapMetallicRoughness, sha256Hex } from "./glb.ts";
import { makeTestGlb } from "./fakes.ts";

Deno.test("synthetic twin passes every gate", () => {
  const r = qcTwin(makeTestGlb({ verts: 100 }));
  assertEquals(r.failures, []);
  assertEquals(r.metrics.indexTypes, ["u16"]);
  assertEquals(r.metrics.totalVerts, 100);
  assert(Math.abs(r.metrics.size[0] - 1.9101) < 1e-5);
});

Deno.test("gates fail for u32, too many verts, wrong length, floating, off-centre, no MR", () => {
  assert(qcTwin(makeTestGlb({ indexType: 5125 })).failures.some((f) => f.includes("u32")));
  assert(qcTwin(makeTestGlb({ verts: 25_000 })).failures.some((f) => f.startsWith("verts 25000")));
  assert(qcTwin(makeTestGlb({ sizeX: 2.2 })).failures.some((f) => f.startsWith("length-x")));
  assert(qcTwin(makeTestGlb({ minY: 0.1 })).failures.some((f) => f.startsWith("miny")));
  assert(qcTwin(makeTestGlb({ centreX: 0.05 })).failures.some((f) => f.startsWith("centre-x")));
  assert(qcTwin(new Uint8Array([1, 2, 3])).failures[0].startsWith("parse:"));
  // the hero tolerates u32 and any vertex count
  assertEquals(qcHero(makeTestGlb({ indexType: 5125, verts: 90_000 })).pass, true);
});

Deno.test("spec gates only: no-MR is a WARNING on both files; the hero's geometry deviations are warnings, never failures", () => {
  const noMr = qcTwin(makeTestGlb({ verts: 100, withMR: false }));
  assertEquals(noMr.pass, true);
  assertEquals(noMr.warnings, ["no-metallicRoughness-texture"]);
  // SCAN-PIPELINE.md: "Hero: <= 30 MB only" — a stretched, floating, off-centre hero still passes, loudly
  const hero = qcHero(makeTestGlb({ verts: 100, sizeX: 2.2, minY: 0.1, centreX: 0.05, withMR: false }));
  assertEquals(hero.pass, true);
  assertEquals(hero.failures, []);
  assertEquals(hero.warnings.length, 4);
  assert(hero.warnings.some((w) => w.startsWith("length-x")) && hero.warnings.includes("no-metallicRoughness-texture"));
  // the same file as a twin FAILS on the geometry
  assertEquals(qcTwin(makeTestGlb({ verts: 100, sizeX: 2.2, minY: 0.1, centreX: 0.05 })).pass, false);
  // the hero still fails what the spec says it fails: unparseable, oversized
  assert(qcHero(new Uint8Array([1, 2, 3])).failures[0].startsWith("parse:"));
  // and the material pass passes a no-MR file through untouched instead of throwing
  const src = makeTestGlb({ verts: 100, withMR: false });
  const { bytes, report } = finishMaterial(src);
  assertEquals(report.remappedImages, []);
  assertEquals(bytes, src);
});

Deno.test("remap: G' = 0.35 + 0.65 G, B' = 0.85 B, R untouched, round-half-up", () => {
  const img = { width: 2, height: 1, data: new Uint8Array([10, 0, 255, 255, 200, 255, 0, 255]) };
  const out = remapMetallicRoughness(img);
  assertEquals([...out.data], [10, 89, 217, 255, 200, 255, 0, 255]);
});

Deno.test("finishMaterial rewrites only the MR image, rebuilds the BIN, keeps geometry bytes", async () => {
  const src = makeTestGlb({ verts: 50 });
  const before = parseGlb(src);
  const { bytes, report } = finishMaterial(src);
  const after = parseGlb(bytes);
  assertEquals(report.remappedImages, [1]);
  assertEquals(after.json.images[1].mimeType, "image/png");
  assertEquals(after.json.buffers[0].byteLength, expectedBinLength(after.json));
  assert(after.bin.byteLength - after.json.buffers[0].byteLength < 4, "only alignment padding after the last view");
  // geometry + base colour byte-identical
  for (const i of [0, 1, 2, 3, 4]) {
    const a = before.json.bufferViews[i];
    const b = after.json.bufferViews[i];
    assertEquals(before.bin.subarray(a.byteOffset, a.byteOffset + a.byteLength), after.bin.subarray(b.byteOffset, b.byteOffset + b.byteLength));
  }
  // the MR pixels moved as the formula says
  const mrBefore = decodeImage(before.bin.subarray(before.json.bufferViews[5].byteOffset, before.json.bufferViews[5].byteOffset + before.json.bufferViews[5].byteLength)).img;
  const mrAfter = decodeImage(after.bin.subarray(after.json.bufferViews[5].byteOffset, after.json.bufferViews[5].byteOffset + after.json.bufferViews[5].byteLength)).img;
  assertEquals(mrAfter.data, remapMetallicRoughness(mrBefore).data);
  // still passes the gates, and the hash is stable
  assertEquals(qcTwin(bytes).pass, true);
  assertEquals(await sha256Hex(bytes), await sha256Hex(finishMaterial(src).bytes));
});

// ── real fixtures ────────────────────────────────────────────────────────────

const FIX = Deno.env.get("GLB_FIXTURES_DIR");

async function readFixture(name: string): Promise<Uint8Array | null> {
  if (!FIX) return null;
  try {
    return await Deno.readFile(`${FIX}/${name}`);
  } catch {
    return null;
  }
}

function mrPixels(glb: Uint8Array) {
  const g = parseGlb(glb);
  const [imgIdx] = metallicRoughnessImages(g.json);
  const bv = g.json.bufferViews[g.json.images[imgIdx].bufferView];
  return decodeImage(g.bin.subarray(bv.byteOffset ?? 0, (bv.byteOffset ?? 0) + bv.byteLength)).img;
}

Deno.test({
  name: "REAL raw enablewhore twin: 14,201 verts, u16, 1.9101 long, grounded, centred",
  ignore: !FIX,
  async fn() {
    const raw = await readFixture("raw_twin.glb");
    if (!raw) throw new Error("raw_twin.glb missing from GLB_FIXTURES_DIR");
    const r = qcTwin(raw);
    assertEquals(r.failures, []);
    assertEquals(r.metrics.totalVerts, 14201);
    assertEquals(r.metrics.indexTypes, ["u16"]);
    assert(Math.abs(r.metrics.size[0] - 1.9101) < 0.0005, `size x ${r.metrics.size[0]}`);
    assertEquals(r.metrics.min[1], 0);
    assert(Math.abs(r.metrics.centre[0]) < 0.001 && Math.abs(r.metrics.centre[2]) < 0.001);
    assertEquals(r.metrics.bytes, 1146948);
  },
});

Deno.test({
  name: "REAL raw enablewhore hero: 85,856 verts, u32 (invisible on Mapbox, fine in the WebView), passes hero gates",
  ignore: !FIX,
  async fn() {
    const raw = await readFixture("raw_hero.glb");
    if (!raw) throw new Error("raw_hero.glb missing");
    const r = qcHero(raw);
    assertEquals(r.failures, []);
    assertEquals(r.metrics.totalVerts, 85856);
    assertEquals(r.metrics.indexTypes, ["u32"]);
    // and the same file would FAIL as a twin, on exactly the u32 + vert gates
    const asTwin = qcTwin(raw);
    assert(asTwin.failures.some((f) => f.includes("u32")));
    assert(asTwin.failures.some((f) => f.startsWith("verts-per-mesh")));
  },
});

Deno.test({
  name: "REAL material pass == scan_finish.py pixel-for-pixel, and drops the orphaned MR bytes",
  ignore: !FIX,
  async fn() {
    const raw = await readFixture("raw_twin.glb");
    const ref = await readFixture("ref_twin.glb");
    if (!raw || !ref) throw new Error("raw_twin.glb / ref_twin.glb missing");
    const { bytes, report } = finishMaterial(raw);
    const ours = mrPixels(bytes);
    const theirs = mrPixels(ref);
    assertEquals([ours.width, ours.height], [theirs.width, theirs.height]);
    let diff = 0;
    for (let i = 0; i < ours.data.length; i++) if (i % 4 !== 3 && ours.data[i] !== theirs.data[i]) diff++;
    assertEquals(diff, 0, `${diff} channel values differ from scan_finish.py`);
    // identical glTF JSON modulo bufferView offsets/lengths
    const strip = (glb: Uint8Array) => {
      const j = structuredClone(parseGlb(glb).json);
      for (const bv of j.bufferViews) {
        delete bv.byteOffset;
        delete bv.byteLength;
      }
      delete j.buffers[0].byteLength;
      return JSON.stringify(j);
    };
    assertEquals(strip(bytes), strip(ref));
    // no orphan bytes: BIN == sum of views (+ alignment); the Python output is larger by the old image
    const after = parseGlb(bytes);
    assertEquals(after.json.buffers[0].byteLength, expectedBinLength(after.json));
    const refParsed = parseGlb(ref);
    assert(refParsed.json.buffers[0].byteLength > expectedBinLength(refParsed.json), "scan_finish.py leaves the old MR bytes behind (expected)");
    // geometry identical to the raw input
    const rawParsed = parseGlb(raw);
    for (let i = 0; i < rawParsed.json.bufferViews.length; i++) {
      if (report.remappedImages.some((img) => rawParsed.json.images[img].bufferView === i)) continue;
      const a = rawParsed.json.bufferViews[i];
      const b = after.json.bufferViews[i];
      assertEquals(rawParsed.bin.subarray(a.byteOffset ?? 0, (a.byteOffset ?? 0) + a.byteLength), after.bin.subarray(b.byteOffset, b.byteOffset + b.byteLength));
    }
    assertEquals(qcTwin(bytes).pass, true);
    console.log(`    finish twin: ${report.inBytes} -> ${report.outBytes} B (python ref ${ref.byteLength} B), ${report.cpuMs} ms`);
  },
});

Deno.test({
  name: "REAL hero material pass stays inside the CPU budget",
  ignore: !FIX,
  async fn() {
    const raw = await readFixture("raw_hero.glb");
    if (!raw) throw new Error("raw_hero.glb missing");
    const { bytes, report } = finishMaterial(raw);
    assertEquals(qcHero(bytes).pass, true);
    console.log(`    finish hero: ${report.inBytes} -> ${report.outBytes} B, ${report.cpuMs} ms (${report.imageFormats.join(",")})`);
    assert(report.cpuMs < 1500, `hero finish took ${report.cpuMs} ms`);
  },
});

Deno.test({
  name: "REAL published jeff twin (the 40k-face evaluation build) FAILS the documented <25,000-vert gate",
  ignore: !FIX,
  async fn() {
    const jeff = await readFixture("published_jeff_twin.glb");
    if (!jeff) return; // optional fixture
    const r = qcTwin(jeff);
    assertEquals(r.metrics.totalVerts, 28367);
    assertEquals(r.metrics.indexTypes, ["u16"]);
    assert(r.failures.some((f) => f.startsWith("verts 28367")));
  },
});
