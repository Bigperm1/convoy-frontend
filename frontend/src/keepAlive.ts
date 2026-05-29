import { BACKEND_URL } from "./api";

const PING_INTERVAL_MS = 10 * 60 * 1000;
let timer: ReturnType<typeof setInterval> | null = null;

async function ping() {
    try {
          await fetch(`${BACKEND_URL}/health`, { method: "GET" });
    } catch {}
}

export function startKeepAlive() {
    if (timer) return;
    ping();
    timer = setInterval(ping, PING_INTERVAL_MS);
}

export function stopKeepAlive() {
    if (timer) { clearInterval(timer); timer = null; }
}
