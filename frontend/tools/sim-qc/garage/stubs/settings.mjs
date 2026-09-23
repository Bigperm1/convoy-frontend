// Same merge/notify semantics as src/settings.ts updateSettings (patch spread; undefined clears a key).
let cached = {};
export const writes = [];
export function __reset(s = {}) { cached = { ...s }; writes.length = 0; }
export function getSettings() { return cached; }
export async function updateSettings(patch) { cached = { ...cached, ...patch }; writes.push(patch); return cached; }
export function getSelfMarkerType(s) { return s.selfMarkerType ?? "car"; }
export function getVehicleClass(s) { return s.vehicleClass ?? "hatchback"; }
export function getClassPaint(s) { const c = getVehicleClass(s); return s.classPaint?.[c] ?? (s.classColors?.[c] ? { primary: s.classColors[c] } : {}); }
