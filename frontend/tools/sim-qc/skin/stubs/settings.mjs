// Same merge/notify semantics as src/settings.ts updateSettings (patch spread; listeners notified synchronously).
let cached = {};
const listeners = new Set();
export function __reset(s = {}) { cached = { ...s }; }
export function getSettings() { return cached; }
export async function updateSettings(patch) { cached = { ...cached, ...patch }; listeners.forEach((l) => l(cached)); return cached; }
export function subscribeSettings(fn) { listeners.add(fn); return () => listeners.delete(fn); }
