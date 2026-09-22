# Build 80 — the CarPlay-first phone scene (black phone UI while CarPlay works)

**Status: STAGED, NOT APPLIED.** Nothing in `plugins/withConvoyCarPlay.js`, `ios/`, or `src/` was
modified by this write-up. Jeff, 2026-09-21: *"Yes build them and stage 2 for 80."* This is a
**NATIVE** change (scene delegates generated at prebuild) — **it cannot ship by OTA**; it lands only
when build 80 is cut, on both platforms at the same build number and the same bumped
`runtimeVersion` (CLAUDE.md § Release Discipline).

Nav lock: `plugins/withConvoyCarPlay.js` and `src/crashBreadcrumb.ts` are **not** in
`tools/sim-qc/data/nav-lock.json` (43 locked files, checked 2026-09-21) — the patch below moves
**zero** locks. The gate currently fails on `src/nav.ts`, `src/departureBearing.ts` and
`app/(app)/map.tsx#map-plot-depart-facing-pick`; those three were already modified in the working
tree before this task and belong to the other work in this batch, not to this document.

---

## 1. The symptom, with receipts

Jeff and Olaf, 2026-09-21: the **entire phone UI black** — no map, no search bar, no tab bar —
while the app kept running and logging and **CarPlay worked perfectly**. Alfred's standing
"complete black screen. Need to force close and open again" is the same report.

Everything below is a query against `crash_reports` (Supabase `pgtbjiszjglznjagolse`), run
2026-09-21. **VERIFIED**, not inferred.

### Jeff's three sessions today — one of them is CarPlay-first, and it is the sick one

| instance | first row | `carplay-onconnect` | first `surf=phone` |
|---|---|---|---|
| `4sybba-405308` | 14:03:25.317 | 14:08:57.628 (+5 m 32 s) | 14:03:25.467 (+0.15 s) |
| `haej1a-224727` | 16:30:24.739 | 16:32:58.738 (+2 m 34 s) | 16:30:24.985 (+0.25 s) |
| **`tukeja-373480`** | **19:19:33.496** (`js-mark`) | **19:19:33.498 (+2 ms)** | **19:31:01.818 (+11 m 28 s)** |

### What the phone scene was doing during those 11 minutes

`ps` = the most-foreground non-CarPlay `UIWindowScene`'s `activationState`
(`modules/hairpin-system/ios/HairpinTimerPump.mm:241` `HPSamplePhoneScene`, min over scenes;
`-1` = none/unattached). `ps` is resampled on every scene notification **and every 60 car frames**,
so these are live reads, not stale ones. The expo-location patch reports the same thing as `ps=-2`
for "no such scene" (`patches/expo-location+19.0.8.patch`, `hairpinSceneState`).

```
19:19:33.496  js-mark                                        ← process start (CarPlay woke it)
19:19:33.498  carplay-onconnect conn=1
19:19:33.744  loc-auth   ... ps=-2 cs=0                      ← NO phone window scene exists
19:20:34      timer-pump ... main=3677 as=0 cs=0 pd=1 ps=2   ← a phone scene now exists, .background
19:25:04 … 19:30:06   ps=2 on every sample, main 3178–4433/min, pd=1 (unlocked)
19:24:12.118  loc-bgsess ... uiapp=2 ps=2 cs=2 app=background
19:31:01.818  cam-mode surf=phone …                          ← the phone surface renders, at last
19:31:06      timer-pump ... ps=0                            ← the first sample that reads foreground
```

Olaf, `bj3an7-985962`, same shape and far worse: `carplay-onconnect` 18:39:45.987 (0 ms after the
first row), `ps=-2` at 18:39:46.4, `ps=2` by 18:48:34, **first `surf=phone` 19:59:59.722 — 80
minutes later** — and then five relaunches in two and a half minutes
(`9dc9qz` 20:05:10, `60rqan` 20:05:23, `njsxm7` 20:05:31, `kc5z6m` 20:05:41, `7c56ul` 20:07:26).

### Fleet shape, 30 days, iOS sessions longer than a minute

| runtime | launch | sessions | phone surface ≤5 s | only after 60 s | never (session >5 min) |
|---|---|---|---|---|---|
| 1.29.0 | CarPlay-first | 19 | 7 | 4 | **3** |
| 1.29.0 | phone-first | 38 | 32 | 4 | 2 |
| 1.28.0 | CarPlay-first | 44 | 19 | 11 | **6** |
| 1.28.0 | phone-first | 67 | 63 | 0 | 2 |
| 1.27.0 | CarPlay-first | 50 | 10 | 20 | 2 |
| 1.27.0 | phone-first | 204 | 195 | 6 | 0 |

