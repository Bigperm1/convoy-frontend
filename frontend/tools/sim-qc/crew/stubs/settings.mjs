let cached = {};
export function __reset(s = {}) { cached = { ...s }; }
export function getSettings() { return cached; }
export function getAvatarMode(s) { return s.avatarMode === "ghost" ? "ghost" : "visible"; }
