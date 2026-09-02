// dryrun.ts — proves the worker's logic WITHOUT spending a credit or publishing a byte.
//
// Run through tools/glb-pipeline/scan_worker_dryrun.sh (it starts the Tripo stub and
// sets the env). Steps, each printing a receipt block:
//   1. car-scans listing for one real scan via the read-only fetch-scan door
//      (FETCH_SCAN_ANON + HAIRPIN_PUBLISH_KEY from the env; skipped if absent)
//   2. the real manifest.json -> parseManifest -> shot->view mapping
//   3. the QC gates against the already-PUBLISHED public models (jeff + enablewhore)
//   4. the whole state machine, ticked to `done`, against the local Tripo stub and an
//      in-memory `models` bucket: every Tripo payload and every WOULD-publish is printed
//   5. the pre-flight rules against the REAL public bucket (already-published -> done,
//      twin-only -> skipped manual-in-progress) — HEAD requests only
// Nothing here can write to Supabase: no service role key is read or used.

import { runTick } from "./worker.ts";
import { FakeWorld, newJob, seedFolder } from "./fakes.ts";
import { checkFolder, mapShotsToViews, parseManifest, SHOT_FILE } from "./manifest.ts";
import type { ShotId, TripoView } from "./manifest.ts";
import { qcHero, qcTwin } from "./glb.ts";
import { TripoClient } from "./tripo.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "https://pgtbjiszjglznjagolse.supabase.co";
const PUBLIC_MODELS = `${SUPABASE_URL}/storage/v1/object/public/models`;
const SCAN = Deno.env.get("SCAN_ID") ?? "enablewhore-20260901-185736";
const ANON = Deno.env.get("FETCH_SCAN_ANON") ?? "";
const PUBLISH_KEY = Deno.env.get("HAIRPIN_PUBLISH_KEY") ?? "";
const TRIPO_BASE_URL = Deno.env.get("TRIPO_BASE_URL") ?? "";
const FIXTURES = Deno.env.get("GLB_FIXTURES_DIR") ?? "";

const hr = (t: string) => console.log(`\n═══ ${t} ${"═".repeat(Math.max(0, 70 - t.length))}`);
const secret = (name: string, v: string) => `${name}=${v ? `<set, length ${v.length}>` : "<unset>"}`;

let failures = 0;
function check(cond: boolean, msg: string) {
  console.log(`  ${cond ? "PASS" : "FAIL"}  ${msg}`);
  if (!cond) failures++;
}

hr("0. environment");
console.log(`  ${secret("FETCH_SCAN_ANON", ANON)}  ${secret("HAIRPIN_PUBLISH_KEY", PUBLISH_KEY)}  TRIPO_BASE_URL=${TRIPO_BASE_URL || "<unset>"}`);
console.log(`  GLB_FIXTURES_DIR=${FIXTURES || "<unset>"}  SCAN_ID=${SCAN}  SUPABASE_URL=${SUPABASE_URL}`);
console.log(`  no SUPABASE_SERVICE_ROLE_KEY / TRIPO_API_KEY are read by this script`);