Confirms the architect's call: **not a regression from this week's OTAs.** It is worst on
CarPlay-first launches and it goes back at least to 1.25.0.

### ⚠ One correction to the working signature

`ps=2` **with `main > 1000` is not pathological by itself** — it is the ordinary "phone in the
driver's pocket while the display is on" state, and it appears in healthy sessions too
(`4sybba-405308` runs `ps=2` from 14:16 to 15:18 with the phone fine). Counted over three days,
every tester has more `ps=2` rows than `ps=0` rows. What separates the sick sessions is
**CarPlay-first boot + the phone scene never reaching `ps=0`** for minutes on end. And the
telemetry still cannot tell "the driver looked at a black app" from "the driver never picked the
phone up" — *that* is the gap § 4 closes.

---

## 2. How the phone window is created on a CarPlay-first launch

All line numbers are `plugins/withConvoyCarPlay.js` (the generated
`ios/Hairpin/PhoneSceneDelegate.swift` and `ios/Hairpin/CarSceneDelegate.swift` are
**byte-identical** to the plugin's template strings — diffed 2026-09-21; the only difference is the
escaped backtick in a comment).

1. **`AppDelegate.didFinishLaunching`** creates the factory and returns. It creates **no window** —
   the plugin deletes that block (`:1242-1245`, generated `ios/Hairpin/AppDelegate.swift:25`).
2. **`application(_:configurationForConnecting:options:)`** (`:1140-1153`) routes
   `.carTemplateApplication` → `CarSceneDelegate`, **everything else** → `PhoneSceneDelegate`.
3. CarPlay connects first. `CarSceneDelegate.templateApplicationScene(_:didConnect:to:)`
   (`:1032`) calls `ConvoyRNHost.mount(moduleName: "ConvoyCarSurface", …, makeVisible: false)`
   (`:1054`).
4. `mount`'s `!started` + `!makeVisible` branch (`:556-702`) boots the host on a **detached**
   `bootWindow` (`:575-577`), then polls until expo-updates has created the host
   (`mountCarWhenHostReady`, `:675-701`) and mints the car surface. `retireBootWindow()` hides the
   boot window (`:682`).
5. **Later, the phone's window-application scene connects.** `PhoneSceneDelegate.scene(_:willConnectTo:)`
   (`:64-91`) builds `UIWindow(windowScene:)` and calls
   `ConvoyRNHost.mount(moduleName: "main", in: window, …, makeVisible: true)` (`:90`).
6. `started` is already `true`, so control reaches the **second-surface** branch (`:705-831`):
   * host ready → `mintSecondSurface(false)` **synchronously** (`:805-808`);
   * host not ready → a **black placeholder VC** goes in, `window.isHidden = false` **without**
     `makeKey` (`:824-828`), and `whenHostReady` mints later (`:830`).
7. `mintSecondSurface`'s phone branch (`:764-784`): writes the `convoy.phone.hostWait.v1` marker
   (deferred case only), hosts `main` in a `ConvoyPhoneRootViewController`, then
   **`window.makeKeyAndVisible()` (`:783`)** and `armPhoneRepaints(in: window)` (`:784`).

### Where it ends up in a scene iOS never presents

Three facts, all read straight from the file:

* **`PhoneSceneDelegate` implements `scene(_:willConnectTo:)` and nothing else** (`:64-91` is the
  whole class). No `sceneDidBecomeActive`, no `sceneWillEnterForeground`, no `sceneDidDisconnect`.
  **Whatever the window holds at CONNECT is what the driver gets for the life of the process.**
  The car scene, by contrast, has had `sceneDidBecomeActive` / `sceneWillEnterForeground` and
  `recoverCarPlayIfNeeded` since 2026-07-25 (`:1093-1129`) — that recovery is the only reason a
  crash-restarted head unit ever comes back.
* **The phone rescue disarms itself in the background.**
  `ConvoyPhoneRootViewController.viewDidLayoutSubviews` (`:993-1001`) latches
  `ConvoyRNHost.phonePainted = true` as soon as `view.bounds` is non-zero (`:1000`) — and a
  **background** scene's window is laid out at full size within one runloop turn. So on a
  CarPlay-first launch the 2 s rescue tick (`:483-502`) sees `phonePainted == true` on its first
  pass and returns for good, ~2 s into a 34 s budget, with nothing ever on screen.
