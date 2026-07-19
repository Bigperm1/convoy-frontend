# Android Auto bridgeless port — build-67 patch recipe

**Status:** STAGED (not yet applied). Native change → build 67. Needs a compile + DHU/head-unit test.
**Confirmed 2026-07-18:** Android tester (build 66) sees "Hairpin has encountered an unexpected error / Exit" when launching Hairpin on the head unit. Discoverability is already solved (Play install lists it).

## Root cause (verified in node_modules source)

`react-native-carplay@2.4.1-beta.0`'s Android runtime uses legacy Paper-bridge APIs that don't exist under RN 0.81 **bridgeless** (Expo SDK 54, `newArchEnabled=true`). The crash is a **native Kotlin `UninitializedPropertyAccessException`/`UnsupportedOperationException` before any JS runs** (so there is no `crash_reports` breadcrumb):

- `CarPlayService.onCreate()` → `(application as ReactApplication).reactNativeHost.reactInstanceManager` — `reactNativeHost` is deprecated in New Arch and there is **no `ReactInstanceManager`**, so this throws. The exception escapes `onCreate` → `CarAppService` fails → androidx shows the error card. **This is the exact crash.**
- `CarPlaySession.invokeStartTask()` → `reactContext.catalystInstance.getJSModule(AppRegistry)` — no `catalystInstance` in bridgeless.
- `VirtualRenderer.MapPresentation` → same `reactInstanceManager` line + `ReactRootView.startReactApplication` (Paper renderer).

The existing patch (`react-native-carplay+2.4.1-beta.0.patch`) only did Kotlin null-safety — it does NOT touch bridgeless.

## Canonical reference

