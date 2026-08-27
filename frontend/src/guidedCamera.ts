// guidedCamera.ts — is the guided viewfinder available on THIS binary?
//
// ── ⛔ THE OTA TRAP THIS EXISTS TO SURVIVE ──────────────────────────────────────
// expo-camera and expo-sensors were added for BUILD 74. Build 73 does not contain
// either native module — and an OTA reaches BOTH builds.
//
// `expo-camera/build/ExpoCameraManager.js` line 2 is:
//     export default requireNativeModule('ExpoCamera');
// which runs at MODULE LOAD and THROWS when the native side is absent. So a bare
//     import { CameraView } from "expo-camera"
// anywhere in the bundle is a JS fatal on build 73 the moment that module is first
// evaluated. And a JS fatal is not a contained failure here: it trips expo-updates'
// ErrorRecovery, which ROLLS THE WHOLE BUNDLE BACK to the embedded one. That is the
// documented "tweaks only work after a fresh install" loop. Shipping a static import
// would therefore not merely break the camera on 73 — it would strand every tester
// on 73 on a stale bundle, for every future OTA, including ones unrelated to this.
//
// So the rule for this feature is absolute:
//   NEVER `import` expo-camera or expo-sensors at module scope, anywhere.
//   Go through loadGuidedCamera() / loadDeviceMotion(), which probe FIRST with
//   requireOptionalNativeModule (returns null instead of throwing) and only then
//   require() the library.
//
// Callers fall back to the expo-image-picker path, which works on every build and
// is what shipped in 73.
//
// The bail reason is logged because a silent "no viewfinder" is indistinguishable
// from "the viewfinder is broken" — the same lesson carPlayBootstrap learned the
// expensive way (see its header).

import { requireOptionalNativeModule } from "expo-modules-core";
import { logEvent } from "./crashBreadcrumb";

type Loaded<T> = { checked: boolean; mod: T | null };

const _camera: Loaded<any> = { checked: false, mod: null };
const _motion: Loaded<any> = { checked: false, mod: null };

function probe<T>(
  slot: Loaded<T>,
  nativeName: string,
  packageName: string,
  load: () => any,
  pick: (lib: any) => T | null,
): T | null {
  if (slot.checked) return slot.mod;
  slot.checked = true;
  try {
    if (!requireOptionalNativeModule(nativeName)) {
      // The expected state on build 73 and every earlier binary. One row, once per
      // launch — this is not an error, it is the fallback path doing its job.
      try { logEvent(`guided-cam skip pkg=${packageName} why=no-native-module`); } catch {}
      return (slot.mod = null);
    }
    // `load` closes over a LITERAL require. Metro rejects require(variable) — it needs
    // static strings to build the dependency graph — so the call sites below each pass
    // their own thunk. This still gives us what the guard needs: Metro's CommonJS
    // runtime evaluates a module the first time require() is CALLED, not when it is
    // bundled, so on a binary without the native module we return above and
    // ExpoCameraManager.js is never evaluated and never throws.
    const lib = load();
    const picked = pick(lib);
    if (!picked) {
      try { logEvent(`guided-cam skip pkg=${packageName} why=missing-export`); } catch {}
      return (slot.mod = null);
    }
    slot.mod = picked;
  } catch (e) {
    // A load() that throws despite a present native module means the JS half is
    // broken — worth a row, and still a clean fallback rather than a crash.
    try {
      logEvent(`guided-cam skip pkg=${packageName} why=require-threw ${String((e as any)?.message ?? e).slice(0, 100)}`);
    } catch {}
    slot.mod = null;
  }
  return slot.mod;
}

/** The expo-camera module, or null on a binary without it (e.g. build 73). */
export function loadGuidedCamera(): any | null {
  return probe(
    _camera, "ExpoCamera", "expo-camera",
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    () => require("expo-camera"),
    (lib) => (lib?.CameraView && lib?.useCameraPermissions ? lib : null),
  );
}

/** expo-sensors' DeviceMotion, or null. The level indicator degrades to hidden. */
export function loadDeviceMotion(): any | null {
  return probe(
    _motion, "ExponentDeviceMotion", "expo-sensors",
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    () => require("expo-sensors"),
    (lib) => (lib?.DeviceMotion?.addListener ? lib.DeviceMotion : null),
  );
}

/**
 * Can this build show the guided viewfinder at all? The camera is the hard
 * requirement; DeviceMotion is optional (no level bubble, manual shutter still
 * works), so it is deliberately NOT part of this test.
 */
export function guidedCameraAvailable(): boolean {
  return loadGuidedCamera() !== null;
}
