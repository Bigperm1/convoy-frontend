// watchLink — the phone side of the Apple Watch companion (build 77).
//
// Subscribes to carStore (the SAME state the car list draws), builds the wrist payload
// (src/watchFeed.ts), pushes it through modules/hairpin-watch, and decides wrist taps with
// src/watchTaps.ts. A tap goes as a live message when the watch app is reachable; otherwise the
// Tier-0 local notification stands in (standard haptic). Hangs off carStore writes — which the
// locked-phone NAV_TASK path keeps alive — never off a JS timer.
import { Platform } from "react-native";
import { HairpinWatch, type WatchLinkState } from "../modules/hairpin-watch";
import { subscribeCarState, getCarState, type CarState } from "./carplay/carStore";
import { buildWatchPayload, shouldSendWatch, type WatchPayload } from "./watchFeed";
import { tapStart, tapDecide, tapSideFor, type TapState } from "./watchTaps";
import { notifyTurnOnWrist, clearTurnWrist } from "./watchTurnNotify";
import { logEventReliable } from "./crashBreadcrumb";

const TAP_ROWS_MAX = 40;   // per app session — a drive has tens of turns, not hundreds
const ERR_ROWS_MAX = 10;   // per app session — bounded like TAP_ROWS_MAX, just a smaller budget
const CTX_ROWS_MAX = 20;   // link-state churn (a watch going in and out of range) is unbounded
const STEP_JUMP_M = 50;    // a real new step puts the turn FURTHER away; a text rewrite does not
let _stop: (() => void) | null = null;
let _prev: WatchPayload | null = null;
let _lastSentAt = -Infinity;
let _tap: TapState = tapStart();
let _tapRows = 0;
let _errRows = 0;
let _ctxRows = 0;
let _stepKey = "";
let _stepIdxSeen = -1;
let _lastDistM = 0;
let _lastLink = "";
// The last onWatchState payload. Calling HairpinWatch.getState() per carStore tick is a
// synchronous native hop at up to 12 Hz for a value the module already pushes on every change.
let _link: WatchLinkState | null = null;

function stepIdxOf(s: CarState): number {
  // FALLBACK ONLY — used when the engine did not write navStepIdx (an older cold path). carStore
  // carries no step index of its own there, so a change of instruction+maneuverKey is the signal,
  // but ONLY when the turn also jumped further away: the two engines hand the strip back and
  // forth (claimCarNavStrip) and rewrite the SAME turn's text, which is not a new step.
  const key = `${s.instruction}|${s.maneuverKey ?? ""}`;
  const d = Number.isFinite(s.distanceToTurnM) ? s.distanceToTurnM : 0;
  if (_stepKey !== key) {
    const first = _stepKey === "";
    _stepKey = key;
    if (first || d - _lastDistM >= STEP_JUMP_M) _stepIdxSeen += 1;
  }
  _lastDistM = d;
  return _stepIdxSeen;
}

function resetStepTracking() {
  _stepKey = ""; _stepIdxSeen = -1; _lastDistM = 0; _lastSentAt = -Infinity;
}