// ── 1 + 2: the real scan folder through fetch-scan ───────────────────────────
const realEntries: { name: string; size: number }[] = [];
let realManifest: string | null = null;
if (ANON && PUBLISH_KEY) {
  hr(`1. car-scans/${SCAN} via fetch-scan (read-only, 300 s signed URLs)`);
  const res = await fetch(`${SUPABASE_URL}/functions/v1/fetch-scan?scan=${encodeURIComponent(SCAN)}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${ANON}`, apikey: ANON, "x-publish-key": PUBLISH_KEY },
  });
  console.log(`  HTTP ${res.status}`);
  if (res.ok) {
    const j = (await res.json()) as { ok: boolean; ttl: number; files: { path: string; url: string }[] };
    for (const f of j.files) {
      const h = await fetch(f.url, { method: "HEAD" });
      const size = Number(h.headers.get("content-length") ?? 0);
      let bytes = size;
      if (f.path.endsWith("manifest.json")) {
        realManifest = await (await fetch(f.url)).text();
        bytes = new TextEncoder().encode(realManifest).byteLength; // HEAD on a signed URL reports no length for the small JSON
      }
      realEntries.push({ name: f.path.split("/").slice(1).join("/"), size: bytes });
      console.log(`  ${f.path.padEnd(48)} ${String(bytes).padStart(9)} B  (signed url ttl ${j.ttl}s)`);
    }
    const c = checkFolder(realEntries);
    check(c.complete, `folder complete: missing=[${c.missing}] small=[${c.small}] manifest=${c.hasManifest}`);
  } else {
    check(false, `fetch-scan returned ${res.status}`);
  }

  hr("2. manifest -> handle + shot->view mapping");
  if (realManifest) {
    const p = parseManifest(realManifest, SCAN);
    check(p.ok, `parseManifest: ${p.ok ? `handle=${p.handle} uploaded=4 failed=[]` : p.reason}`);
    if (p.ok) {
      const views = mapShotsToViews(p.manifest.shots);
      console.log(`  manifest.shots = ${JSON.stringify(p.manifest.shots)}`);
      for (const v of ["front", "left", "back", "right"] as TripoView[]) {
        const shot: ShotId = views[v];
        console.log(`  Tripo view ${v.padEnd(5)} <- shot "${shot}" <- ${SHOT_FILE[shot]}`);
      }
      check(views.back === "rear" && SHOT_FILE[views.back] === "03-rear.jpg", "rear photo feeds Tripo's BACK view (trap 1)");
      check(views.left === "left" && SHOT_FILE[views.left] === "04-left.jpg", "04-left feeds LEFT, not position 2");
    }
  }
} else {
  hr("1–2. SKIPPED (FETCH_SCAN_ANON / HAIRPIN_PUBLISH_KEY not provided)");
}

// ── 3: QC gates on the published models ──────────────────────────────────────
hr("3. QC gates against the PUBLISHED public models (download + measure)");
const fmt = (n: number) => n.toFixed(4);
for (const [name, kind] of [
  ["scan_jeff-20260829-141551_map.glb", "twin"],
  ["scan_jeff-20260829-141551.glb", "hero"],
  ["scan_enablewhore-20260901-185736_map.glb", "twin"],
  ["scan_enablewhore-20260901-185736.glb", "hero"],
] as const) {
  const res = await fetch(`${PUBLIC_MODELS}/${name}`);
  if (!res.ok) {
    check(false, `${name}: HTTP ${res.status}`);
    continue;
  }
  const bytes = new Uint8Array(await res.arrayBuffer());
  const r = kind === "twin" ? qcTwin(bytes) : qcHero(bytes);
  const m = r.metrics;
  console.log(
    `  ${name}\n    bytes=${m.bytes} verts=${m.totalVerts} maxPrim=${m.maxPrimVerts} idx=${m.indexTypes.join("/")} size=[${m.size.map(fmt)}] minY=${fmt(m.min[1])} centre=[${fmt(m.centre[0])},${fmt(m.centre[2])}] materialsWithMR=${m.materialsWithMR} images=${m.images.map((i) => `${i.mimeType}:${i.bytes}`).join(",")}`,
  );
  console.log(`    ${kind} gates: ${r.pass ? "PASS" : `FAIL -> ${r.failures.join("; ")}`}`);
}
console.log("  (expected: jeff twin FAILS 'verts 28367' — it is the 40k-face evaluation build; the recipe the worker runs is 20k)");

