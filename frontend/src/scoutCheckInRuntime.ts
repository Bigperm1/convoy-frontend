// scoutCheckInRuntime.ts — wires src/scoutCheckIn.ts (pure) to the app: car-state ticks in,
// Scout's voice out. Started once from the authenticated app shell (app/(app)/_layout.tsx), so it
// runs whichever tab is open and on both surfaces — the car store's speedMs is fed by the map's
// location watcher on every fix, phone or head unit.
//
// Quiet rules (a check-in waits, it never interrupts): someone is on the push-to-talk, Scout is
// listening or thinking, a pitstop timer is running, or a manoeuvre is less than 400 m away. The
// Settings toggle "Drive check-ins" (scoutCheckIns) turns the whole thing off; the master voice
// switch is honoured by announce() itself. QA only: settings.scoutCheckInMinutes overrides the
// 90-minute interval so the simulator can show a check-in without a 90-minute drive.
import { getSettings } from "./settings";
import { subscribeCarState, getCarState } from "./carplay/carStore";
import { announce } from "./nav";
import { logEvent } from "./crashBreadcrumb";
import {
  CHECKIN_DEFAULTS, checkInConsume, checkInStart, checkInTick, pickCheckIn,
  type CheckInKind, type CheckInState,
} from "./scoutCheckIn";

const RECENT_KINDS_MAX = 4;
const RECENT_TEXTS_MAX = 12;
const MANEUVER_QUIET_M = 400;

let _state: CheckInState = checkInStart();
let _recentKinds: CheckInKind[] = [];
let _recentTexts: string[] = [];
let _unsub: (() => void) | null = null;
let _lastTickAt = 0;

function config() {
  const qa = getSettings().scoutCheckInMinutes;
  if (typeof qa === "number" && qa > 0) return { ...CHECKIN_DEFAULTS, firstMin: qa, repeatMin: qa };
  return CHECKIN_DEFAULTS;
}

function quietNow(): boolean {
  const st = getCarState();
  if (st.commsTx && st.commsTx !== "idle") return false;
  if (st.scoutListening || st.scoutThinking) return false;
  if (st.pitstopActive) return false;
  if (st.navigating && typeof st.distanceToTurnM === "number" && st.distanceToTurnM < MANEUVER_QUIET_M) return false;
  return true;
}

function deliver(): void {
  const st = getCarState();
  const minutes = Math.round(_state.movingMs / 60_000);
  const pick = pickCheckIn({
    minutesDriven: minutes,
    navigating: !!st.navigating,
    etaSeconds: st.etaSeconds || 0,
    destinationLabel: st.destinationLabel || "",
    crewCount: (st.peers?.length || 0) + 1,
    recentKinds: _recentKinds,
    recentTexts: _recentTexts,
  });
  const spoke = announce(pick.text);
  _recentKinds = [..._recentKinds, pick.kind].slice(-RECENT_KINDS_MAX);
  _recentTexts = [..._recentTexts, pick.text.slice(pick.text.indexOf(" ") + 1)].slice(-RECENT_TEXTS_MAX);
  try { logEvent(`scout-checkin kind=${pick.kind} min=${minutes} n=${_state.fired + 1} spoke=${spoke ? 1 : 0}`); } catch {}
}

export function startScoutCheckIns(): () => void {
  if (_unsub) return _unsub;
  _unsub = subscribeCarState((st) => {
    const s = getSettings();
    if (s.scoutCheckIns === false) return;          // off: the clock does not even run
    const now = Date.now();
    if (now - _lastTickAt < 1000) return;           // one tick a second is plenty for a 90-minute clock
    _lastTickAt = now;
    _state = checkInTick(_state, now, st.speedMs || 0, config());
    if (_state.due && quietNow()) {
      deliver();
      _state = checkInConsume(_state);
    }
  });
  return _unsub;
}

/** Test/QA hook: the clock's current reading in minutes. */
export function scoutCheckInMinutesDriven(): number {
  return _state.movingMs / 60_000;
}
