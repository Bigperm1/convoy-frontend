// callState.ts — "is the user on a phone call?" signal, used to duck Nova so she
// isn't loud over a call (even across multiple callouts in one call).
//
// There is NO JS/Expo API to detect an active phone call — it needs NATIVE code
// (iOS CallKit `CXCallObserver`, Android `TelephonyManager` PhoneStateListener).
// A small native module (added in a dev build — `ConvoyCallDetector`, emitting a
// `callStateChanged` event with `{ active: boolean }`) feeds this flag. Until
// that module ships, this stays INERT (always "not on a call"), so the ducking
// in nav.ts can be wired and OTA'd ahead of the native build with zero behavior
// change on current builds. Loaded lazily, mirroring how CarPlay is gated.
import { NativeModules, NativeEventEmitter, Platform } from "react-native";

let _onCall = false;

/** True while a phone call is active (per the native detector). */
export function isOnCall(): boolean { return _onCall; }

/** Set by the native call detector (or tests). */
export function setOnCall(active: boolean): void { _onCall = !!active; }

let _inited = false;

/** Subscribe to the native call detector if this build has it; no-op otherwise. */
export function initCallDetection(): void {
  if (_inited || Platform.OS === "web") return;
  _inited = true;
  try {
    const mod: any = (NativeModules as any).ConvoyCallDetector;
    if (!mod) return; // native module not in this build yet — stays inert
    const emitter = new NativeEventEmitter(mod);
    emitter.addListener("callStateChanged", (e: any) => setOnCall(!!e?.active));
    mod.start?.();
  } catch {
    // Any failure (no module, bad emitter) → stay inert, never crash startup.
  }
}
