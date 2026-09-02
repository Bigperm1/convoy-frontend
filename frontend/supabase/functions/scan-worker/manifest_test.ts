import { assertEquals, assertThrows } from "jsr:@std/assert@1";
import { checkFolder, isJunkScanId, mapShotsToViews, normaliseHandle, parseManifest, SHOT_FILE } from "./manifest.ts";
import { ENABLEWHORE_MANIFEST } from "./fakes.ts";

Deno.test("shots front/right/rear/left map to Tripo front/right/back/left by ID, never by position", () => {
  const m = mapShotsToViews(["front", "right", "rear", "left"]);
  assertEquals(m, { front: "front", right: "right", back: "rear", left: "left" });
  // order in the manifest is irrelevant
  assertEquals(mapShotsToViews(["left", "rear", "right", "front"]), m);
  // and the view -> bucket file chain lands on the numbered names the app writes
  assertEquals(SHOT_FILE[m.back], "03-rear.jpg");
  assertEquals(SHOT_FILE[m.left], "04-left.jpg");
});

Deno.test("fewer than four shots is refused", () => {
  assertThrows(() => mapShotsToViews(["front", "right", "rear"]), Error, "missing left");
  assertThrows(() => mapShotsToViews([]), Error);
  assertThrows(() => mapShotsToViews(["front", "front", "rear", "left"]), Error, "duplicate");
  assertThrows(() => mapShotsToViews(["front", "back", "rear", "left"]), Error, "unknown shot id");
});

Deno.test("handle normalisation matches register-scan / newScanId", () => {
  assertEquals(normaliseHandle("Enablewhore"), "enablewhore");
  assertEquals(normaliseHandle("Jeff"), "jeff");
  assertEquals(normaliseHandle("Say Phin!"), "say-phin");
  assertEquals(normaliseHandle(null), "anon");
  assertEquals(normaliseHandle("---"), "anon");
});

Deno.test("the real enablewhore manifest parses and yields handle=enablewhore", () => {
  const r = parseManifest(ENABLEWHORE_MANIFEST, "enablewhore-20260901-185736");
  if (!r.ok) throw new Error(r.reason);
  assertEquals(r.handle, "enablewhore");
  assertEquals(r.manifest.shots, ["front", "right", "rear", "left"]);
  assertEquals(r.manifest.paint, null);
});

Deno.test("the jeff-shaped manifest (with paint + vehicleClass) parses too", () => {
  const jeff = JSON.stringify({
    handle: "Jeff",
    platform: "ios",
    car: { year: "2025", make: "Toyota", model: "GR Corolla", color: "Heavy Metal", vehicleClass: "hatchback" },
    paint: { name: "Heavy Metal", hex: "#6B6E72", source: "factory", group: null },
    capturedAt: "2026-08-29T21:15:52.655Z",
    scanId: "jeff-20260829-141551",
    uploaded: 4,
    failed: [],
    shots: ["front", "right", "rear", "left"],
  });
  const r = parseManifest(jeff, "jeff-20260829-141551");
  if (!r.ok) throw new Error(r.reason);
  assertEquals(r.handle, "jeff");
});

Deno.test("manifest rejections are specific and never spend", () => {
  const base = JSON.parse(ENABLEWHORE_MANIFEST);
  const id = "enablewhore-20260901-185736";
  const bad = (patch: Record<string, unknown>) => parseManifest(JSON.stringify({ ...base, ...patch }), id);
  assertEquals(bad({ uploaded: 3 }), { ok: false, reason: "manifest-uploaded-3" });
  assertEquals(bad({ failed: ["Rear"] }), { ok: false, reason: "manifest-failed-shots" });
  assertEquals(bad({ shots: ["front", "right", "rear"] }), { ok: false, reason: "manifest-missing-left" });
  assertEquals(bad({ scanId: "someone-else" }), { ok: false, reason: "manifest-scanid-mismatch" });
  assertEquals(parseManifest("{not json", id), { ok: false, reason: "manifest-unparseable" });
});

Deno.test("junk folders are recognised", () => {
  assertEquals(isJunkScanId("_selftest"), true);
  assertEquals(isJunkScanId("claudetest-20260821-000001"), true);
  assertEquals(isJunkScanId("../etc"), true);
  assertEquals(isJunkScanId("enablewhore-20260901-185736"), false);
  assertEquals(isJunkScanId("jeff-20260829-141551"), false);
});

Deno.test("folder check needs four real-sized photos and the manifest", () => {
  const full = [
    { name: "01-front.jpg", size: 468700 },
    { name: "02-right.jpg", size: 790526 },
    { name: "03-rear.jpg", size: 835831 },
    { name: "04-left.jpg", size: 640865 },
    { name: "manifest.json", size: 376 },
  ];
  assertEquals(checkFolder(full).complete, true);
  const noRear = full.filter((e) => e.name !== "03-rear.jpg");
  assertEquals(checkFolder(noRear), { complete: false, missing: ["03-rear.jpg"], small: [], hasManifest: true });
  const probe = [{ name: "01-front.jpg", size: 340 }];
  const c = checkFolder(probe);
  assertEquals(c.complete, false);
  assertEquals(c.small, ["01-front.jpg:340"]);
});