// ── 4: the state machine, end to end, against the stub ───────────────────────
hr("4. state machine end-to-end vs the Tripo STUB + in-memory models bucket");
if (!TRIPO_BASE_URL) {
  check(false, "TRIPO_BASE_URL unset — start tools/glb-pipeline/tripo_stub.py");
} else {
  const scanId = "dryrun-20260902-000001";
  const manifest = realManifest ? realManifest.replace(SCAN, scanId) : undefined;
  const folder = seedFolder(scanId, manifest);
  if (realEntries.length) {
    for (const e of realEntries) if (e.name.endsWith(".jpg")) folder[`${scanId}/${e.name}`] = new Uint8Array(e.size).fill(0x42);
  }
  const tripo = new TripoClient({ apiKey: "tsk_dryrun_not_a_real_key", baseUrl: TRIPO_BASE_URL, timeoutMs: 30_000 });
  const w = new FakeWorld({ jobs: [newJob(scanId)], carScans: folder, tripo, quiet: false });
  const transitions: string[] = [];
  for (let i = 0; i < 40; i++) {
    const r = await runTick(w.deps(), { tickId: `dry${i}` });
    if (r.idle === "disabled") break;
    for (const jr of r.jobs) if (jr.from !== jr.to) transitions.push(`${jr.from}->${jr.to}`);
    if (["done", "failed", "skipped"].includes(w.job(scanId).status)) break;
    w.advance(61); // past the 60 s post-generate wait and every 30 s poll
  }
  const j = w.job(scanId);
  console.log(`  transitions: ${transitions.join("  ")}`);
  console.log(`  job: status=${j.status} reason=${j.reason} credits_spent=${j.credits_spent} gen=${j.tripo_gen_task} map=${j.tripo_map_task} hero=${j.tripo_hero_task}`);
  console.log(`  publish order: ${w.publishOrder.join(" then ")}`);
  console.log(`  twin sha256=${j.twin_sha256}\n  hero sha256=${j.hero_sha256}`);
  console.log(`  breadcrumbs (${w.breadcrumbs.length}):`);
  for (const b of w.breadcrumbs) console.log(`    ${b.handle ?? "-"}  ${b.message}`);
  check(j.status === "done", "job reached done");
  check(j.credits_spent === 50, `credits_spent == 50 (got ${j.credits_spent})`);
  check(w.publishOrder[0]?.endsWith("_map.glb") === true && w.publishOrder[1] === `scan_${scanId}.glb`, "twin published FIRST, hero LAST");
  const twin = w.models.get(`scan_${scanId}_map.glb`);
  const hero = w.models.get(`scan_${scanId}.glb`);
  if (twin && hero) {
    const qt = qcTwin(twin);
    const qh = qcHero(hero);
    check(qt.pass, `finished twin passes the Mapbox gates (verts=${qt.metrics.totalVerts} idx=${qt.metrics.indexTypes} bytes=${qt.metrics.bytes})`);
    check(qh.pass, `finished hero passes the hero gates (verts=${qh.metrics.totalVerts} idx=${qh.metrics.indexTypes} bytes=${qh.metrics.bytes})`);
  }
  check(w.breadcrumbs.length === 5, `exactly 5 breadcrumbs, one per transition (got ${w.breadcrumbs.length})`);
}

// ── 5: pre-flight against the REAL bucket (HEAD only) ────────────────────────
hr("5. pre-flight rules against the REAL public models bucket (HEAD only, no writes)");
{
  const w = new FakeWorld({
    jobs: [newJob("jeff-20260829-141551", { handle: "jeff" }), newJob("claudetest-20260821-000001"), newJob("enablewhore-20260901-185736", { handle: "enablewhore", status: "generating", tripo_gen_task: "would-be-a-real-id", generate_submitted_at: "2026-09-02T12:00:00Z" })],
    publicModelBase: PUBLIC_MODELS,
    quiet: false,
  });
  for (let i = 0; i < 5; i++) {
    const r = await runTick(w.deps(), { tickId: `pre${i}` });
    if (r.idle) break;
    w.advance(31);
  }
  const jeff = w.job("jeff-20260829-141551");
  const ct = w.job("claudetest-20260821-000001");
  const en = w.job("enablewhore-20260901-185736");
  check(jeff.status === "done" && jeff.reason === "already-published" && jeff.credits_spent === 0, `jeff: ${jeff.status}/${jeff.reason} credits=${jeff.credits_spent}`);
  check(ct.status === "skipped" && ct.reason === "manual-in-progress", `claudetest (twin only in the bucket): ${ct.status}/${ct.reason}`);
  check(en.status === "done" && en.reason === "already-published" && en.credits_spent === 0, `enablewhore mid-flight 'generating' with both models live: ${en.status}/${en.reason} credits=${en.credits_spent}`);
}

hr(failures === 0 ? "DRY RUN PASSED — 0 credits spent, 0 bytes published" : `DRY RUN FAILED — ${failures} check(s) failed`);
Deno.exit(failures === 0 ? 0 : 1);
