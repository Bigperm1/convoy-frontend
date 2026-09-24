// class_car_sprite_test.mts — a Silver class car is drawn as its CLASS on CarPlay / Android Auto, at the GRC sprite's size.
//
// Jeff, driving, 2026-09-23: "when I'm on the silver tier and I select, say, the exotic car, it's showing my GR Corolla
// as the avatar or car marker when it's supposed to be the exotic car." CarMapView registered the driver's flat car as
// the GR Corolla photo by paint for EVERY marker, and the class was never mirrored to the car store.
//   S1 every class with top-down art has a car-surface sprite at 44/88/132 px (the GRC photos' sizes — the nav-locked
//      sprite scale, vehiclePngScale, is tuned for exactly those), square, with the car's length filling the height
//   S2 carStore mirrors the class (selfClass ← getVehicleClass)
//   S3 CarMapView draws CLASS_TOPDOWN_CAR[class] for a 'class' marker, the GRC photo otherwise
// Jeff, 2026-09-23, "2 - car color on both" / "3 - ok" / "change the 2d button to 3d … it says upgrade to gold":
//   S4 carStore mirrors the class PAINT (selfClassPri / selfClassSec ← getClassPaint) as two strings
//   S5 CarMapView registers a painted snapshot keyed by class + paint, beside (never instead of) the static class art,
//      with the phone's onReady refresh + iOS remount, and bounded receipts (mount / ready per gen / show)
//   S6 the snapshot's geometry equals CLASS_TOPDOWN_CAR's: the art's ink MEASURED here from the classes-v2 PNGs (rows
//      12..500 of 512, centred) against the 46.16 pt sprite / 1.08 pt inset / 44 pt clip written in CarMapView
//   S7 SelfCarModel draws the painted image ONLY once it is ready (selfSpriteImg; the static class art until then —
//      SelfCarModel has no fallback of its own), spriteSize × uiScale
//   R  (review, 2026-09-23) CarClassPaintImage EVALUATED — the real component source, transpiled, run under a tiny hooks
//      shim with fake timers: onPainted fires once, 350 ms after the LAST onReady (Android: the first; iOS: after the
//      two remounts), never before, never without an onReady, never after an unmount; the receipts stay bounded
//   S8 the car view button: a 2D-locked car (isMapView2DLocked) is answered "Upgrade to Gold for 3D" before any view
//      change — short enough for Android Auto's one-line pill — and the button wears the 3D glyph on CarPlay and AA
// ⚠ S4-S8 are SOURCE GUARDS (they pin the wiring against a silent revert) and R runs JS logic under stubs — neither is
//   runtime proof on a head unit: whether the snapshot registers and paints there is what the car-class-paint receipts
//   (op=mount / op=ready gen= final= / op=show) answer on a real drive.
// Run: node --experimental-strip-types tools/sim-qc/class_car_sprite_test.mts

import { readFileSync, existsSync } from "node:fs";
import { inflateSync } from "node:zlib";
import ts from "typescript";

let failed = 0;
const ok = (name: string, cond: boolean, detail = "") => {
  console.log(`  ${cond ? "ok  " : "FAIL"} ${name}${detail ? `  (${detail})` : ""}`);
  if (!cond) failed++;
};
const root = new URL("../../", import.meta.url);
const read = (p: string) => readFileSync(new URL(p, root), "utf8");
const pngSize = (p: string): [number, number] | null => {
  const u = new URL(p, root);
  if (!existsSync(u)) return null;
  const b = readFileSync(u);
  return [b.readUInt32BE(16), b.readUInt32BE(20)];
};