* **We make a background scene's window key** (`:783`). That buys nothing while iOS is not
  presenting the scene, and it hands expo-updates' `getWindow()` (`keyWindow ?? appDelegate.window`)
  one more way to pick the wrong window — the exact mechanism behind Alfred's
  "phone drew the CarPlay dashboard" launches that build 79 fixed from the other side.

Plus one hardening gap found while reading, unrelated to today's black screen but in the same
method: `configurationForConnecting` sends **every** non-CarPlay role to `PhoneSceneDelegate`,
including `.windowExternalDisplayNonInteractive`. Such a session would reach `mount` with
`started == true` and mint a **second `"main"`** — two app trees in one process, the presence
double-join class that `mount`'s own note warns about (`:809-815`).

### Mechanism, in three sentences

On a CarPlay-first launch the phone's window-application scene connects **while it is in
`.background`**, and `PhoneSceneDelegate` mounts the whole `"main"` surface into it there and makes
that window key. The only self-heal the phone has — `armPhoneRepaints` — is immediately disarmed,
because `ConvoyPhoneRootViewController` latches `phonePainted` on the first non-zero layout, which a
background scene performs within one runloop turn. Nothing in the app ever looks at that window
again: there is no `sceneDidBecomeActive` on the phone side, so when the driver finally opens the
app there is no code path that keys the window, forces a Fabric commit, or re-mints — which is why
the only recovery anyone has found is a force-quit.

---

## 3. The proposed patch

Four edits to `plugins/withConvoyCarPlay.js` plus one reporter in `src/crashBreadcrumb.ts`.
**Written, not compiled** — see § 5.

### 3.1 `PhoneSceneDelegate` gets the lifecycle it never had

```diff
--- a/plugins/withConvoyCarPlay.js
+++ b/plugins/withConvoyCarPlay.js
@@ -64,16 +64,23 @@ class PhoneSceneDelegate: UIResponder, UIWindowSceneDelegate {
   func scene(
     _ scene: UIScene,
     willConnectTo session: UISceneSession,
     options connectionOptions: UIScene.ConnectionOptions
   ) {
     guard let windowScene = scene as? UIWindowScene else { return }
+    // BUILD 80 (2026-09-21): only the PHONE role may build the app's window. AppDelegate's
+    // configurationForConnecting routes EVERY non-CarPlay role here, so an external-display
+    // session (.windowExternalDisplayNonInteractive — AirPlay, a dock, a unit that mirrors)
+    // would reach mount() with started == true and mint a SECOND "main": two app trees in one
+    // process, the presence double-join class mount's own double-"main" note warns about.
+    guard session.role == .windowApplication else { return }
     guard let appDelegate = UIApplication.shared.delegate as? AppDelegate else { return }
     let window = UIWindow(windowScene: windowScene)
     self.window = window
+    ConvoyRNHost.notePhoneScene("connect", window: window, did: "-")
     // BUILD 79 (2026-09-13): appDelegate.window is NO LONGER assigned here. […unchanged…]
     ConvoyRNHost.mount(moduleName: "main", in: window, appDelegate: appDelegate, makeVisible: true)
   }
+
+  // BUILD 80 (2026-09-21): the phone scene's ACTIVATION is the first moment the driver can
+  // actually be looking at this window, and until now nothing in the app ran at that moment —
+  // scene(_:willConnectTo:) was the entire class. On a CarPlay-first launch the connect happens
+  // while the scene is .background (Jeff tukeja-373480, 09-21: ps=2 at every 1 s sample from
+  // 19:20:34 to 19:30:06, first `cam-mode surf=phone` 19:31:01 in the same sample that first
+  // read ps=0; Olaf bj3an7-985962 the same shape, 80 minutes). This is the phone's version of
+  // the car's recoverCarPlayIfNeeded — which is the reason a crash-restarted head unit comes
+  // back — and it acts at most once per process, only on evidence (see adoptPhoneWindow).
+  func sceneDidBecomeActive(_ scene: UIScene) { adopt("active") }
+  func sceneWillEnterForeground(_ scene: UIScene) { adopt("fg") }
+  func sceneDidEnterBackground(_ scene: UIScene) {
+    ConvoyRNHost.notePhoneScene("bg", window: window, did: "-")
+  }
+  func sceneDidDisconnect(_ scene: UIScene) {
+    ConvoyRNHost.notePhoneScene("disc", window: window, did: "-")
+    // The VC (and with it the surface, stopped on dealloc) dies with this window; a stale ref
+    // would let the repaint tick and the adopt path act on a window nobody can see.
+    if ConvoyRNHost.phoneWindowRef === window { ConvoyRNHost.phoneWindowRef = nil }
+    ConvoyRNHost.phoneRepaintBudget = 0
+  }
+
+  private func adopt(_ why: String) {
+    guard let window = window,
+          let appDelegate = UIApplication.shared.delegate as? AppDelegate else { return }
+    ConvoyRNHost.adoptPhoneWindow(window, appDelegate: appDelegate, why: why)
+  }
 }
```

