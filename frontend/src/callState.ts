// callState.ts — "is the user on a phone call?" signal, used to duck Nova so she
// isn't loud over a call (across multiple callouts in one call).
//
// Detecting a call needs NATIVE code — no JS/Expo API exists. The local Expo
// module `ConvoyCallDetector` (modules/convoy-call-detector) exposes a SYNC
// `isOnCall()` (iOS CXCallObserver — no entitlement; Android AudioManager call
// mode — no permission). `requireOptionalNativeModule` returns null on any build
// WITHOUT the module (e.g. existing 1.1.11 builds that only got this over OTA),
// so this safely returns false there and lights up on builds that bundle it.
import { requireOptionalNativeModule } from "expo-modules-core";

let Native: any = null;
try { Native = requireOptionalNativeModule("ConvoyCallDetector"); } catch { Native = null; }

/** True while a phone call is active. Inert (false) on builds without the native module. */
export function isOnCall(): boolean {
  if (!Native || typeof Native.isOnCall !== "function") return false;
  try { return !!Native.isOnCall(); } catch { return false; }
}

/** Kept for call-site compatibility — detection is query-based, no init needed. */
export function initCallDetection(): void { /* no-op */ }
