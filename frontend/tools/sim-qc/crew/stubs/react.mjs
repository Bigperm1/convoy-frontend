// A MINIMAL MODEL OF REACT'S HOOK RULES — not React — for running ONE custom hook under plain node (crew_online_test).
// What it keeps from React: hooks are identified by call order; refs and state persist across renders; an effect runs
// AFTER the render in which any of its deps changed (Object.is, element by element; no deps array = every render), its
// previous cleanup first; unmount runs every cleanup. setState does not schedule a re-render — the test re-renders.
let current = null;
let idx = 0;
let pending = [];
export function __mount(fn) { return { fn, hooks: [] }; }
export function __render(inst, ...args) {
  current = inst; idx = 0; pending = [];
  const out = inst.fn(...args);
  current = null;
  const run = pending; pending = [];
  for (const f of run) f();
  return out;
}
export function __unmount(inst) {
  for (const h of inst.hooks) if (h && h.kind === "effect" && typeof h.cleanup === "function") { try { h.cleanup(); } catch {} }
  inst.hooks = [];
}
export function useRef(init) {
  const hooks = current.hooks; const i = idx++;
  if (!hooks[i]) hooks[i] = { kind: "ref", current: init };
  return hooks[i];
}
export function useState(init) {
  const hooks = current.hooks; const i = idx++;
  if (!hooks[i]) hooks[i] = { kind: "state", v: typeof init === "function" ? init() : init };
  const h = hooks[i];
  return [h.v, (v) => { h.v = typeof v === "function" ? v(h.v) : v; }];
}
export function useEffect(fn, deps) {
  const hooks = current.hooks; const i = idx++;
  const prev = hooks[i];
  const changed = !prev || !deps || !prev.deps || deps.length !== prev.deps.length || deps.some((d, k) => !Object.is(d, prev.deps[k]));
  const h = prev ?? { kind: "effect", deps: undefined, cleanup: undefined };
  hooks[i] = h;
  if (changed) {
    h.deps = deps;
    pending.push(() => { if (typeof h.cleanup === "function") h.cleanup(); h.cleanup = fn(); });
  }
}
export function useSyncExternalStore(_subscribe, getSnapshot) { return getSnapshot(); }
