// carDataService's REST reads: /auth/me answers "me"; everything else is empty. No socket token (connectWs stays off).
export const api = { get: async (path) => ({ data: path === "/auth/me" ? { id: "me", handle: "jeff" } : [] }) };
export async function readTokenState() { return { token: null, state: "none" }; }
export function wsUrl() { return "ws://stub"; }
