// class_nav_and_3d_tease_test.mts — two phone rules from Jeff, 2026-09-23.
//
//   K  "1- yes" to "While you're navigating, the phone still shows a Silver class car as the green arrow, not the
//      exotic … Want the exotic on the phone during drives too?" A CLASS driver keeps the flat class sprite in every
//      nav state (the map is held 2D for a class car, so the flat sprite reads right the whole drive); an ARROW
//      driver is the arrow. Checked by EVALUATING the real mbx-self-marker-kind-nav region of src/ConvoyMapbox.tsx
//      over every marker × nav state — the truth table, not a regex — plus the two JSX consumers that turn
//      selfIsClass into the sprite.
//   T  "on the free/silver 2d maps can we change the 2d button to 3d to entice the free silver users to see 3d and
//      when they tap it it says upgrade to gold?" The phone's 2D/3D FAB shows during turn-by-turn for EVERYONE (the
//      locked gate is gone), and its onPress — the real handler text from app/(app)/map.tsx, evaluated with stubs —
//      shows a Gold toast and does NOT toggle while the view is locked, and toggles as before otherwise. The toast is
//      the SAME sentence CarPlay / AA show (T8), and during guidance it sits on the FAB stack's base (T9).
//
// ⚠ A SOURCE CHECK IS A GUARD, NOT PROOF OF RUNTIME. It pins the rule in the code; it cannot see the sprite drawn on
//   a device, the toast's position over the step bar, or the FAB art. Those need the sim / a drive.
// Run: node --experimental-strip-types tools/sim-qc/class_nav_and_3d_tease_test.mts

import { readFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";

let failed = 0;
const ok = (name: string, cond: boolean, detail = "") => {
  console.log(`  ${cond ? "ok  " : "FAIL"} ${name}${detail ? `  (${detail})` : ""}`);
  if (!cond) failed++;
};
const root = new URL("../../", import.meta.url);
const read = (p: string) => readFileSync(new URL(p, root), "utf8");
// Same comment stripper spirit as nav_lock_test (line comments outside strings, block comments).
const noComments = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, " ").split("\n").map((l) => {
  let out = ""; let inS: string | null = null;
  for (let i = 0; i < l.length; i++) {
    const c = l[i];
    if (inS) { out += c; if (c === "\\") { out += l[i + 1] ?? ""; i++; } else if (c === inS) inS = null; continue; }
    if (c === "'" || c === '"' || c === "`") { inS = c; out += c; continue; }
    if (c === "/" && l[i + 1] === "/") break;
    out += c;
  }
  return out;
}).join("\n");
const region = (src: string, id: string): string | null => {
  const lines = src.split("\n");
  const b = lines.findIndex((l) => new RegExp(`NAV-LOCK begin ${id}\\b`).test(l));
  const e = lines.findIndex((l) => new RegExp(`NAV-LOCK end ${id}\\b`).test(l));
  return b >= 0 && e > b ? lines.slice(b + 1, e).join("\n") : null;
};