function onLink(st: WatchLinkState) {
  _link = st;
  // Activation or reachability just changed — the watch may have missed everything we sent
  // before it. Forget the dedupe baseline so the next carStore tick resends in full.
  _prev = null;
  const row = `watch-ctx paired=${st.paired ? 1 : 0} app=${st.appInstalled ? 1 : 0} reach=${st.reachable ? 1 : 0} act=${st.activation}`;
  if (row !== _lastLink && _ctxRows < CTX_ROWS_MAX) {
    _lastLink = row; _ctxRows += 1;
    try { logEventReliable(row); } catch {}
  } else if (row !== _lastLink) {
    _lastLink = row;
  }
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

// sendMessage said true, WatchConnectivity's errorHandler said otherwise. A payload can wait for
// the next tick; a TAP cannot — fall back to the notification, with the CURRENT turn on it.
function onSendError(m: { json: string }) {
  let o: any = null;
  try { o = JSON.parse(m.json); } catch { return; }
  if (!o || !o.tap) return;
  const s = getCarState();
  void notifyTurnOnWrist({ glyph: s.maneuverIcon ?? "", street: s.instruction, distM: s.distanceToTurnM }).then((res) => {
    if (_tapRows >= TAP_ROWS_MAX) return; _tapRows += 1;
    try {
      logEventReliable(`watch-tap step=${typeof s.navStepIdx === "number" ? s.navStepIdx : _stepIdxSeen} kind=${String(o.tap)} side=${String(o.side ?? "generic")}` +
        ` via=notif-after-fail ok=${res === "sent" ? 1 : 0} d=${Math.round(s.distanceToTurnM)}`);
    } catch {}
  });
}

export function startWatchLink(): () => void {
  if (_stop) return _stop;
  if (Platform.OS !== "ios" || !HairpinWatch) return () => {};
  const linkSub = HairpinWatch.addListener("onWatchState", onLink);
  const msgSub = HairpinWatch.addListener("onWatchMessage", onWatchMessage);
  const errSub = HairpinWatch.addListener("onWatchSendError", onSendError);
  onLink(HairpinWatch.getState());   // seeds _link; every later value arrives on onWatchState
  const carSub = subscribeCarState((s) => {
    const st = _link;
    if (!st || !st.paired || !st.appInstalled) return;
    const now = Date.now();
    const stepIdx = s.navigating ? (typeof s.navStepIdx === "number" ? s.navStepIdx : stepIdxOf(s)) : -1;
    const next = buildWatchPayload({
      navigating: s.navigating, maneuverIcon: s.maneuverIcon, instruction: s.instruction, distanceToTurnM: s.distanceToTurnM,
      maneuverKey: s.maneuverKey, etaSeconds: s.etaSeconds, stepIdx, peersLive: s.peers.filter((p) => p.status === "live").length,
    }, now);
    if (shouldSendWatch(_prev, next, _lastSentAt)) {
      const json = JSON.stringify(next);
      // Advance the dedupe baseline ONLY if something actually left the phone. A failed send
      // that still moved _prev would make the next tick think the wrist is up to date.
      const ctxOk = HairpinWatch!.updateContext(json);
      const msgOk = st.reachable ? HairpinWatch!.sendMessage(json) : false;
      if (ctxOk || msgOk) { _prev = next; _lastSentAt = now; }
    }
    if (!s.navigating) { _tap = tapStart(); resetStepTracking(); clearTurnWrist(); return; }
    const r = tapDecide(_tap, { stepIdx, distM: s.distanceToTurnM, speedMs: s.speedMs, nowMs: now });
    _tap = r.st;
    if (!r.tap) return;
    const side = tapSideFor(s.maneuverKey);
    const viaMsg = st.reachable && HairpinWatch!.sendMessage(JSON.stringify({ tap: r.tap, side }));
    const done: Promise<"sent" | "suppressed" | "failed"> = viaMsg
      ? Promise.resolve("sent" as const)
      : notifyTurnOnWrist({ glyph: s.maneuverIcon ?? "", street: s.instruction, distM: s.distanceToTurnM });
    void done.then((res) => {
      if (_tapRows >= TAP_ROWS_MAX) return; _tapRows += 1;
      const via = viaMsg ? "msg" : res === "suppressed" ? "suppressed" : "notif";
      try { logEventReliable(`watch-tap step=${stepIdx} kind=${r.tap} side=${side} via=${via} ok=${res === "sent" ? 1 : 0} d=${Math.round(s.distanceToTurnM)} spd=${s.speedMs.toFixed(1)}`); } catch {}
    });
  });
  _stop = () => {
    linkSub.remove(); msgSub.remove(); errSub.remove(); carSub();
    _stop = null; _prev = null; _link = null; _tap = tapStart();
    resetStepTracking();
    if (__DEV__) delete (globalThis as any).__hairpinWatchPush;
  };
  // Debug hook for the sim (Task 7 step 2): push an arbitrary payload from the JS console.
  // DEV only — a release bundle must not carry a global that can write the wrist's state.
  if (__DEV__) (globalThis as any).__hairpinWatchPush = (json: string) => HairpinWatch!.updateContext(json);
  return _stop;
}
