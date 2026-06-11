// JS entry for the local module. callState.ts accesses the native module by name
// via requireOptionalNativeModule (null-safe), so this is just a convenience
// re-export for anyone importing the module directly.
import { requireOptionalNativeModule } from "expo-modules-core";

const ConvoyCallDetector = requireOptionalNativeModule("ConvoyCallDetector");

export function isOnCall(): boolean {
  try { return !!ConvoyCallDetector?.isOnCall?.(); } catch { return false; }
}

export default ConvoyCallDetector;
