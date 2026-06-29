// speedProfile.ts — learns the driver's HABITUAL over-the-limit margin so the first
// speed nudge stops nagging at speeds they always drive.
//
// We record a throttled sample of "how far over the posted limit" whenever the driver is
// over + moving, keep a rolling window, and expose a high-percentile "habitual" margin.
// map.tsx adds a small buffer + a hard CAP to that before raising only the TIER-1 nudge —
// the firmer tier-2 alert stays fixed, so the safety ceiling is preserved. Local-only.

import AsyncStorage from "@react-native-async-storage/async-storage";

const KEY = "convoy.speedProfile.v1";
const MAX_SAMPLES = 120;
const MIN_SAMPLES = 25;          // need this many before we adapt at all
const RECORD_THROTTLE_MS = 8000; // ~1 sample / 8s while over the limit

let samples: number[] = [];
let loaded = false;
let lastRecord = 0;
let dirty = false;

(async () => {
  try {
    const raw = await AsyncStorage.getItem(KEY);
    if (raw) { const a = JSON.parse(raw); if (Array.isArray(a)) samples = a.filter((n) => typeof n === "number"); }
  } catch {}
  loaded = true;
})();

async function persist() {
  if (!dirty) return;
  dirty = false;
  try { await AsyncStorage.setItem(KEY, JSON.stringify(samples)); } catch {}
}

// Record how far over the limit (km/h) the driver currently is. Ignores non-speeding and
// extreme outliers; throttled so it doesn't sample every GPS tick.
export function recordOver(overKmh: number): void {
  if (!loaded || overKmh < 3 || overKmh > 45) return;
  const now = Date.now();
  if (now - lastRecord < RECORD_THROTTLE_MS) return;
  lastRecord = now;
  samples.push(overKmh);
  if (samples.length > MAX_SAMPLES) samples.splice(0, samples.length - MAX_SAMPLES);
  dirty = true;
  if (samples.length % 5 === 0) void persist();
}

// The over-margin (km/h) the driver HABITUALLY sustains — the 70th percentile of recent
// samples — or null until there's enough data to adapt. The caller adds a buffer + caps.
export function habitualOverKmh(): number | null {
  if (samples.length < MIN_SAMPLES) return null;
  const sorted = [...samples].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.floor(sorted.length * 0.7));
  return sorted[idx];
}
