// headunit_cam_harness — runs the PRODUCTION head-unit camera coordination code, not a copy of it (2026-09-25).
//
// The TypeScript compiler lifts these closures out of the real sources and evaluates them against shared ref objects,
// wired exactly like CarMapView's <SelfCarModel …> JSX:
//   src/carplay/CarMapView.tsx  — clampBias · zoomLog · zoomHoldRelease · carCamJob · getCam · applyZoomNow ·
//                                  applyZoomEased · the car gesture handler (subscribeCarGesture) · onCameraChanged ·
//                                  the render-time lockReadyRef line (🔒 car-cam-northup-lockready)
//   src/ConvoyMapbox.tsx        — SelfCarModel's pushCam · camGlidePending · step · bgTick · armNextFrame ·
//                                  cancelNextFrame · angDelta · the wake effect · the per-tick size (🔒 mbx-selfcar-pertick-size)
// The pure modules they import are the real ones. What is MODELLED here (and only this):
//   • a virtual clock: 60 Hz vsync (rAF + the CarPlay onCarFrame pump), the 33 ms bgTick interval, setTimeout;
//   • React: a setTick / selfRefresh marks SelfCarModel dirty → after the JS turn it "renders" (per-tick size) and runs
//     its wake effect; a CarMapView store tick (1 Hz) re-runs the lockReady line and renders SelfCarModel;
//   • the native camera: setCamera 'none' is an instant state set that does NOT cancel a running animation (iOS:
//     MapboxMap.setCamera(to:) — "does not cancel existing animations", MapboxMaps 11.25.0 source); a flyTo/easeTo with
//     a duration cancels the previous animation (camera.fly(to:) / ease(to:) cancel owner animations) and animates
//     from the CURRENT camera; android=true makes 'none' cancel too (rnmapbox Android sends it as flyToV11(duration 0));
//     onCameraChanged fires at vsync when the camera moved;
//   • a moving car: the harness plays the fix effect — every 1 s a pose ease (dur 1.1 s) toward a point 15 m ahead.
// Every identifier the lifted code reads must resolve; an unknown one fails the run (see `unresolved`).
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";

const ROOT = new URL("../../", import.meta.url);
const require = createRequire(new URL("package.json", ROOT));
const ts = require("typescript");

export type Src = { carMapView: string; convoyMapbox: string; mods: Record<string, any>; lock: any };
/** The working tree by default; `root` (a directory URL laid out like frontend/) replays another revision. */
export async function loadSrc(root: URL = ROOT): Promise<Src> {
  const rd = (p: string) => readFileSync(new URL(p, root), "utf8");
  const mods: Record<string, any> = {};
  for (const m of ["carZoomStep", "crewReturn", "returnFly", "camGlide", "framePacer", "overviewSize"]) Object.assign(mods, await import(new URL(`src/${m}.ts`, root).href));
  return { carMapView: rd("src/carplay/CarMapView.tsx"), convoyMapbox: rd("src/ConvoyMapbox.tsx"), mods, lock: JSON.parse(readFileSync(new URL("tools/sim-qc/data/nav-lock.json", ROOT), "utf8")) };
}

