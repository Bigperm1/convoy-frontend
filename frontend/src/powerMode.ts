// powerMode.ts — premium vs eco power profile driven by charge state.
//
// The model (Jeff's design): PLUGGED IN → "premium" (full fidelity — the current
// code path, untouched), UNPLUGGED → "eco" (a lighter profile that trades some
// polish for battery/heat). iOS Low Power Mode also forces "eco" even when plugged,
// so the user's explicit "save my battery" intent is respected.
//
// SAFETY: charge detection needs expo-battery, a NATIVE module that only exists from
// build 63 onward. This module is written so it is a guaranteed NO-OP on any build
// that lacks it (e.g. an OTA landing on build 62): the require is guarded, every
// native call is try/caught, and the default mode is "premium" (= current behavior).
// So gating code on getPowerMode() is safe to ship anywhere — it simply never leaves
// "premium" until a build with expo-battery runs it. Nothing about the premium path
// changes; eco only ever adds an `if (unplugged)` branch.

import { useEffect, useState } from "react";
import { getSettings, useSettings } from "./settings";

export type PowerMode = "premium" | "eco";

// Guarded load — resolves the JS on any build, but the native calls below no-op on a
// build without the linked module.
let Battery: any = null;
try {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  Battery = require("expo-battery");
} catch {
  Battery = null;
}

let _mode: PowerMode = "premium"; // default = full fidelity (safe fallback everywhere)
let _lowPower = false;
let _lastState: number | undefined;
const _listeners = new Set<(m: PowerMode) => void>();

function _emit() {
  _listeners.forEach((fn) => {
    try { fn(_mode); } catch {}
  });
}

function _plugged(state: number | undefined): boolean {
  const S = Battery?.BatteryState;
  if (!S) return true; // unknown → assume premium (never degrade on missing data)
  return state === S.CHARGING || state === S.FULL;
}

function _recompute() {
  // Plugged in AND not in Low Power Mode → premium; otherwise eco.
  const next: PowerMode = _plugged(_lastState) && !_lowPower ? "premium" : "eco";
  if (next !== _mode) { _mode = next; _emit(); }
}

let _started = false;
/** Idempotent. Starts the battery listeners once. No-op without expo-battery. */
export async function startPowerMode(): Promise<void> {
  if (_started) return;
  _started = true;
  if (!Battery) return; // build without the native module → stay "premium" forever
  try {
    _lastState = await Battery.getBatteryStateAsync();
    try { _lowPower = !!(await Battery.isLowPowerModeEnabledAsync()); } catch { _lowPower = false; }
    _recompute();
    try {
      Battery.addBatteryStateListener(({ batteryState }: any) => {
        _lastState = batteryState;
        _recompute();
      });
    } catch {}
    try {
      Battery.addLowPowerModeListener(({ lowPowerMode }: any) => {
        _lowPower = !!lowPowerMode;
        _recompute();
      });
    } catch {}
  } catch {
    // Any failure → remain "premium" (full fidelity). Never degrade on an error.
    _mode = "premium";
  }
}

/** Sync read for non-React call sites (the rAF camera loop, GPS config, etc.).
 *  Settings → Driving → Battery Saver forces "eco" regardless of charge state. */
export function getPowerMode(): PowerMode {
  try { if (getSettings().powerProfile === "eco") return "eco"; } catch {}
  return _mode;
}

/** Reactive read for components. Kicks off startPowerMode() on first use.
 *  Reacts to BOTH charge-state changes and the Battery Saver setting. */
export function usePowerMode(): PowerMode {
  const [m, setM] = useState<PowerMode>(_mode);
  const [s] = useSettings(); // re-renders consumers when Battery Saver flips
  useEffect(() => {
    setM(_mode); // sync to any value resolved before mount
    _listeners.add(setM);
    void startPowerMode();
    return () => { _listeners.delete(setM); };
  }, []);
  return s.powerProfile === "eco" ? "eco" : m;
}