// ── K: the self-marker kind ─────────────────────────────────────────────────────────────────────────────────────
const mbx = read("src/ConvoyMapbox.tsx");
const kindSrc = region(mbx, "mbx-self-marker-kind-nav");
ok("K0 found the mbx-self-marker-kind-nav region", !!kindSrc);
let kind: ((m: string, nav: boolean) => { selfIsArrow: boolean; selfIsClass: boolean }) | null = null;
try {
  const body = stripTypeScriptTypes(noComments(kindSrc ?? ""));
  kind = new Function("selfMarkerType", "navigationActive", `${body}\nreturn { selfIsArrow, selfIsClass };`) as any;
} catch (e) {
  ok("K0b the region evaluates on its own", false, String((e as any)?.message ?? e));
}
if (kind) {
  const wrong: string[] = [];
  for (const m of ["car", "arrow", "class", "photo"]) {
    for (const nav of [false, true]) {
      const r = kind(m, nav);
      if (r.selfIsArrow !== (m === "arrow")) wrong.push(`${m}/nav=${nav}: selfIsArrow=${r.selfIsArrow}`);
      if (r.selfIsClass !== (m === "class")) wrong.push(`${m}/nav=${nav}: selfIsClass=${r.selfIsClass}`);
    }
  }
  ok("K1 class ⇒ sprite (selfIsClass) and never the arrow, in ANY nav state; arrow ⇒ arrow; car/photo ⇒ neither", wrong.length === 0, wrong.join("; "));
}
const mbxCode = noComments(mbx);
ok("K2 the self marker is handed the class sprite whenever selfIsClass", /sprite=\{selfIsClass \? selfClassImg : undefined\}/.test(mbxCode));
ok("K3 the class image registration is gated on selfIsClass alone (stays mounted through a drive)", /\{selfIsClass && \(selfClassAsShot \? \(/.test(mbxCode));

// ── T: the 2D/3D FAB's Gold tease ───────────────────────────────────────────────────────────────────────────────
const map = read("app/(app)/map.tsx");
const mapCode = noComments(map);
const fabAt = mapCode.indexOf('testID="view-2d-3d-fab"');
ok("T0 found the view-2d-3d-fab", fabAt > 0);
// The gate is the last `{navMode === … && (` before the FAB's <PressableScale.
const pressAt = mapCode.lastIndexOf("<PressableScale", fabAt);
const gateAt = mapCode.lastIndexOf("{navMode", pressAt);
const gate = gateAt >= 0 ? mapCode.slice(gateAt, pressAt).replace(/\s+/g, " ").trim() : "";
ok("T1 the FAB shows during turn-by-turn for everyone (no view2DLocked in its gate)", gate === '{navMode === "turn-by-turn" && (', gate);
const fabEnd = mapCode.indexOf("</PressableScale>", fabAt);
const fab = mapCode.slice(fabAt, fabEnd);
ok("T2 it still shows what you GET: \"3D\" art while the view is 2D (and a locked view IS 2D — map_view_lock_test V1/V2)", /source=\{view2D \? VIEW3D_ART\[t\] : VIEW2D_ART\[t\]\}/.test(fab));
// The onPress handler: from `onPress={` to its balanced closing brace.
const opAt = fab.indexOf("onPress={");
let handler = "";
if (opAt >= 0) {
  let d = 0, i = opAt + "onPress=".length, inS: string | null = null;
  for (; i < fab.length; i++) {
    const c = fab[i];
    if (inS) { if (c === "\\") i++; else if (c === inS) inS = null; continue; }
    if (c === "'" || c === '"' || c === "`") { inS = c; continue; }
    if (c === "{") d++;
    else if (c === "}") { d--; if (d === 0) break; }
  }
  handler = fab.slice(opAt + "onPress={".length, i);
}
ok("T3 found the FAB's onPress", handler.includes("=>"));
type Calls = { snap: number; toggle: number; toasts: string[] };
const run = (locked: boolean): Calls | null => {
  const calls: Calls = { snap: 0, toggle: 0, toasts: [] };
  try {
    const fn = new Function("haptics", "view2DLocked", "showInfoToast", "toggleMapView2D", `return (${stripTypeScriptTypes(handler)});`)(
      { snap: () => { calls.snap++; } },
      locked,
      (m: string) => { calls.toasts.push(m); },
      () => { calls.toggle++; return true; },
    );
    fn();
    return calls;
  } catch (e) {
    ok(`T4 the onPress evaluates (locked=${locked})`, false, String((e as any)?.message ?? e));
    return null;
  }
};
const L = run(true);
if (L) {
  // "locked" = a 2D car on the road (mapViewMode isMapView2DLocked is keyed to the CAR, not the paid tier).
  ok("T5 locked (a 2D car on the road): a Gold toast, a haptic, and NO toggle", L.toggle === 0 && L.snap === 1 && L.toasts.length === 1 && /Gold/.test(L.toasts[0]), JSON.stringify(L));
}
const U = run(false);
if (U) {
  ok("T6 unlocked (a 3D car on the road): toggles as before, no toast", U.toggle === 1 && U.snap === 1 && U.toasts.length === 0, JSON.stringify(U));
}
// T8 ONE sentence on every surface: the phone's locked-tap toast is WORD FOR WORD the CarPlay / AA toast in
// carActions' act-view-2d-when-idle region (carplay-must-match-phone). A copy change on one side fails here.
const carAct = read("src/carplay/carActions.ts");
const carRegion = noComments(region(carAct, "act-view-2d-when-idle") ?? "");
const carToast = carRegion.match(/if \(isMapView2DLocked\(\)\) \{\s*toast\((['"`])(.*?)\1\)/);
ok("T8 phone and car say the same sentence for the locked 3D tap", !!L && !!carToast && L.toasts[0] === carToast[2],
  `phone=${JSON.stringify(L?.toasts[0])} car=${JSON.stringify(carToast?.[2])}`);
// T9 during guidance the info toast rides the FAB stack's base (controlsBottom), not the stale previewBannerH.
ok("T9 InfoToast's bottom is controlsBottom while the step bar is up",
  /<InfoToast message=\{infoToast\} bottom=\{navBarUp \? controlsBottom : /.test(mapCode));
// Rules of hooks: the lock hook is a top-level call ABOVE the render's `return (` (map.tsx has early returns).
const hookAt = mapCode.indexOf("const view2DLocked = useMapView2DLocked();");
const renderAt = mapCode.indexOf("return (\n    <View style={styles.c}>");
ok("T7 useMapView2DLocked() is called above the render return", hookAt > 0 && renderAt > hookAt, `${hookAt} < ${renderAt}`);

console.log(failed ? `\nFAIL class_nav_and_3d_tease (${failed})` : "\nPASS class_nav_and_3d_tease");
process.exit(failed ? 1 : 0);