const va = read("src/vehicleAssets.ts");
const block = (name: string) => /* keys of an object literal export */ {
  const m = new RegExp(`export const ${name}[^{]*\\{([\\s\\S]*?)\\n\\};`).exec(va);
  return m ? [...m[1].matchAll(/^\s*(\w+):\s*require\("([^"]+)"\)/gm)].map((x) => ({ key: x[1], path: x[2].replace("../", "") })) : [];
};
const classes = block("CLASS_TOPDOWN");
const car = block("CLASS_TOPDOWN_CAR");
ok("S0 read both class tables", classes.length >= 10 && car.length > 0, `${classes.length} / ${car.length}`);
const missing = classes.filter((c) => !car.some((k) => k.key === c.key)).map((c) => c.key);
ok("S1 every class has a car-surface sprite", missing.length === 0, missing.join(","));
const bad: string[] = [];
for (const c of car) {
  for (const [suf, px] of [["", 44], ["@2x", 88], ["@3x", 132]] as const) {
    const sz = pngSize(c.path.replace(/\.png$/, `${suf}.png`));
    if (!sz || sz[0] !== px || sz[1] !== px) bad.push(`${c.key}${suf}=${sz ? sz.join("x") : "missing"}`);
  }
}
ok("S1b 44 / 88 / 132 px squares, like the GRC photos", bad.length === 0, bad.join(" "));

const store = read("src/carplay/carStore.ts");
ok("S2 carStore mirrors the class", /selfClass:\s*getVehicleClass\(s\)/.test(store) && /selfClass\?:\s*string/.test(store));

const cmv = read("src/carplay/CarMapView.tsx");
ok("S3 CarMapView: a 'class' marker draws CLASS_TOPDOWN_CAR[class]",
  /s\.selfMarkerType === 'class' \? \(CLASS_TOPDOWN_CAR as any\)\[selfClassKey\]/.test(cmv)
  && /\[carFlatImg\]: selfClassCarArt \?\? getVehiclePngOrDefault\(s\.selfCarColor\)/.test(cmv));

// ── S4 paint mirrored ────────────────────────────────────────────────────────────────────────────────────────────
ok("S4 carStore mirrors the class paint as two strings",
  /const classPaint = getClassPaint\(s\)/.test(store)
  && /selfClassPri:\s*classPaint\.primary \|\| undefined/.test(store)
  && /selfClassSec:\s*classPaint\.secondary \|\| undefined/.test(store)
  && /selfClassPri\?:\s*string/.test(store) && /selfClassSec\?:\s*string/.test(store));

// ── S5 painted image, keyed by class + paint ─────────────────────────────────────────────────────────────────────
ok("S5 painted image name carries class + both paints",
  /`self_car_cls_paint_\$\{selfClassKey\}_\$\{paintHex\(s\.selfClassPri\)\}_\$\{paintHex\(s\.selfClassSec\)\}`/.test(cmv)
  // 2026-09-24: NOT gated on the marker (selfClassCarArt) any more — the snapshot lives across marker changes so a
  // re-selected class car is painted at once (Jeff's white flash). The name still carries class + both paints.
  && /selfClassPaintImg = CLASS_TOPDOWN\[selfClassKey\] && \(s\.selfClassPri \|\| s\.selfClassSec\)/.test(cmv)
  && !/selfClassPaintImg = selfClassCarArt &&/.test(cmv));
ok("S5b mounted beside the static art, keyed by name + epoch (a change of painted image is a fresh snapshot)",
  /<Mapbox\.Images images=\{allMapImages\} \/>\s*\{\/\*[\s\S]*?\*\/\}\s*\{selfClassPaintImg \? \(\s*<CarClassPaintImage\s+key=\{`\$\{selfClassPaintImg\}#\$\{paintEpoch\}`\}/.test(cmv));
const comp = /function CarClassPaintImage[\s\S]*?\n\}\n/.exec(cmv)?.[0] ?? "";
ok("S5c the phone's snapshot mechanism: ClassSprite in a Mapbox.Image, refresh on onReady, iOS remount ≤2 by key",
  /<Mapbox\.Images key=\{`\$\{name\}_g\$\{gen\}`\}>/.test(comp)
  && /<Mapbox\.Image name=\{name\} ref=\{imgRef\}>/.test(comp)
  && /<ClassSprite vehicleClass=\{vehicleClass\} primary=\{primary\} secondary=\{secondary\} size=\{art\} onReady=\{onReady\} \/>/.test(comp)
  && /imgRef\.current\?\.refresh\?\.\(\)/.test(comp)
  && /Platform\.OS === 'ios' && remountsRef\.current < 2/.test(comp)
  && (comp.match(/<View collapsable=\{false\}/g) ?? []).length === 2);
ok("S5d bounded receipts: mount per paint key, ready per paint key AND gen, show per paint key; capped at 40",
  /carPaintReceiptsSent\.has\(key\) \|\| carPaintReceiptsSent\.size >= 40/.test(cmv)
  && /carPaintReceipt\('mount:' \+ name,/.test(comp) && /carPaintReceipt\(`ready:\$\{name\}:\$\{gen\}`,/.test(comp)
  && /carPaintReceipt\('show:' \+ name,/.test(comp)
  && (cmv.match(/car-class-paint op=/g) ?? []).length === 3);

// ── S6 geometry: measure the art's ink, compare with the numbers in CarMapView ──────────────────────────────────────
// Minimal PNG reader: 8-bit RGBA, non-interlaced (what classes-v2 is; anything else FAILS rather than guessing).
const alphaBBox = (p: string): { w: number; h: number; box: [number, number, number, number] } | string => {
  const b = readFileSync(new URL(p, root));
  let o = 8, w = 0, h = 0; const idat: Buffer[] = [];
  while (o < b.length) {
    const len = b.readUInt32BE(o), type = b.toString("latin1", o + 4, o + 8), d = b.subarray(o + 8, o + 8 + len);
    if (type === "IHDR") { w = d.readUInt32BE(0); h = d.readUInt32BE(4); if (d[8] !== 8 || d[9] !== 6 || d[12] !== 0) return `not 8-bit RGBA non-interlaced`; }
    else if (type === "IDAT") idat.push(d);
    else if (type === "IEND") break;
    o += 12 + len;
  }
  const raw = inflateSync(Buffer.concat(idat)); const stride = w * 4; const px = Buffer.alloc(h * stride);
  for (let y = 0; y < h; y++) {
    const f = raw[y * (stride + 1)], src = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    for (let x = 0; x < stride; x++) {
      const a = x >= 4 ? px[y * stride + x - 4] : 0, up = y > 0 ? px[(y - 1) * stride + x] : 0, c = x >= 4 && y > 0 ? px[(y - 1) * stride + x - 4] : 0;
      const pr = () => { const p0 = a + up - c, pa = Math.abs(p0 - a), pb = Math.abs(p0 - up), pc = Math.abs(p0 - c); return pa <= pb && pa <= pc ? a : pb <= pc ? up : c; };
      px[y * stride + x] = (src[x] + (f === 0 ? 0 : f === 1 ? a : f === 2 ? up : f === 3 ? (a + up) >> 1 : pr())) & 255;
    }
  }
  let x0 = w, y0 = h, x1 = -1, y1 = -1;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (px[y * stride + x * 4 + 3]) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
  return { w, h, box: [x0, y0, x1 + 1, y1 + 1] };   // PIL getbbox convention (exclusive right / bottom)
};
const inkBad: string[] = [];
for (const c of classes) {
  const r = alphaBBox(c.path);
  if (typeof r === "string") { inkBad.push(`${c.key}: ${r}`); continue; }
  const [x0, y0, x1, y1] = r.box;
  // the numbers CarMapView bakes in: 512 px art, ink rows 12..500, centred (x within half a pixel of 256)
  if (r.w !== 512 || r.h !== 512 || y0 !== 12 || y1 !== 500 || Math.abs((x0 + x1) / 2 - 256) > 0.5) inkBad.push(`${c.key}: ${r.w}x${r.h} ink ${r.box.join(",")}`);
}
ok("S6 every class's art: 512 px, ink rows 12..500, centred (measured)", classes.length >= 10 && inkBad.length === 0, inkBad.join(" | "));
ok("S6b the snapshot draws that ink 44 pt long in a 44 pt clip (the CLASS_TOPDOWN_CAR box)",
  /const box = 44;/.test(comp) && /const art = \(box \* 512\) \/ 488;/.test(comp) && /const inset = \(art \* 12\) \/ 512;/.test(comp)
  && /style=\{\{ width: box, height: box, overflow: 'hidden' \}\}/.test(comp)
  && /style=\{\{ position: 'absolute', left: -inset, top: -inset, width: art, height: art \}\}/.test(comp));
{
  const box = 44, art = (box * 512) / 488, inset = (art * 12) / 512;
  const inkTop = (12 / 512) * art - inset, inkBottom = (500 / 512) * art - inset, inkCx = (256 / 512) * art - inset;
  ok("S6c arithmetic: ink spans 0..44 pt and is centred at 22 pt; 44 is a multiple of 4 (iOS canvas rounding)",
    Math.abs(inkTop) < 1e-9 && Math.abs(inkBottom - box) < 1e-9 && Math.abs(inkCx - box / 2) < 1e-9 && box % 4 === 0,
    `art=${art.toFixed(3)} inset=${inset.toFixed(3)} ink ${inkTop.toFixed(3)}..${inkBottom.toFixed(3)} cx=${inkCx.toFixed(3)}`);
}

// ── S7 the self car: the paint only once READY, the static class art until then; × uiScale ─────────────────────────
// SelfCarModel's iconImage is the bare `sprite` (ConvoyMapbox, inside the lock mbx-selfcar-source-layers — not approved
// for this change), so there is NO layer-side fallback: a spriteFallback prop would be dead, and a sprite pointing at a
// snapshot registered from a not-yet-loaded view is an invisible car (review, 2026-09-23).
const selfCarRegion = /NAV-LOCK begin car-jsx-selfcar-model[\s\S]*?NAV-LOCK end car-jsx-selfcar-model/.exec(cmv)?.[0] ?? "";
ok("S7 SelfCarModel's sprite is selfSpriteImg; no spriteFallback prop anywhere in CarMapView's code",
  /sprite=\{carFlat \? selfSpriteImg : undefined\}/.test(selfCarRegion) && !/spriteFallback=/.test(cmv));
const gateLine = /const selfSpriteImg = ([^;]+);/.exec(cmv)?.[1] ?? "";
const epochBlock = /const paintEpochRef = [\s\S]*?const paintEpoch = paintEpochRef\.current\.epoch;/.exec(cmv)?.[0] ?? "";
ok("S7a the gate: component state { img, epoch } set by THAT mount's onPainted",
  /const \[carPaintShown, setCarPaintShown\] = useState<\{ img: string; epoch: number \} \| null>\(null\);/.test(cmv)
  && /<CarClassPaintImage[\s\S]*?onPainted=\{\(img\) => setCarPaintShown\(\{ img, epoch: paintEpoch \}\)\}[\s\S]*?\/>/.test(cmv)
  && gateLine !== "" && epochBlock !== "");
{
  // EVALUATE the gate expression over its inputs.
  // A render loop over the REAL epoch derivation + gate: each step is one render of CarMapView with a painted image
  // (or none); "ready" = the mounted snapshot (keyed name#epoch) called onPainted.
  const run = new Function("steps", `
    const useRef = (v) => ({ current: v });
    const paintEpochRef = useRef(undefined);
    let first = true, carPaintShown = null; const carFlatImg = "F"; const out = [];
    for (const st of steps) {
      const selfClassPaintImg = st.img;
      if (first) { paintEpochRef.current = { img: selfClassPaintImg, epoch: 0 }; first = false; }
      ${epochBlock.replace(/^const paintEpochRef = useRef<[\s\S]*?\}\);/, "")}
      if (st.ready) carPaintShown = { img: selfClassPaintImg, epoch: paintEpoch };   // THIS mount's onPainted
      const selfSpriteImg = ${gateLine};
      out.push(selfSpriteImg);
    }
    return out;`) as (steps: { img?: string; ready?: boolean }[]) => string[];
  const A = "A", B = "B";
  const cases: [string, { img?: string; ready?: boolean }[], string[]][] = [
    ["no paint", [{}], ["F"]],
    ["painted, not ready → static", [{ img: A }], ["F"]],
    ["painted, ready → paint", [{ img: A }, { img: A, ready: true }], ["F", A]],
    ["A ready → B not ready → static", [{ img: A, ready: true }, { img: B }], [A, "F"]],
    ["A ready → unpainted → A again: static until the NEW mount is ready (Codex 05e2bd44)", [{ img: A, ready: true }, {}, { img: A }, { img: A, ready: true }], [A, "F", "F", A]],
    ["rapid A → B → A before B ready: static", [{ img: A, ready: true }, { img: B }, { img: A }], [A, "F", "F"]],
    ["re-render with the same paint keeps it", [{ img: A, ready: true }, { img: A }, { img: A }], [A, A, A]],
  ];
  const bad: string[] = [];
  for (const [label, steps, want] of cases) {
    let got: string[] = [];
    try { got = run(steps); } catch (e) { got = [String(e)]; }
    if (got.join(",") !== want.join(",")) bad.push(`${label}: ${got.join(",")} ≠ ${want.join(",")}`);
  }
  ok("S7c the gate, evaluated over render sequences: static art unless THIS mount's snapshot reported ready", gateLine !== "" && bad.length === 0, bad.join(" | "));
}
ok("S7b spriteSize × uiScale (1 on CarPlay: hudScaleFor returns 1 off Android)",
  // × 0.9 since 2026-09-24 (Jeff: "make that car just a tad smaller") — the phone's class sprite carries the same factor.
  /spriteSize=\{carFlat \? vehiclePngScale\(s\.selfCarColor\) \* uiScale \* 0\.9 : 1\}/.test(cmv)
  && /if \(Platform\.OS !== 'android' \|\| !\(w > 0\) \|\| !\(h > 0\)\) return 1;/.test(cmv));

// ── R CarClassPaintImage, EVALUATED ─────────────────────────────────────────────────────────────────────────────────
// The REAL source — `const carPaintReceiptsSent` through the end of CarClassPaintImage — transpiled by typescript and run
// under a minimal hooks shim (useRef / useState / useEffect by call order), a createElement that returns plain objects,
// fake timers and a fake clock. The test plays the native side: it attaches the Image ref, and calls ClassSprite's
// onReady when "the bitmaps load" (once per mounted gen). What it proves: the JS sequencing. What it cannot: that the
// snapshot on a head unit actually contains the paint.
{
  const a = cmv.indexOf("const carPaintReceiptsSent");
  const b = cmv.indexOf("\n}\n", cmv.indexOf("function CarClassPaintImage")) + 3;
  const src = a > 0 && b > a ? cmv.slice(a, b) : "";
  ok("R0 found the component source", src.includes("function CarClassPaintImage") && src.includes("onPainted"));
  const out = ts.transpileModule(src, { compilerOptions: { jsx: ts.JsxEmit.React, target: ts.ScriptTarget.ES2020 } }).outputText;
  type El = { type: any; props: any };
  const run = (os: "ios" | "android") => {
    let clock = 0, seq = 0;
    let timers: { at: number; id: number; fn: () => void }[] = [];
    const logs: string[] = [], painted: [string, number][] = [];
    let refreshes = 0;
    const slots: any[] = []; let idx = 0; let dirty = false; let pending: (() => void)[] = [];
    const useRef = (v: any) => { const i = idx++; if (!(i in slots)) slots[i] = { current: v }; return slots[i]; };
    const useState = (v: any) => {
      const i = idx++; if (!(i in slots)) slots[i] = { v };
      const cell = slots[i];
      return [cell.v, (n: any) => { cell.v = typeof n === "function" ? n(cell.v) : n; dirty = true; }];
    };
    const useEffect = (fn: () => any, deps?: any[]) => {
      const i = idx++; const prev = slots[i];
      if (!prev || !deps || deps.some((d, k) => d !== prev.deps[k])) pending.push(() => { prev?.cleanup?.(); slots[i] = { deps, cleanup: fn() }; });
    };
    const React = { createElement: (type: any, props: any, ...children: any[]) => ({ type, props: { ...(props || {}), children } }) };
    const ClassSprite = function ClassSprite() { return null; };
    const Mapbox = { Images: "Images", Image: "Image" };
    const Comp = new Function("React", "useRef", "useState", "useEffect", "Platform", "logEvent", "Mapbox", "View", "ClassSprite",
      "setTimeout", "clearTimeout", "Date", `${out}\nreturn CarClassPaintImage;`)(
      React, useRef, useState, useEffect, { OS: os }, (m: string) => { logs.push(m); }, Mapbox, "View", ClassSprite,
      (fn: () => void, ms: number) => { const id = ++seq; timers.push({ at: clock + ms, id, fn }); return id; },
      (id: number) => { timers = timers.filter((t) => t.id !== id); },
      { now: () => clock },
    );
    const props = { name: "self_car_cls_paint_exotic_FF3B30_x", vehicleClass: "exotic", primary: "#FF3B30", onPainted: (n: string) => painted.push([n, clock]) };
    let tree: El = null as any; let lastKey = "";
    let mounts = 0;
    const find = (e: any, t: any): El | null => {
      if (!e || typeof e !== "object") return null;
      if (e.type === t) return e;
      for (const c of [].concat(e.props?.children ?? [])) { const f = find(c, t); if (f) return f; }
      return null;
    };
    const render = () => {
      idx = 0; pending = []; dirty = false;
      tree = Comp(props);
      pending.forEach((f) => f());
      const key = tree.props.key;
      if (key !== lastKey) { lastKey = key; mounts++; const img = find(tree, "Image"); if (img?.props.ref) img.props.ref.current = { refresh: () => { refreshes++; } }; }
    };
    const unmount = () => { slots.forEach((c) => c?.cleanup?.()); };
    const advance = (to: number) => {
      for (;;) {
        timers.sort((x, y) => x.at - y.at || x.id - y.id);
        const t = timers[0];
        if (!t || t.at > to) break;
        timers.shift(); clock = t.at; t.fn();
        if (dirty) render();
      }
      clock = to;
    };
    const ready = () => { const cs = find(tree, ClassSprite); cs?.props.onReady?.(); if (dirty) render(); };
    return { render, unmount, advance, ready, logs, painted, get refreshes() { return refreshes; }, get mounts() { return mounts; }, get key() { return lastKey; } };
  };
  const NAME = "self_car_cls_paint_exotic_FF3B30_x";
  // Android: one capture, no remount; painted 350 ms after onReady.
  {
    const h = run("android"); h.render(); h.advance(40); h.ready();
    h.advance(389);
    const early = h.painted.length;
    h.advance(10_000);
    ok("R1 Android: onPainted once, 350 ms after the (only) onReady, never before; no remount",
      early === 0 && h.painted.length === 1 && h.painted[0][0] === NAME && h.painted[0][1] === 390 && h.mounts === 1 && h.refreshes === 2,
      JSON.stringify({ early, painted: h.painted, mounts: h.mounts, refreshes: h.refreshes }));
    ok("R1b Android receipts: mount, ready gen=0 final=1, show — three rows",
      h.logs.length === 3 && /op=mount/.test(h.logs[0]) && /op=ready .* gen=0 final=1/.test(h.logs[1]) && /op=show .* gen=0/.test(h.logs[2]), h.logs.join(" | "));
  }
  // iOS: the phone's dance — onReady, remount at +300, onReady, remount at +1200, onReady → painted 350 ms later.
  {
    const h = run("ios"); h.render();
    h.advance(50); h.ready();                  // gen 0 bitmaps load
    h.advance(1_000);                          // remount 1 at 350, its bitmaps …
    const k1 = h.key, before1 = h.painted.length;
    h.ready();                                 // … load at 1000
    h.advance(3_000);                          // remount 2 at 2200
    const k2 = h.key, before2 = h.painted.length;
    h.ready();                                 // gen 2 bitmaps load at 3000
    h.advance(3_349);
    const early = h.painted.length;
    h.advance(20_000);
    // (2026-09-24: an early show after the SECOND onReady was tried for Jeff's white flash and withdrawn — Codex: the
    // gen-2 remount re-registers the same name from a mount-time capture that can be blank. The last-capture gate stays.)
    ok("R2 iOS: two remounts, then onPainted once, 350 ms after the THIRD onReady — never on the first two",
      k1.endsWith("_g1") && k2.endsWith("_g2") && before1 === 0 && before2 === 0 && early === 0
      && h.painted.length === 1 && h.painted[0][1] === 3_350 && h.mounts === 3,
      JSON.stringify({ k1, k2, painted: h.painted, mounts: h.mounts }));
    ok("R2b iOS receipts: mount, ready gen=0/1 final=0, ready gen=2 final=1, show — five rows",
      h.logs.length === 5 && /gen=0 final=0/.test(h.logs[1]) && /gen=1 final=0/.test(h.logs[2]) && /gen=2 final=1/.test(h.logs[3]) && /op=show/.test(h.logs[4]),
      h.logs.join(" | "));
  }
  // Never ready (the head unit never loads the bitmaps / never runs the snapshot): never painted.
  {
    const h = run("ios"); h.render(); h.advance(60_000);
    const g = run("android"); g.render(); g.advance(60_000);
    ok("R3 no onReady → onPainted never fires (the car stays the static class art)", h.painted.length === 0 && g.painted.length === 0);
  }
  // Unmounted (paint changed, map remounted) between onReady and the show: nothing fires on the dead instance.
  {
    const h = run("android"); h.render(); h.ready(); h.advance(100); h.unmount(); h.advance(60_000);
    ok("R4 unmount before the show → onPainted never fires (timers cleared)", h.painted.length === 0);
  }
}

// ── S8 the car view button teases 3D for a 2D-locked car ────────────────────────────────────────────────────────────
const act = read("src/carplay/carActions.ts");
const view = /NAV-LOCK begin act-view-2d-when-idle[\s\S]*?NAV-LOCK end act-view-2d-when-idle/.exec(act)?.[0] ?? "";
const lockAt = view.indexOf("if (isMapView2DLocked()) {");
const TEASE = "Upgrade to Gold for 3D";
const goldAt = view.indexOf(`toast('${TEASE}');`);
const firstChange = Math.min(...["setMapView2D(", "toggleMapView2D("].map((k) => { const i = view.indexOf(k); return i < 0 ? Infinity : i; }));
ok(`S8 a 2D-locked tap answers '${TEASE}' and returns before any view change`,
  lockAt > 0 && goldAt > lockAt && /toast\('Upgrade to Gold for 3D'\);\s*return;/.test(view) && goldAt < firstChange);
// AA's status pill is ONE line (ConvoyCarPlay scoutPillText numberOfLines={1}, fontSize 14 bold) on a 213 dp head unit:
// 213 − 2×16 padding − 2×1 border − 16 icon − 8 gap = 155 dp of text. Roboto Bold's unhinted advance widths at 14 pt
// (measured with PIL at 1400 px / 100, 2026-09-23): the tease 143.9 dp; the first wording 251.8 dp. Pinned as a
// character budget (the tease is 22 characters; everything ≤ 24 measured under 155 dp here) — a guard, not a render.
ok("S8a the tease fits the AA pill's one line (≤ 24 characters — 143.9 dp measured against 155 dp)", TEASE.length <= 24, `${TEASE.length} chars`);
ok("S8b the button wears the 3D glyph for a 2D-locked car (CarPlay map button + AA strip)",
  /const viewGlyph = isMapView2DLocked\(\) \? 'view3d' : 'view2d';/.test(act)
  && /id: 'car-view', image: carIcon\(viewGlyph, s\), focusedImage: carIcon\(viewGlyph, s\)/.test(act)
  && /a\.id === 'car-view' \? \{ id: a\.id, icon: CAR_ICON_VIEW_3D, visibility: AA_PERSISTENT \}/.test(act));

console.log(failed ? `\nFAIL class_car_sprite (${failed})` : "\nPASS class_car_sprite");
process.exit(failed ? 1 : 0);