// ── lifting code out of a component ─────────────────────────────────────────────────────────────────────────────
function sfOf(src: string) { return ts.createSourceFile("x.tsx", src, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX); }
function inFn(sf: any, fnName: string, visit: (n: any) => void) {
  const walk = (n: any, inside: boolean) => {
    if (ts.isFunctionDeclaration(n) && n.name?.text === fnName) inside = true;
    if (inside) visit(n);
    ts.forEachChild(n, (c: any) => walk(c, inside));
  };
  walk(sf, false);
}
/** `const NAME = <init>` inside fnName; `useRef(X).current` → X. */
function liftVar(sf: any, fnName: string, name: string): string {
  let out: string | null = null;
  inFn(sf, fnName, (n) => {
    if (ts.isVariableDeclaration(n) && n.name?.getText?.(sf) === name && n.initializer) {
      if (out != null) throw new Error(`duplicate ${name}`);
      let init = n.initializer;
      if (ts.isPropertyAccessExpression(init) && init.name.text === "current" && ts.isCallExpression(init.expression) && init.expression.expression.getText(sf) === "useRef") init = init.expression.arguments[0];
      out = init.getText(sf);
    }
  });
  if (out == null) throw new Error(`not found: ${fnName}.${name}`);
  return out;
}
function liftCallArg(sf: any, fnName: string, callee: string, pick: (argText: string, nArgs: number) => boolean): string {
  const hits: string[] = [];
  inFn(sf, fnName, (n) => {
    if (ts.isCallExpression(n) && n.expression.getText(sf) === callee && n.arguments.length > 0) {
      const t = n.arguments[0].getText(sf);
      if (pick(t, n.arguments.length)) hits.push(t);
    }
  });
  if (hits.length !== 1) throw new Error(`${callee}(…) in ${fnName}: ${hits.length} matches`);
  return hits[0];
}
function liftJsxAttr(sf: any, fnName: string, attr: string): string {
  const hits: string[] = [];
  inFn(sf, fnName, (n) => { if (ts.isJsxAttribute(n) && n.name.getText(sf) === attr && n.initializer && ts.isJsxExpression(n.initializer)) hits.push(n.initializer.expression.getText(sf)); });
  if (hits.length !== 1) throw new Error(`jsx ${attr}: ${hits.length} matches`);
  return hits[0];
}
function region(src: string, id: string): string {
  const b = src.indexOf(`NAV-LOCK begin ${id} `), e = src.indexOf(`NAV-LOCK end ${id}`);
  if (b < 0 || e < 0) throw new Error(`region ${id}`);
  return src.slice(src.indexOf("\n", b) + 1, src.lastIndexOf("\n", e));
}
const js = (expr: string) => ts.transpileModule(`const __f = ${expr};`, { compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.ESNext }, fileName: "lift.ts" }).outputText.replace(/^export \{\};?$/m, "");
function bind(expr: string, scope: any) { return new Function("__scope", `with (__scope) { ${js(expr)} return __f; }`)(scope); }

function scopeProxy(s: Record<string, any>, unresolved: Set<string>) {
  return new Proxy(s, {
    has: (_t, k) => typeof k === "string" && k !== "__f",
    get: (t, k) => {
      if (k === Symbol.unscopables) return undefined;
      if (typeof k === "string" && k in t) return (t as any)[k];
      if (typeof k === "string" && k in globalThis) return (globalThis as any)[k];
      unresolved.add(String(k)); return undefined;
    },
    set: (t, k, v) => { (t as any)[k] = v; return true; },
  });
}
const ref = <T,>(v: T) => ({ current: v });

export type Opts = { android?: boolean; rafAlive?: boolean; carFramePump?: boolean; followZoom?: number; followPitch?: number;
  /** CarMapView render cadence (store ticks; 83 ms while navigating — the trim ticker). followZoom is a render value. */
  renderMs?: number };
export type Frame = { t: number; zoom: number; pitch: number; sizeZoom: number | null; animating: boolean };

