let g = {};
const subs = new Set();
export function __set(next) { g = { ...next }; subs.forEach((f) => f(g)); }
export function getGarage() { return g; }
export function subscribeGarage(fn) { subs.add(fn); return () => subs.delete(fn); }