### 3.2 `ConvoyRNHost` — the receipt and the adoption (insert after `:188`)

```diff
--- a/plugins/withConvoyCarPlay.js
+++ b/plugins/withConvoyCarPlay.js
@@ -188,6 +188,116 @@ enum ConvoyRNHost {
   static var phonePainted = false
 
+  // ── BUILD 80 (2026-09-21): PHONE SCENE RECEIPT + ADOPTION ───────────────────────────────
+  // Measured before it was written. Jeff's CarPlay-first launch tukeja-373480 (crash_reports):
+  // js-mark 19:19:33.496 and carplay-onconnect 19:19:33.498 — 2 ms apart, the car booted the
+  // process — expo-location's read says ps=-2 (no window-application scene) at 19:19:33.744, the
+  // timer-pump sample at 19:20:34 reads ps=2 and so does every sample until 19:30:06, and the
+  // first `cam-mode surf=phone` row is 19:31:01.818, in the same minute ps first reads 0.
+  // Olaf bj3an7-985962: the same shape for 80 minutes, then five relaunches in 2.5 minutes.
+  static let processStart = Date()      // lazily stamped by the FIRST scene to connect
+  static var phoneAdopted = false       // the belt fires at most once per process
+  static var phoneSceneEvents: [[String: Any]] = []
+  static var phoneSceneCount = 0
+  static let PHONE_SCENE_KEY = "convoy.phone.scene.v1"
+  static let PHONE_SCENE_MAX_EVENTS = 8
+
+  static func phoneSceneIsForeground(_ window: UIWindow?) -> Bool {
+    return window?.windowScene?.activationState == .foregroundActive
+  }
+
+  // One App Group record per launch, appended to and rewritten on every event, because the
+  // process that has the black phone is exactly the process that will not restart JS to report
+  // itself. src/crashBreadcrumb.ts reportCarPlayPhoneScene reports and clears it on the NEXT
+  // boot — the diagnose-from-the-following-launch trick (d1cae98), and a driver staring at a
+  // black screen force-quits, so the next boot is never far away.
+  static func notePhoneScene(_ event: String, window: UIWindow?, did: String) {
+    let row: [String: Any] = [
+      "e": event,
+      "ms": Int(Date().timeIntervalSince(processStart) * 1000),
+      "st": window?.windowScene?.activationState.rawValue ?? -2,   // -2 = no scene
+      "key": (window?.isKeyWindow ?? false) ? 1 : 0,
+      "hid": (window?.isHidden ?? true) ? 1 : 0,
+      "root": window?.rootViewController.map { String(describing: type(of: $0)) } ?? "nil",
+      "did": did,
+    ]
+    NSLog("[Convoy] phone scene: %@", String(describing: row))
+    phoneSceneCount += 1
+    // Bounded: a scene that flaps all drive long must not grow this record without limit. The
+    // count keeps counting after the array stops, so `n` never lies about what happened.
+    if phoneSceneEvents.count < PHONE_SCENE_MAX_EVENTS { phoneSceneEvents.append(row) }
+    var d: [String: Any] = [
+      "ev": phoneSceneEvents, "n": phoneSceneCount, "ts": Date().timeIntervalSince1970 * 1000,
+    ]
+    if let car = carConnectAt { d["carMs"] = Int(car.timeIntervalSince(processStart) * 1000) }
+    guard JSONSerialization.isValidJSONObject(d),
+          let data = try? JSONSerialization.data(withJSONObject: d),
+          let json = String(data: data, encoding: .utf8),
+          let defaults = UserDefaults(suiteName: DIAG_SUITE) else { return }
+    defaults.set(json, forKey: PHONE_SCENE_KEY)
+  }
+
+  // Runs on EVERY phone-scene activation; acts at most once per process, and only on evidence.
+  // A normal phone-first launch arrives here with Expo's own root VC in a key, visible window
+  // whose scene is foregroundActive: did = "none", nothing is touched, and the row still proves
+  // the path ran — absence is not evidence (RULES.md).
+  static func adoptPhoneWindow(_ window: UIWindow, appDelegate: AppDelegate, why: String) {
+    var did = "none"
+    if !phoneAdopted {
+      if window.rootViewController == nil {
+        // Nothing was ever hosted in this scene's window. mount() re-enters its OWN host-ready
+        // gate (the isHostReady/whenHostReady pair below), so this can never superView before
+        // expo-updates has made the host — the act that pinned three testers to the embedded
+        // bundle on 2026-09-02. It also cannot double-mint: a window with any root at all
+        // (including the black wait VC) skips this branch.
+        did = "mount"
+        phoneAdopted = true
+        mount(moduleName: "main", in: window, appDelegate: appDelegate, makeVisible: true)
+      } else if window.isHidden || !window.isKeyWindow {
+        // The mint deliberately leaves a BACKGROUND scene's window unkeyed (see
+        // mintSecondSurface). The scene is foreground now, so this is the moment to key it.
+        did = "key"
+        phoneAdopted = true
+        window.makeKeyAndVisible()
+      }
+    }
+    if let vc = window.rootViewController as? ConvoyPhoneRootViewController, !phonePainted {
+      // A surface minted while the scene was .background can hold a mounted-but-never-committed
+      // Fabric tree — the phone twin of the car's "logo until foreground" class. Same primitive
+      // the car window uses (RCTFabricSurface.synchronouslyWaitFor), once, now that a frame can
+      // actually land.
+      did = did == "none" ? "commit" : did + "+commit"
+      phoneAdopted = true
+      armPhoneRepaints(in: window)
+      // FOUR attempts, not thirty: unlike the car's stateless dashboard, a re-mint costs the
+      // driver their app and nav state, and here they are LOOKING at the screen while it
+      // happens. armPhoneRepaints' 30 is sized for a surface nobody is watching yet.
+      phoneRepaintBudget = 4
+      vc.forcePhoneCommit()
+    }
+    notePhoneScene(why, window: window, did: did)
+  }
+
```

