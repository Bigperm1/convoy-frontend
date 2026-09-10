// poseSeed — remembers the gyro's sign convention between drives.
//
// The pose estimator (src/poseEstimator.ts) cannot know from a sensor sample alone whether a
// positive yaw rate means "heading increasing" — mount orientation, platform convention and
// axis order all vary. It learns the sign from the GPS course, which needs a real turn: without
// this file the FIRST corner of every drive would be GPS-only. The sign is a property of the
// phone, so once learned it is kept.
import AsyncStorage from "@react-native-async-storage/async-storage";
import { logEventReliable } from "./crashBreadcrumb";

// v2 (2026-09-10): the cumulative yaw's sign convention changed when the feed moved from rate·ĝ
// (ĝ down ⇒ counter-clockwise negative) to the fused attitude (counter-clockwise positive). A v1
// sign applied to the new feed would turn the predicted heading the WRONG way until four opposing
// corners re-learned it (Codex 4th pass) — so v1 is simply never read again.
const KEY = "convoy.poseYawSign.v2";
let _cached: 1 | -1 | null = null;
let _loaded = false;
let _loading: Promise<void> | null = null;

/** Kick off the read once; callers poll getSeededYawSign() per render (null until known). */
export function ensureYawSignLoaded(): Promise<void> {
  if (_loaded) return Promise.resolve();
  if (_loading) return _loading;
  _loading = (async () => {
    try {
      const raw = await AsyncStorage.getItem(KEY);
      if (raw === "1") _cached = 1;
      else if (raw === "-1") _cached = -1;
    } catch {}
    _loaded = true;
  })();
  return _loading;
}

export function getSeededYawSign(): 1 | -1 | null {
  return _cached;
}

/** The estimator learned (or re-learned) the sign on this drive. Persist it if it changed. */
export function noteLearnedYawSign(sign: 1 | -1): void {
  if (_cached === sign) return;
  const was = _cached;
  _cached = sign;
  try { void AsyncStorage.setItem(KEY, String(sign)); } catch {}
  try { logEventReliable(`yaw-sign learned=${sign} was=${was ?? "none"}`); } catch {}
}
