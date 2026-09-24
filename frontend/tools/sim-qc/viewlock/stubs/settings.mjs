let cached = {};
const subs = new Set();
export function __set(s) { cached = { ...s }; subs.forEach((f) => f(cached)); }
export function getSettings() { return cached; }
export function subscribeSettings(fn) { subs.add(fn); return () => subs.delete(fn); }
