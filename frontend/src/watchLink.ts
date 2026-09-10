// watchLink — the phone side of the Apple Watch companion (build 77).
//
// Subscribes to carStore (the SAME state the car list draws), builds the wrist payload
// (src/watchFeed.ts), pushes it through modules/hairpin-watch, and decides wrist taps with
// src/watchTaps.ts. A tap goes as a live message when the watch app is reachable; otherwise the
// Tier-0 local notification stands in (standard haptic). Hangs off carStore writes — which the
// locked-phone NAV_TASK path keeps alive — never off a JS timer.
import { Platform } from "react-native";
import { HairpinWatch, type WatchLinkState } from "../modules/hairpin-watch";
import { subscribeCarState, getCarState } from "./carplay/carStore";
import { buildWatchPayload, shouldSendWatch, type WatchPayload } from "./watchFeed";
import { tapStart, tapDecide, tapSideFor, type TapState } from "./watchTaps";
import { notifyTurnOnWrist } from "./watchTurnNotify";
import { logEventReliable } from "./crashBreadcrumb";

const TAP_ROWS_MAX = 40;   // per app session — a drive has tens of turns, not hundreds
const ERR_ROWS_MAX = 10;   // per app session — bounded like TAP_ROWS_MAX, just a smaller budget
let _stop: (() => void) | null = null;
let _prev: WatchPayload | null = null;
let _lastSentAt = -Infinity;
let _tap: TapState = tapStart();
let _tapRows = 0;
let _errRows = 0;
let _stepKey = "";
let _stepIdxSeen = -1;
let _lastLink = "";

function stepIdxOf(): number {
  // carStore carries no step index; a change of instruction+maneuverKey is a step change.
  const s = getCarState();
  const key = `${s.instruction}|${s.maneuverKey ?? ""}`;
  if (_stepKey !== key) { _stepKey = key; _stepIdxSeen += 1; }
  return _stepIdxSeen;
}

function onLink(st: WatchLinkState) {
  const row = `watch-ctx paired=${st.paired ? 1 : 0} app=${st.appInstalled ? 1 : 0} reach=${st.reachable ? 1 : 0} act=${st.activation}`;
  if (row !== _lastLink) { _lastLink = row; try { logEventReliable(row); } catch {} }
}

function onWatchMessage(m: { json: string }) {
  try {
    const o = JSON.parse(m.json);
    if (o && o.err) {
      if (_errRows >= ERR_ROWS_MAX) return;
      _errRows += 1;
      try { logEventReliable(`watch-err kind=${String(o.err)}`); } catch {}
    }
  } catch {}
}

export function startWatchLink(): () => void {
  if (_stop) return _stop;
  if (Platform.OS !== "ios" || !HairpinWatch) return () => {};
  const linkSub = HairpinWatch.addListener("onWatchState", onLink);
  const msgSub = HairpinWatch.addListener("onWatchMessage", onWatchMessage);
  onLink(HairpinWatch.getState());
  const carSub = subscribeCarState((s) => {
    const st = HairpinWatch!.getState();
    if (!st.paired || !st.appInstalled) return;
    const now = Date.now();
    const stepIdx = s.navigating ? stepIdxOf() : -1;
    const next = buildWatchPayload({
      navigating: s.navigating, maneuverIcon: s.maneuverIcon, instruction: s.instruction, distanceToTurnM: s.distanceToTurnM,
      maneuverKey: s.maneuverKey, etaSeconds: s.etaSeconds, stepIdx, peersLive: s.peers.filter((p) => p.status === "live").length,
    }, now);
    if (shouldSendWatch(_prev, next, _lastSentAt)) {
      const json = JSON.stringify(next);
      HairpinWatch!.updateContext(json);
      if (st.reachable) HairpinWatch!.sendMessage(json);
      _prev = next; _lastSentAt = now;
    }
    if (!s.navigating) { _tap = tapStart(); return; }
    const r = tapDecide(_tap, { stepIdx, distM: s.distanceToTurnM, speedMs: s.speedMs, nowMs: now });
    _tap = r.st;
    if (!r.tap) return;
    const side = tapSideFor(s.maneuverKey);
    const viaMsg = st.reachable && HairpinWatch!.sendMessage(JSON.stringify({ tap: r.tap, side }));
    const done = viaMsg ? Promise.resolve(true) : notifyTurnOnWrist({ glyph: s.maneuverIcon ?? "", street: s.instruction, distM: s.distanceToTurnM });
    void done.then((ok) => {
      if (_tapRows >= TAP_ROWS_MAX) return; _tapRows += 1;
      try { logEventReliable(`watch-tap step=${stepIdx} kind=${r.tap} side=${side} via=${viaMsg ? "msg" : "notif"} ok=${ok ? 1 : 0} d=${Math.round(s.distanceToTurnM)} spd=${s.speedMs.toFixed(1)}`); } catch {}
    });
  });
  _stop = () => { linkSub.remove(); msgSub.remove(); carSub(); _stop = null; _prev = null; _tap = tapStart(); };
  // Debug hook for the sim (Task 7 step 2): push an arbitrary payload from the JS console.
  (globalThis as any).__hairpinWatchPush = (json: string) => HairpinWatch!.updateContext(json);
  return _stop;
}