### 3.3 Don't key a window in a scene iOS is not presenting; don't re-mint into one

```diff
@@ -483,10 +483,15 @@ static func schedulePhoneRepaintTick() {
   static func schedulePhoneRepaintTick() {
     DispatchQueue.main.asyncAfter(deadline: .now() + 2.0) {
       […unchanged comment…]
       let hijacked = !(phoneWindowRef?.rootViewController is ConvoyPhoneRootViewController)
+      // BUILD 80 (2026-09-21): never re-mint the full app tree into a scene iOS is not
+      // presenting. A background re-mint cannot commit a frame, so all thirty attempts would
+      // burn — and the 34 s deadline expire — while the driver still sees nothing. The
+      // activation path re-arms this loop instead (PhoneSceneDelegate → adoptPhoneWindow).
+      guard phoneSceneIsForeground(phoneWindowRef) else { return }
       guard phoneWindowRef != nil, (!phonePainted || hijacked), let t0 = phoneConnectAt,
             Date().timeIntervalSince(t0) < 34.0 else { return }
 
@@ -780,8 +785,20 @@ let mintSecondSurface: (Bool) -> Void = { [weak window] deferred in
         viewController.view.frame = window.bounds
         viewController.view.setNeedsLayout()
         viewController.view.layoutIfNeeded()
-        window.makeKeyAndVisible()
-        armPhoneRepaints(in: window)
+        // BUILD 80 (2026-09-21): key it only when the scene is actually foreground. On a
+        // CarPlay-first launch this branch runs while the phone scene is .background (Jeff
+        // tukeja-373480: ps=2 at every 1 s sample, 19:20:34 → 19:30:06), and a KEY window in a
+        // scene iOS is not presenting buys nothing while giving expo-updates' getWindow()
+        // (keyWindow ?? appDelegate.window) one more way to choose the wrong window — the
+        // mechanism behind Alfred's "phone drew the CarPlay dashboard" launches. Visible now,
+        // key at the first activation.
+        if ConvoyRNHost.phoneSceneIsForeground(window) {
+          window.makeKeyAndVisible()
+          armPhoneRepaints(in: window)
+        } else {
+          window.isHidden = false
+          ConvoyRNHost.phoneWindowRef = window   // so adoptPhoneWindow can find it
+        }
```

### 3.4 The paint latch must mean "a frame the driver could see"

