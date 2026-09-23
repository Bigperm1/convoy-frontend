// Same merge/notify semantics as src/settings.ts updateSettings (patch spread; undefined clears a key).
let cached = {};
export const writes = [];
export function __reset(s = {}) { cached = { ...s }; writes.length = 0; }
export function getSettings() { return cached; }
export async function updateSettings(patch) { cached = { ...cached, ...patch }; writes.push(patch); return cached; }
export function getSelfMarkerType(s) { return s.selfMarkerType ?? "car"; }
export function getVehicleClass(s) { return s.vehicleClass ?? "hatchback"; }
export function getClassPaint(s) { const c = getVehicleClass(s); return s.classPaint?.[c] ?? (s.classColors?.[c] ? { primary: s.classColors[c] } : {}); }
// Same as src/settings.ts hydrateCarFromProfile: fill EMPTY car fields from the profile, never overwrite.
export async function hydrateCarFromProfile(p) {
  const patch = {};
  if (!cached.carMake && p.car_make) patch.carMake = p.car_make;
  if (!cached.carModel && p.car_model) patch.carModel = p.car_model;
  if (!cached.carColor && p.car_color) patch.carColor = p.car_color;
  if (!cached.carYear && p.car_year != null) patch.carYear = String(p.car_year);
  if (Object.keys(patch).length) await updateSettings(patch);
}
