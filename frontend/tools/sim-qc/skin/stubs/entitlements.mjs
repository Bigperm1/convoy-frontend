// ENTITLEMENTS_ENFORCED is a LIVE binding here so one run can test both modes (importers see the reassignment).
export let ENTITLEMENTS_ENFORCED = false;
let tier = "free";
const listeners = new Set();
export function __set(enforced, t = "free") { ENTITLEMENTS_ENFORCED = enforced; tier = t; listeners.forEach((l) => l()); }
export function getTier() { return tier; }
export function subscribeEntitlement(fn) { listeners.add(fn); return () => listeners.delete(fn); }