```diff
@@ -993,9 +993,29 @@ final class ConvoyPhoneRootViewController: UIViewController, ConvoyHostedVC {
   override func viewDidLayoutSubviews() {
     super.viewDidLayoutSubviews()
     if !hosted.bounds.equalTo(view.bounds) { hosted.frame = view.bounds }
     hosted.setNeedsLayout()
     hosted.layoutIfNeeded()
-    // Once the phone surface has a real size, mark it painted so the rescue loop
-    // stops re-minting (don't thrash the full app tree).
-    if view.bounds.width > 0 && view.bounds.height > 0 { ConvoyRNHost.phonePainted = true }
+    // BUILD 80 (2026-09-21): a BACKGROUND scene lays this view out at full size within one
+    // runloop turn, so the old `bounds > 0` latch marked the surface painted ~2 s into a 34 s
+    // rescue on every CarPlay-first launch — with nothing on screen and no path that ever looked
+    // again. Only a FOREGROUND layout counts. (Jeff tukeja-373480, 09-21.)
+    if view.bounds.width > 0, view.bounds.height > 0,
+       ConvoyRNHost.phoneSceneIsForeground(view.window) {
+      ConvoyRNHost.phonePainted = true
+    }
+  }
+
+  // BUILD 80 (2026-09-21): the phone twin of forceCarCommit, called once from
+  // adoptPhoneWindow. Guarded by RCTSurfaceStageIsRunning for the same reason the car is:
+  // synchronouslyWaitFor calls getMountingCoordinator BEFORE its own null check, so an
+  // Unregistered or stopped surface is EXC_BAD_ACCESS (the cold-connect crash guard).
+  func forcePhoneCommit() {
+    if ConvoyRNHost.phonePainted { return }
+    let target = view.bounds
+    guard target.width > 0, target.height > 0 else { return }
+    if !hosted.bounds.equalTo(target) { hosted.frame = target; hosted.setNeedsLayout(); hosted.layoutIfNeeded() }
+    guard let proxy = hosted as? RCTSurfaceHostingProxyRootView else { return }
+    let surface = proxy.surface
+    guard RCTSurfaceStageIsRunning(surface.stage) else { return }
+    surface.setMinimumSize(target.size, maximumSize: target.size)
+    if (surface as AnyObject).synchronouslyWaitFor?(0.3) == true { ConvoyRNHost.phonePainted = true }
   }
```

### 3.5 The JS reporter (`src/crashBreadcrumb.ts`, beside the other three)

```diff
@@ -535,6 +535,7 @@
-  setTimeout(() => { void deliverAndHarvest(); reportCarPlayHostCeiling(); reportCarPlayPhoneHostWait(); reportSiriScout(); reportCarPlayRootWatch(); void reportCarPlayTapTrace(); void reportIosToolchainAndWidgets(); }, DELIVER_DELAY_MS);
+  setTimeout(() => { void deliverAndHarvest(); reportCarPlayHostCeiling(); reportCarPlayPhoneHostWait(); reportCarPlayPhoneScene(); reportSiriScout(); reportCarPlayRootWatch(); void reportCarPlayTapTrace(); void reportIosToolchainAndWidgets(); }, DELIVER_DELAY_MS);

+// BUILD 80 (2026-09-21) — the phone scene's own lifecycle, written by
+// plugins/withConvoyCarPlay.js (ConvoyRNHost.notePhoneScene) and reported here on the NEXT boot.
+// It exists to answer the ONE question the fleet cannot answer today: on a CarPlay-first launch,
+// did the phone's window-application scene ever reach foregroundActive while the driver was
+// looking at a black app? `conn` = ms from the first scene connect to the phone scene's connect,
+// `st` = its activationState right then (2 = background), `act` = ms to its first foregroundActive
+// (-1 = NEVER, which no app-side code can fix — that one goes to Apple), `adopt` = what the
+// build-80 belt actually did (mount / key / commit; "-" = nothing was wrong). Absent before build
+// 80: the key is never written, getSharedDefaults returns null, no rows.
+const CARPLAY_PHONE_SCENE_KEY = "convoy.phone.scene.v1";
+function reportCarPlayPhoneScene(): void {
+  if (Platform.OS !== "ios") return;
+  try {
+    const { HairpinSystem } = require("../modules/hairpin-system");
+    if (!HairpinSystem || typeof HairpinSystem.getSharedDefaults !== "function") return;
+    const raw = HairpinSystem.getSharedDefaults(CARPLAY_DIAG_SUITE, CARPLAY_PHONE_SCENE_KEY);
+    if (!raw) return;
+    let d: any = null;
+    try { d = JSON.parse(String(raw)); } catch {}
+    const ev: any[] = Array.isArray(d?.ev) ? d.ev : [];
+    const conn = ev.find((e) => e?.e === "connect");
+    const act = ev.find((e) => e?.st === 0);
+    const adopt = ev.map((e) => e?.did).filter((x) => x && x !== "-" && x !== "none").join(",");
+    const last = ev.length ? ev[ev.length - 1] : null;
+    const age = d?.ts ? Math.round((Date.now() - Number(d.ts)) / 1000) : -1;
+    logEventReliable(
+      `carplay-phone-scene n=${d?.n ?? "?"} conn=${conn?.ms ?? -1} st=${conn?.st ?? "?"} act=${act?.ms ?? -1}` +
+      ` adopt=${adopt || "-"} key=${last?.key ?? "?"} hid=${last?.hid ?? "?"} root=${String(last?.root ?? "?").slice(0, 32)}` +
+      ` car=${d?.carMs ?? "-"} ev=${ev.map((e) => `${e?.e}:${e?.ms}:${e?.st}`).join("|").slice(0, 120)} ageS=${age}`,
+    );
+    try { HairpinSystem.removeSharedDefaults?.(CARPLAY_DIAG_SUITE, CARPLAY_PHONE_SCENE_KEY); } catch {}
+  } catch {}
+}
```