- **`@iternio/react-native-auto-play` (Iternio-Planning-AB/react-native-auto-play, npm v0.5.8, pushed 2026-07-17)** — a from-scratch New-Architecture rewrite of this library. Mirror its `AndroidAutoService.kt` / `AndroidAutoSession.kt` / `VirtualRenderer.kt`. (It's Nitro-based, so it fetches context via `NitroModules.applicationContext`; for our non-Nitro port substitute `(application as ReactApplication).reactHost`.)
- birkir/react-native-carplay upstream has **no** bridgeless fix (issue #240 reports this exact failure, unanswered). The `@g4rb4g3` fork is still old-arch. Do not expect a drop-in.

## Verified API mapping (RN 0.81, all confirmed present on disk)

| Old (Paper) | New (bridgeless) |
|---|---|
| `application.reactNativeHost.reactInstanceManager` | `(application as ReactApplication).reactHost` — `ReactHost?`, **non-null under Expo** (ExpoReactHostFactory), a cached app-wide singleton shared with MainActivity. NEVER `!!` blindly; elvis-throw. |
| `reactInstanceManager.createReactContextInBackground()` | `reactHost.start()` : `TaskInterface<Void>` — **must post to the main looper** |
| `reactInstanceManager.currentReactContext` | `reactHost.currentReactContext` : `ReactContext?` (null until init) |
| `ReactInstanceManager.ReactInstanceEventListener` (nested) | `com.facebook.react.ReactInstanceEventListener` (top-level), `onReactContextInitialized(ctx)` on UI thread; `reactHost.add/removeReactInstanceEventListener(...)` |
| `reactContext.catalystInstance.getJSModule(AppRegistry)` | drop `catalystInstance`; `reactContext.getJSModule(AppRegistry::class.java)` works via the bridgeless proxy (discouraged — prefer a surface) |
| `reactContext.getNativeModule(CarPlayModule)` | unchanged (works on bridgeless ReactContext) — resolve via `reactHost.currentReactContext?.getNativeModule(...)` |
| `ReactRootView(ctx).startReactApplication(instanceManager, moduleName)` | a **ReactSurface** — see VirtualRenderer below |

Context source: from `CarAppService` use `application`; from `android.app.Presentation` the ctor context is a display context — use `context.applicationContext as? ReactApplication` (defensive cast, elvis-throw).

## The three files

### 1. `CarPlayService.kt` — stop resolving the instance manager in `onCreate`
Remove the `reactInstanceManager` field and the `onCreate` assignment entirely (Iternio's `onCreate` doesn't touch the host). `onCreateSession` returns `CarPlaySession(sessionInfo)` — no manager arg. If a lifecycle listener is needed, register it on `(application as ReactApplication).reactHost?.currentReactContext` once available.

### 2. `CarPlaySession.kt` — ReactHost, no catalystInstance
- Get `val reactHost = (carContext.applicationContext as? ReactApplication)?.reactHost ?: throw IllegalStateException(...)`.
- `runJsApplication`: if `reactHost.currentReactContext == null`, `reactHost.addReactInstanceEventListener(object : ReactInstanceEventListener { override fun onReactContextInitialized(ctx: ReactContext) { invokeStartTask(ctx); reactHost.removeReactInstanceEventListener(this) } })` then `reactHost.start()` (on main looper); else `invokeStartTask(currentReactContext)`.
- `invokeStartTask`: drop `catalystInstance`. For a template screen that still needs it, `reactContext.getJSModule(AppRegistry::class.java)?.runApplication("AndroidAuto", params)`. **⚠ review-flagged:** under Fabric, `runApplication` with an unregistered `rootTag=1` may throw "surface not registered" on cold boot — prefer booting the root via the surface (VirtualRenderer) and keep this only if a non-surface template needs it. Resolve `CarPlayModule` via `reactHost.currentReactContext?.getNativeModule(...)` and `setCarContext(carContext, screen)`.

### 3. `VirtualRenderer.kt` (`MapPresentation`) — Fabric surface, themed context, screen-off fix
Follow Iternio's `FabricMapPresentation`:
- `val reactHost = (context.applicationContext as ReactApplication).reactHost!!` ; `val reactContext = reactHost.currentReactContext`.
- `val fabricUiManager = UIManagerHelper.getUIManager(reactContext, UIManagerType.FABRIC) as FabricUIManager`.
- **Wrap the context:** `val themed = ContextThemeWrapper(context.applicationContext, <appTheme>)` — REQUIRED so RN/AppCompat views resolve attrs on a bare VirtualDisplay context (otherwise the map renders **black**).
- `val surface = ReactSurfaceImpl(themed, moduleName, initialProps)` ; `val surfaceView = ReactSurfaceView(themed, surface)`.
- `fabricUiManager.startSurface(surfaceView, moduleName, Arguments.fromBundle(initialProps), MeasureSpec.makeMeasureSpec(w, EXACTLY), MeasureSpec.makeMeasureSpec(h, EXACTLY))`.
- **Screen-off mitigation (critical — Convoy's known freeze):** after startSurface, `reactContext.removeLifecycleEventListener(fabricUiManager)` then `fabricUiManager.onHostResume()` so the AA map keeps advancing frames when the phone screen is off.
- `setContentView(FrameLayout containing surfaceView)`.
- (Simpler alt for non-map surfaces: `reactHost.createSurface(themed, moduleName, initialProps)` + `surface.start()` + `setContentView(surface.view)`. The map surface needs the VirtualDisplay path above.)

Imports: `com.facebook.react.runtime.ReactSurfaceImpl`, `.ReactSurfaceView`, `com.facebook.react.fabric.FabricUIManager`, `com.facebook.react.uimanager.UIManagerHelper`, `com.facebook.react.uimanager.common.UIManagerType`, `com.facebook.react.bridge.Arguments`, `androidx.appcompat.view.ContextThemeWrapper`.

## Apply + verify (build-67 batch)

```bash
cd /Users/jeffmorton/convoy-frontend/frontend
# 1. edit the 3 files under node_modules/react-native-carplay/android/.../org/birkir/carplay/
# 2. regenerate the patch so it survives install / EAS prebuild:
npx patch-package react-native-carplay          # updates patches/react-native-carplay+2.4.1-beta.0.patch
git add patches/react-native-carplay+2.4.1-beta.0.patch && git commit   # MUST commit the patch
# 3. confirm no dead APIs remain:
grep -rn 'reactNativeHost\|reactInstanceManager\|catalystInstance\|ReactRootView' \
  node_modules/react-native-carplay/android/src/main/java/org/birkir/carplay   # expect nothing
# 4. compile-check (no head unit needed):
npx expo prebuild -p android && (cd android && ./gradlew :app:compileReleaseKotlin)
# 5. NATIVE build both platforms (bump runtimeVersion per CLAUDE.md) — NOT an OTA.
# 6. DHU/head-unit: launch under Android Auto (~/Library/Android/sdk/extras/google/auto/desktop-head-unit)
#    → no "unexpected error", map surface renders, screen-off keeps updating, templates respond to touch.
```

## Open risks to check on the head unit
1. **Cold boot** (phone app never opened): `currentReactContext` null → deferred `start()`+listener path is the untested case.
2. **Cold-boot AppRegistry.runApplication(rootTag=1)** may throw "surface not registered" under Fabric — prefer the surface boot.
3. **initialProps:** pass an empty `Bundle` (not `null`) if the AndroidAuto/map JS reads props as a non-null object.
4. **Screen-off:** if the map still freezes, the `removeLifecycleEventListener + onHostResume` mitigation is the lever.

Full verified API facts + adversarial review: workflow `wf_c7773161-6a0` (this session). See [[android-auto-deep-dive]], [[build-67-backlog]], [[carplay-standalone-plan]].
