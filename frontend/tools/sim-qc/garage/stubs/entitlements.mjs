export const ENTITLEMENTS_ENFORCED = false;
let dev = null, tier = "free";
export function __set(d, t = "free") { dev = d; tier = t; }
export function getDevTier() { return dev; }
export function getTier() { return tier; }