### What Apple actually guarantees here

* `UISceneDelegate`'s `sceneDidBecomeActive(_:)` / `sceneWillEnterForeground(_:)` /
  `sceneDidEnterBackground(_:)` / `sceneDidDisconnect(_:)` are delivered to the delegate object
  named by `UISceneDelegateClassName`. This is the same contract `CarSceneDelegate` already relies
  on in the field (`:1113-1131`) — the crash-restart recovery is built on it and works.
* `UIWindow.windowScene` and `UIScene.activationState` are public, main-thread reads.
* `makeKeyAndVisible()` on a window that belongs to a foreground scene presents it; that is the
  supported way, and it is what the cold phone boot already does via `startReactNative`.
* **No API can force iOS to activate a scene** on the app's behalf.
  `UIApplication.requestSceneSessionActivation` exists but is an iPad multi-window affordance and
  a background app asking for the foreground is not something iOS grants — it is deliberately NOT
  proposed here.

---

## 4. The receipts, and how to read them

| row | written by | says |
|---|---|---|
| `carplay-phone-scene n= conn= st= act= adopt= key= hid= root= car= ev= ageS=` | `notePhoneScene` (native), reported next boot | the phone scene's whole lifecycle for one launch |
| `carplay-phone-hostwait …` (exists) | `mintSecondSurface` | the phone had to wait for expo-updates' host |
| `carplay-rootwatch …` (exists) | `watchCarRoot` | a JS root reached the head unit |

Reading a `carplay-phone-scene` row:

* `st=2` at `connect` with `car=` a few hundred ms → **CarPlay-first, phone scene connected in the
  background.** This is the case the whole document is about.
* `act=-1` → **iOS never activated the phone scene.** Nothing in the app can present it; the belt
  cannot help and the next step is a sysdiagnose and Apple, not more code.
* `act=612000` with `adopt=key` or `adopt=commit` → the scene *did* activate and the belt fired;
  `act` is how long the driver waited and `adopt` says which of the three faults it was.
* `adopt=-` on a phone-first launch, `key=1`, `root=` Expo's VC → the healthy path, proven to have
  run rather than merely assumed.

Also `NSLog("[Convoy] phone scene: …")` on every event, so a live device-log capture shows it
without waiting for a relaunch.

**Delivery caveat:** like `hostCeiling` / `hostWait` / `rootWatch`, this row arrives on the *next*
JS boot. `tukeja-373480` was still the live process five hours later, so a session that is never
relaunched reports late. A follow-up option (not proposed for 80): read the marker once per minute
from the path that already logs `timer-pump` — it is a sync `getSharedDefaults` call on a path that
runs ≤1/60 s and only while a car link is live. `src/timerLiveness.ts` is nav-locked with
`watchNew: true`, but `maybeLogTimerPump` sits outside every 🔒 region, so this would move no lock
provided it adds no new module-scope constant.

---

## 5. Risk

