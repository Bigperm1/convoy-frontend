export const skins = [];
export async function setSkinChoice(c) { skins.push(c); return c; }
export function withAlpha(h, a) { return h; }
// The first finished scan holds the metal so the unlock wave can show it (src/appSkin.ts holdSkinForUnlock).
export const holds = [];
export async function holdSkinForUnlock(k) { holds.push(k); }