export function makeHeadUnit(src: Src, o: Opts = {}) {
  const T0 = 1_000_000_000;
  let now = T0;
  const unresolved = new Set<string>();
  const M = src.mods;
  // ── locked constants, from the manifest (value-locked in the source) ──
  const val = (file: string, k: string, extra: Record<string, any> = {}): any => {
    const v = src.lock.files[file].locked[k];
    return new Function("S", `with (S) { return (${v}); }`)({ Platform: { OS: o.android ? "android" : "ios" }, ...extra });
  };
  const MB = "src/ConvoyMapbox.tsx", CM = "src/carplay/CarMapView.tsx";
  const CHASE_ZOOM_CLAMP_MIN = val(MB, "CHASE_ZOOM_CLAMP_MIN"), CHASE_ZOOM_CLAMP_MAX = val(MB, "CHASE_ZOOM_CLAMP_MAX");
  const cmConst = (k: string) => val(CM, k, { CHASE_ZOOM_CLAMP_MIN, CHASE_ZOOM_CLAMP_MAX });
  const log: string[] = [];
  const counts = { noteCam: 0, setNone: 0, setFly: 0, setEase: 0, renders: 0, camJob: 0 };
  // ── the native camera ──
  const cam = { zoom: o.followZoom ?? 16.8, pitch: 45, heading: 90, lat: 49.1, lng: -123.1 };
  let anim: null | { t0: number; dur: number; from: typeof cam; to: typeof cam; kind: string } = null;
  let camMoved = true;
  const setCamera = (opt: any) => {
    const mode = opt.animationMode ?? "none", dur = opt.animationDuration ?? 0;
    const target = { ...cam };
    if (typeof opt.zoomLevel === "number") target.zoom = opt.zoomLevel;
    if (typeof opt.pitch === "number") target.pitch = opt.pitch;
    if (typeof opt.heading === "number") target.heading = opt.heading;
    if (Array.isArray(opt.centerCoordinate)) { target.lng = opt.centerCoordinate[0]; target.lat = opt.centerCoordinate[1]; }
    if ((mode === "flyTo" || mode === "easeTo" || mode === "linearTo") && dur > 0) {
      if (mode === "flyTo") counts.setFly++; else counts.setEase++;
      anim = { t0: now, dur, from: { ...cam }, to: target, kind: mode };
      return;
    }
    counts.setNone++;
    if (o.android) anim = null;                     // Android: 'none' is flyToV11(duration 0) — cancels
    Object.assign(cam, target); camMoved = true;    // iOS: instant set; a running animation overrides it at vsync
  };
  const cameraRef = ref({ setCamera });
  // ── CarMapView refs + lifted code ──
  const csf = sfOf(src.carMapView);
  const C: Record<string, any> = {
    ...M, Math, Date: { now: () => now },
    logEvent: (m: string) => { log.push(`${now - T0} ${m}`); },
    noteMapIdle: () => {}, setCarNorthUp: () => {}, setCarState: () => {},
    getCarState: () => ({ selfLat: cam.lat, selfLng: cam.lng, peers: C.__peers }),
    __peers: [{ lat: 49.25, lng: -123.4 }],          // a spread crew: fit zoom < 14 → the return FLIES
    CAR_USER_ZOOM_BIAS_LIMIT: cmConst("CAR_USER_ZOOM_BIAS_LIMIT"), CAR_ZOOM_HOLD_MS: cmConst("CAR_ZOOM_HOLD_MS"),
    CAR_PREVIEW_ZOOM_MIN: cmConst("CAR_PREVIEW_ZOOM_MIN"), CAR_ZOOM_MIN: cmConst("CAR_ZOOM_MIN"), CAR_ZOOM_MAX: cmConst("CAR_ZOOM_MAX"),
    CREW_FIT_MAX_KM: cmConst("CREW_FIT_MAX_KM"), CAR_BANNER_STACK_BOTTOM: cmConst("CAR_BANNER_STACK_BOTTOM"),
    CAR_BANNER_GAP_SCALABLE: cmConst("CAR_BANNER_GAP_SCALABLE"), CAR_LOWER_PAD_FRAC: cmConst("CAR_LOWER_PAD_FRAC"), CAR_LEFT_PAD_FRAC: cmConst("CAR_LEFT_PAD_FRAC"),
    ZOOM_TAP_STEP: Number(/const ZOOM_TAP_STEP = ([\d.]+);/.exec(src.carMapView)![1]),
    cameraRef, mapW: 800, mapH: 480, hasFix: true,
    camInputsRef: ref({ followZoom: o.followZoom ?? 16.8, followPitch: o.followPitch ?? 45, mapH: 480, mapW: 800, previewMulti: false, uiScale: 1, mapScale: 1 }),
    paintedRef: ref(true), lockReadyRef: ref(true), aaLiveRef: ref({ hasFix: true, lat: cam.lat, lng: cam.lng, followZoom: o.followZoom ?? 16.8, followPitch: 45 }),
    camHoldUntilRef: ref(0), crewEaseUntilRef: ref(0), camHoldWasActiveRef: ref(false), crewOverviewRef: ref(false), returnFlyRef: ref(0), zoomSnapRef: ref(false),
    zoomHoldUntilRef: ref(0), userZoomRef: ref(0), zoomBaseRef: ref(0), pinchActiveRef: ref(false),
    manualZoomRef: ref(null), zoomChRef: ref(M.newCarZoomChannel()), zoomLogRef: ref(M.newCarZoomLog()),
    camZoomRef: ref(null), camPitchRef: ref(null), carLiveZoomRef: ref(null), lastRefreshZoomRef: ref(null),
    selfRefreshAt: ref(0), selfRefreshRef: ref(null), scaleRefreshLogAt: ref(0),
    camHdgOverrideRef: ref(undefined), carNorthUpRef: ref(false), camHdgRef: ref(90), drawHdgRef: ref(90),
    aaPendingRecenterRef: ref(false), aaRecenterLogAtRef: ref(0),
  };
  const CP = scopeProxy(C, unresolved);
  for (const n of ["clampBias", "zoomLog", "zoomHoldRelease", "carCamJob", "getCam", "applyZoomNow", "applyZoomEased", "reassertAaFollow"]) C[n] = bind(liftVar(csf, "CarMapView", n), CP);
  const gesture = bind(liftCallArg(csf, "CarMapView", "subscribeCarGesture", () => true), CP);
  const onCameraChanged = bind(liftJsxAttr(csf, "CarMapView", "onCameraChanged"), CP);
  const lockLine = /^\s*(lockReadyRef\.current = [^\n]+;)\s*$/m.exec(region(src.carMapView, "car-cam-northup-lockready"))![1];
  const carRender = bind(`() => { ${lockLine} }`, CP);
  // ── SelfCarModel refs + lifted code (props wired like CarMapView's JSX) ──
  const msf = sfOf(src.convoyMapbox);
  const timers: { at: number; fn: () => void; id: number; raf: boolean }[] = [];
  let tid = 0;
  const S: Record<string, any> = {
    ...M, Math, Date: { now: () => now },
    FAST_PUMP_MS: Number(/const FAST_PUMP_MS = (\d+);/.exec(src.convoyMapbox)![1]), FAST_PUMP_RUN: Number(/const FAST_PUMP_RUN = (\d+);/.exec(src.convoyMapbox)![1]),
    CAM_GLIDE: { zoomSlewPerS: val(MB, "CAM_ZOOM_SLEW_PER_S"), zoomDeadband: val(MB, "CAM_ZOOM_DEADBAND"), pitchSlewPerS: val(MB, "CAM_PITCH_SLEW_PER_S"), tauMs: val(MB, "CAM_SMOOTH_TAU_MS") },
    NOSE_LEAD_IN_ENABLED: val(MB, "NOSE_LEAD_IN_ENABLED"), CAM_HEADING_LAG_MS: val(MB, "CAM_HEADING_LAG_MS"), CAM_HEADING_MAX_LEAD_DEG: val(MB, "CAM_HEADING_MAX_LEAD_DEG"),
    // props (CarMapView JSX)
    cameraRef, getCam: C.getCam, readyRef: C.lockReadyRef, camHeadingOverrideRef: C.camHdgOverrideRef, camZoomOutRef: C.camZoomRef,
    camPitchOutRef: C.camPitchRef, returnFlyRef: C.returnFlyRef, camJob: C.carCamJob, zoomSnapRef: C.zoomSnapRef, liveZoomRef: C.carLiveZoomRef,
    drawPosOutRef: ref(null), drawSinkRef: ref(null), onFirstCam: () => {}, mapRef: ref(null), speedMs: 0, probeRole: "car", sizePt: 50, lenUnits: 4.5,
    // internals
    render: ref({ lat: cam.lat, lng: cam.lng, heading: 90 }), anim: ref(null), raf: ref(null), rafIsTimer: ref(false), lastArmAt: ref(0), fastPumpRun: ref(0),
    rafDead: ref(false), lastStepAtRef: ref(0), lastBgTickAt: ref(0), lastDrawnRef: ref(null), lastFrameRef: ref(0), pacerRef: ref(M.createFramePacer()),
    probeKeyRef: ref("car#1"), camZoom: ref(null), camPitch: ref(null), camZoomGoal: ref(null), camPitchGoal: ref(null), camHdgLag: ref(null),
    speedRef: ref(0), camApplyAt: ref(0), camApplyBusy: ref(false), firstCamDoneRef: ref(true), lastCamAt: ref(0), flyDestRef: ref(null),
    camProbeAt: ref(0), camProbeZoom: ref(-99), camProbePitch: ref(-99), liftRef: ref(0),
    noteCam: () => { counts.noteCam++; }, noteTick: () => {}, noteFrame: () => {}, noteRafFrame: () => {}, noteEaseIdle: () => {},
    setTick: () => { selfDirty = true; }, logEvent: (m: string) => { log.push(`${now - T0} ${m}`); },
    modelScaleForPoints: (pt: number, len: number, z: number) => (pt / len) * Math.pow(2, 17 - z),
    requestAnimationFrame: (fn: () => void) => { const id = ++tid; if (o.rafAlive !== false) timers.push({ at: Math.floor((now - T0) / VS + 1) * VS + T0, fn, id, raf: true }); return id; },
    cancelAnimationFrame: (id: number) => { const i = timers.findIndex((x) => x.id === id); if (i >= 0) timers.splice(i, 1); },
    setTimeout: (fn: () => void, d: number) => { const id = ++tid; timers.push({ at: now + Math.max(1, d), fn, id, raf: false }); return id; },
    clearTimeout: (id: number) => { const i = timers.findIndex((x) => x.id === id); if (i >= 0) timers.splice(i, 1); },
  };
  const VS = 1000 / 60;
  const SP = scopeProxy(S, unresolved);
  for (const n of ["angDelta", "camGlidePending", "pushCam", "bgTick", "armNextFrame", "cancelNextFrame", "step"]) S[n] = bind(liftVar(msf, "SelfCarModel", n), SP);
  const wake = bind(liftCallArg(msf, "SelfCarModel", "useEffect", (t, n) => n === 1 && /if \(camGlidePending\(\)\) armNextFrame\(\);/.test(t)), SP);
  const perTick = bind(`() => { ${region(src.convoyMapbox, "mbx-selfcar-pertick-size")}\n return perTickZoom; }`, SP);
  let selfDirty = false, sizeZoom: number | null = null;
  C.selfRefreshRef.current = () => { selfDirty = true; };
  const camJobCounted = C.carCamJob;
  S.camJob = () => { counts.camJob++; return camJobCounted(); };
  // ── React after each JS turn ──
  const settle = () => {
    for (let k = 0; k < 4 && selfDirty; k++) {
      selfDirty = false; counts.renders++;
      sizeZoom = perTick();
      wake();
    }
  };
  const turn = (fn: () => void) => { fn(); settle(); };
  // ── the moving car: the harness plays SelfCarModel's fix effect ──
  let moving = false, nextFix = 0;
  let followZoomAt: ((t: number) => number) | null = null;
  const fix = () => {
    const r = S.render.current, h = 90, d = 15;   // 15 m/s due east
    const toLng = r.lng + d / (111320 * Math.cos((r.lat * Math.PI) / 180));
    S.anim.current = { fromLat: r.lat, fromLng: r.lng, fromHdg: r.heading, toLat: r.lat, toLng, toHdg: h, start: now, dur: 1100, armedAt: now, stepped: false };
    if (S.raf.current == null) S.raf.current = S.requestAnimationFrame(S.step);
  };
  const frames: Frame[] = [];
  let lastVsync = Math.floor((now - T0) / VS);
  let nextStore = now, nextInterval = now;
  const advance = (ms: number) => {
    const end = now + ms;
    while (now < end) {
      now += 1;
      if (moving && now >= nextFix) { nextFix = now + 1000; turn(fix); }
      // timers due (setTimeout fallback of the pump guard)
      for (;;) { const i = timers.findIndex((x) => !x.raf && x.at <= now); if (i < 0) break; const t = timers.splice(i, 1)[0]; turn(t.fn); }
      const vs = Math.floor((now - T0) / VS);
      if (vs !== lastVsync) {
        lastVsync = vs;
        // native animation → camera, then onCameraChanged
        if (anim) {
          const s = Math.min(1, (now - anim.t0) / anim.dur), e = s * s * (3 - 2 * s);
          for (const k of ["zoom", "pitch", "heading", "lat", "lng"] as const) (cam as any)[k] = (anim.from as any)[k] + ((anim.to as any)[k] - (anim.from as any)[k]) * e;
          camMoved = true;
          if (s >= 1) anim = null;
        }
        if (camMoved) { camMoved = false; turn(() => onCameraChanged({ properties: { zoom: cam.zoom } })); }
        frames.push({ t: now - T0, zoom: cam.zoom, pitch: cam.pitch, sizeZoom, animating: !!anim });
        // rAF callbacks due at this vsync
        const due = timers.filter((x) => x.raf && x.at <= now); for (const t of due) { timers.splice(timers.indexOf(t), 1); turn(t.fn); }
        if (o.carFramePump !== false && !o.android) turn(S.bgTick);   // iOS onCarFrame → bgTick
      }
      if (now >= nextInterval) { nextInterval += 33; turn(S.bgTick); }
      if (now >= nextStore) {
        nextStore += o.renderMs ?? 1000;
        if (followZoomAt) api.setFollowZoom(followZoomAt(now - T0));
        turn(() => { carRender(); selfDirty = true; });
      }
    }
  };
  const api = {
    get now() { return now - T0; }, get abs() { return now; }, cam, C, S, log, counts, frames, unresolved,
    setFollowZoom(z: number) { C.camInputsRef.current = { ...C.camInputsRef.current, followZoom: z }; C.aaLiveRef.current = { ...C.aaLiveRef.current, followZoom: z }; },
    setMoving(m: boolean) { moving = m; if (m) nextFix = now; },
    /** followZoom as a function of harness time, applied at each CarMapView render (null = hold the last value). */
    followZoomAt(f: ((t: number) => number) | null) { followZoomAt = f; },
    /** harness-time of every log row matching re */
    rows(re: RegExp) { return log.filter((r) => re.test(r)).map((r) => ({ t: Number(r.split(" ")[0]), row: r })); },
    advance,
    gesture(g: any) { turn(() => gesture(g)); },
    press(delta: number) { turn(() => gesture({ kind: "zoomStep", delta })); },
    crew() { turn(() => gesture({ kind: "crewFit" })); },
    /** the AA/CarPlay AppState re-assert (🔒 car-aa-follow-reassert) — it reads getCam().padding outside a push */
    reassert() { turn(() => C.reassertAaFollow("appstate")); },
    /** largest vsync-to-vsync zoom change in [a, b] ms (harness time) */
    maxStep(a: number, b: number) { let m = 0, at = 0; for (let i = 1; i < frames.length; i++) if (frames[i].t >= a && frames[i].t <= b) { const d = Math.abs(frames[i].zoom - frames[i - 1].zoom); if (d > m) { m = d; at = frames[i].t; } } return { m, at }; },
    /** largest |self-car size zoom − visible zoom| at vsync in [a, b] (a size pop is the car drawn for the wrong zoom) */
    maxSizeLag(a: number, b: number) { let m = 0, at = 0; for (const f of frames) if (f.t >= a && f.t <= b && f.sizeZoom != null) { const d = Math.abs(f.sizeZoom - f.zoom); if (d > m) { m = d; at = f.t; } } return { m, at }; },
    zoomAt(t: number) { let best = frames[0]; for (const f of frames) if (Math.abs(f.t - t) < Math.abs(best.t - t)) best = f; return best.zoom; },
  };
  // warm-up: a moving car for 3 s (the lockstep seeds itself), then whatever the scenario does
  api.setMoving(true); advance(3000);
  return api;
}
