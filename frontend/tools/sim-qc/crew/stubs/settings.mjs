let cached = {};
export function __reset(s = {}) { cached = { ...s }; }
export function getSettings() { return cached; }
export function getAvatarMode(s) { return s.avatarMode === "ghost" ? "ghost" : "visible"; }
// carDataService's reads (the cold car payload).
export async function ensureSettingsLoaded() { return cached; }
export function getSelfMarkerType(s) { return s?.marker ?? "arrow"; }
export function getVehicleClass() { return undefined; }
export function getClassPaint() { return { primary: undefined, secondary: undefined }; }