| risk | why it is contained |
|---|---|
| A second `"main"` (two app trees → the presence double-join crash) | `adoptPhoneWindow`'s mount branch runs only when `rootViewController == nil`; every existing path installs *some* root, including the black wait VC. Plus the new `session.role == .windowApplication` guard removes the external-display route into `mount` |
| Minting on the embedded bundle (the 09-02 stranding) | `adoptPhoneWindow` calls `mount`, which re-enters the existing `isHostReady` / `whenHostReady` gate; it never reaches `superView` first |
| Re-minting the app tree under the driver's fingers | adoption is once per process (`phoneAdopted`), the rescue budget is cut from 30 to 4, and the tick now refuses to run at all while the scene is background |
| `synchronouslyWaitFor(0.3)` blocking the main thread | once, at activation. The car window does exactly this up to 120 times per connect. It is not per-tick work — the watchdog rule (2026-09-01) is about per-frame layer writes |
| The normal phone-first launch regressing | every new branch is gated on a state a phone-first launch cannot be in: its window is key and visible, its root is Expo's own VC (not `ConvoyPhoneRootViewController`), and its scene is `foregroundActive` at the first activation → `did = "none"`, nothing touched |
| The unkeyed background window changing expo-updates' `getWindow()` | `mintSecondSurface` runs only after the host exists, i.e. after the one deferred install has already happened; `appDelegate.window` is still repointed in the same block, so the fallback is unchanged |

Files touched by the patch: `plugins/withConvoyCarPlay.js`, `src/crashBreadcrumb.ts`. Neither is in
the nav-lock manifest. `ios/` is regenerated by prebuild; `scripts/trap-check.py` has no rule in
this area yet — add one (*"PhoneSceneDelegate must implement sceneDidBecomeActive"*) the day this
root cause closes, not before.

---

## 6. What I could NOT verify

* **I did not compile or run any of this.** No prebuild, no Xcode, no simulator, no device. The
  Swift above is written to the file's existing idioms and reuses primitives already in it
  (`remintHostedSurface`, `RCTSurfaceStageIsRunning`, the `ConvoyFabricWait` shim), but
  "it compiles" is unproven.
* **Why iOS held the phone scene in `.background` for 10–80 minutes is NOT established.** Two
  readings fit every row I queried: (a) the driver opened the app and iOS never activated the
  scene — the black screen; (b) iOS connected the scene in the background on its own and the
  driver simply did not pick the phone up until 19:31. The telemetry cannot separate them, because
  nothing records user intent. Jeff's and Olaf's own reports are the only evidence for (a), and
  Olaf's five force-quits in 2.5 minutes are the strongest of it. **HYPOTHESIS.**
* **Whether iOS connects a window-application scene in `.background` during a CarPlay background
  launch at all** is a claim about iOS 27 behaviour I could not test. `ps=-2` at 19:19:33.7 and
  `ps=2` at 19:20:34 prove *a* scene appeared in between; they do not prove who asked for it.
* **Whether the belt cures the black screen.** If reading (a) is right *and* the cause is our
  unkeyed/uncommitted window, it does. If iOS refuses to activate the scene, nothing here helps —
  the receipt is what tells us which, and it tells us in one drive.

### Test script — Jeff, once build 80 is on the phone

1. Force-quit Hairpin (swipe it out of the app switcher). Confirm it is gone from the switcher.
2. Start the car / plug in so **CarPlay launches Hairpin by itself**. **Do not touch the phone.**
3. Wait for the CarPlay map to draw normally.
4. Now pick up the phone, unlock it, tap Hairpin. **Note the clock time.**
5. Expect the map within a second or two. If it is black, count thirty, take the (black)
   screenshot, and note that time too.
6. Either way: force-quit and reopen the app once, phone-first. **That relaunch is what uploads the
   receipt.**
7. Control run, same day: open Hairpin on the phone FIRST, then connect CarPlay. Expect the app to
   behave exactly as it does today.

Then query, for the CarPlay-first instance:

```sql
select to_char(event_at,'HH24:MI:SS') t, message from crash_reports
where handle='Jeff' and event_at > now() - interval '1 day'
  and (message like 'carplay-phone-scene%' or message like 'carplay-phone-hostwait%'
       or message like 'carplay-rootwatch%' or message like 'timer-pump%')
order by event_at;
```

What settles it:

* `carplay-phone-scene … st=2 act=-1` → iOS never activated the scene. **The app cannot fix this**;
  pull the sysdiagnose and take it to Apple, and tell testers the force-quit is the workaround.
* `carplay-phone-scene … st=2 act=<big> adopt=key|commit|mount` → the belt fired at the moment the
  driver opened the app; `act` is exactly how long the black screen lasted, and step 5's clock time
  should match it.
* `carplay-phone-scene … adopt=-` **and the phone looked fine at step 4** → the CarPlay-first path
  is healthy on iOS 27 with build 80, and the remaining `ps=2` rows are just a phone in a pocket.
* No `carplay-phone-scene` row at all after a relaunch → the marker never got written; check that
  the build actually contains the plugin change (`ios/Hairpin/PhoneSceneDelegate.swift` must
  contain `sceneDidBecomeActive`).
