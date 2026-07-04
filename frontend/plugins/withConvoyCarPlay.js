// plugins/withConvoyCarPlay.js
//
// Wires react-native-carplay's iOS CarPlay scene into the Expo (SDK 54) project.
//
// ─── WHY THE FIRST ATTEMPT CRASHED ──────────────────────────────────────────
// CarPlay REQUIRES the app to adopt the UIScene lifecycle (Apple rule + the
// library's CarPlay.md). The moment `UIApplicationSceneManifest` exists, UIKit
// STOPS using the AppDelegate's `window` — every window must be vended by a
// scene, and the system asks the AppDelegate for a scene config per connecting
// session keyed by `session.role`. The old plugin declared ONLY the CarPlay
// scene and no phone-window scene and no routing, so on launch the phone's
// `.windowApplication` session had no delegate to build a window → blank screen
// / "app doesn't open". Verified against react-native-carplay's CarPlay.md and
// its example app (apps/example/ios): they declare BOTH scene roles, host the
// RN root inside a PhoneSceneDelegate, and route by role in the AppDelegate.
//
// ─── WHAT THIS PLUGIN DOES (the verified fix) ───────────────────────────────
//   1. Info.plist UIApplicationSceneManifest with BOTH roles:
//        UIWindowSceneSessionRoleApplication            -> PhoneSceneDelegate
//        CPTemplateApplicationSceneSessionRoleApplication -> CarSceneDelegate
//   2. PhoneSceneDelegate.swift — builds the UIWindow for the phone scene and
//      starts React Native into it via the Expo factory (SDK 54 has no
//      `rootView` property; the factory's startReactNative(...in:window:) is the
//      SDK-54-correct equivalent).
//   3. CarSceneDelegate.swift — forwards connect/disconnect to RNCarPlay using
//      the 2-arg form the library example uses (window from scene.carWindow).
//   4. AppDelegate.swift — add `import CarPlay`, REMOVE the AppDelegate's own
//      window+startReactNative block (the PhoneScene owns that now), and add
//      `configurationForConnecting` to route CarPlay vs phone scenes.
//   5. Entitlement com.apple.developer.carplay-maps (granted to the App ID).
//   6. Bridging-header import so the Swift CarSceneDelegate sees the Obj-C
//      RNCarPlay class.
//
// ─── VALIDATE FOR FREE (macOS/Linux only — cannot run on Windows) ───────────
// `npx expo prebuild -p ios --no-install` then confirm: Info.plist has both
// scenes, PhoneSceneDelegate.swift + CarSceneDelegate.swift exist and are in the
// Xcode sources, the AppDelegate has `configurationForConnecting` and no longer
// calls startReactNative, and the bridging header imports RNCarPlay (if pods are
// modular, switch the Swift `#import` to `import react_native_carplay`).

const {
  withInfoPlist,
  withEntitlementsPlist,
  withDangerousMod,
  withXcodeProject,
  withAppDelegate,
} = require('expo/config-plugins');
const fs = require('fs');
const path = require('path');

const PHONE_DELEGATE = 'PhoneSceneDelegate';
const CAR_DELEGATE = 'CarSceneDelegate';

const PHONE_DELEGATE_SWIFT = `import UIKit
import React

// Hosts the React Native root for the PHONE window once the app adopts the
// UIScene lifecycle (required by CarPlay). Mirrors react-native-carplay's
// example PhoneScene, adapted to Expo SDK 54's factory API.
@objc(PhoneSceneDelegate)
class PhoneSceneDelegate: UIResponder, UIWindowSceneDelegate {
  var window: UIWindow?

  func scene(
    _ scene: UIScene,
    willConnectTo session: UISceneSession,
    options connectionOptions: UIScene.ConnectionOptions
  ) {
    guard let windowScene = scene as? UIWindowScene else { return }
    guard let appDelegate = UIApplication.shared.delegate as? AppDelegate else { return }
    let window = UIWindow(windowScene: windowScene)
    self.window = window
    appDelegate.window = window
    // Boot the RN host if this scene is first (normal cold phone launch), else
    // mint the phone root on the already-running host (e.g. the app was woken by
    // a cold CarPlay connect, which booted the host before the phone opened).
    ConvoyRNHost.mount(moduleName: "main", in: window, appDelegate: appDelegate, makeVisible: true)
  }
}
`;

const CAR_DELEGATE_SWIFT = `import Foundation
import CarPlay
import UIKit
import React
import Expo

// CarPlay scene delegate.
//
// 1) Forwards the CarPlay scene lifecycle to react-native-carplay (RNCarPlay),
//    which owns the CPTemplate hierarchy (map template, maneuver cards, trip
//    estimates). 2-arg connect form (window taken from the scene).
//
// 2) Mounts Convoy's React Native car dashboard (the "ConvoyCarSurface" JS root,
//    registered at app start in src/carplay/registerCarSurface.ts) onto the
//    CarPlay window OURSELVES, via Expo's bridgeless root-view factory.
//    react-native-carplay's own MapTemplate \`component\` path mounts the window
//    with RCTRootView(initWithBridge:), which renders NOTHING under the New
//    Architecture (bridgeless, RN 0.81 / Expo SDK 54) -> blank car screen. The
//    library's native render block is patched out (patches/react-native-carplay
//    +2.4.1-beta.0.patch), and we instead create the surface on the ALREADY
//    running React host with rootViewFactory.view(withModuleName:) and set it as
//    the car window's root view controller. CarPlay draws this view beneath its
//    template chrome (the standard CarPlay map-app layering).
// Boots the React Native host EXACTLY ONCE per process, whichever scene (phone
// window or CarPlay) connects FIRST, then mounts a module into the given window.
//
// WHY: startReactNative(...) is what creates the host. On a COLD CarPlay connect
// (phone app not running) the phone scene never runs, so the old car code, which
// assumed the host was already up and only ever called superView(...), crashed
// on a nil host. Now the first scene to connect boots the host itself.
//
// The first scene boots via the full Expo factory path (startReactNative), which
// runs the one-time react-delegate handlers (incl. expo-updates' start) exactly
// once. Every LATER scene mints its root via superView(...), which BYPASSES those
// one-time handlers — calling the normal view(...) a second time would start
// expo-updates twice and trap. (Same bypass Expo uses in recreateRootView().)
// Adopted by the hosted root VCs (car + phone) so the generic re-mint helper can
// swap a fresh surface into whichever one is presented.
protocol ConvoyHostedVC: AnyObject {
  func swapHosted(_ newHosted: UIView)
}

// Lets Swift call RCTFabricSurface's synchronouslyWaitFor: WITHOUT importing
// <React/RCTFabricSurface.h> (that header is C++ and cannot live in an Obj-C
// bridging header). The real surface responds to this selector at runtime; we
// dispatch dynamically through @objc optional on AnyObject. synchronouslyWaitFor:
// blocks up to the timeout for a render revision then schedules the mount — the same
// primitive RN uses to force first paint of RCTLogBoxView.
@objc protocol ConvoyFabricWait {
  @objc optional func synchronouslyWaitFor(_ timeout: TimeInterval) -> Bool
}

enum ConvoyRNHost {
  static var started = false

  static weak var carWindowRef: UIWindow?
  static var carRepaintBudget = 0
  static var carSceneState = "?"
  static var carBgTask: UIBackgroundTaskIdentifier = .invalid
  static var carConnectAt: Date?
  static var carLastPaintAt: Date?
  static var carActivatedOnce = false
  // TRUE only once an ACTUAL Fabric frame has committed on the car window
  // (ConvoyCarRootViewController.forceCarCommit -> RCTFabricSurface.synchronouslyWaitFor).
  // NOT a size flag — latching on VC size (old build 56/57) froze the commit loop
  // before the deferred [surface start] ran, so the surface never committed and the
  // window stayed on the splash loadingView (the "logo"). Gating on a real commit lets
  // the bounded tick retry until start() lands.
  static var carPainted = false

  // Phone "main" second-surface rescue (cold-CarPlay-first). Mirrors the car vars.
  static weak var phoneWindowRef: UIWindow?
  static var phoneRepaintBudget = 0
  static var phoneConnectAt: Date?
  static var phoneLastPaintAt: Date?
  static var phonePainted = false

  static func armCarRepaints(in window: UIWindow) {
    carWindowRef = window
    carConnectAt = Date()
    carActivatedOnce = false
    carPainted = false
    carLastPaintAt = nil
    carRepaintBudget = 120
    beginCarBgTask()
    scheduleCarRepaintTick()
  }

  // Hold a background task for the cold-connect commit window so the FIRST Fabric
  // frame can commit even while the phone app is backgrounded (CarPlay-first cold
  // start, or the phone locked when CarPlay comes up). Without it iOS can suspend
  // the app before the retry tick lands the commit, so the map only paints once the
  // user foregrounds the phone — the "Drive together placeholder until foreground"
  // bug. Ended the instant a real frame commits (carPainted) or on disconnect. This
  // is bounded by iOS's ~30s task budget (which covers the connect/commit window) —
  // it is NOT a continuous-render keep-alive for a whole backgrounded drive.
  static func beginCarBgTask() {
    if carBgTask != .invalid { return }
    carBgTask = UIApplication.shared.beginBackgroundTask(withName: "convoy-car-commit") {
      endCarBgTask()
    }
  }
  static func endCarBgTask() {
    if carBgTask != .invalid {
      UIApplication.shared.endBackgroundTask(carBgTask)
      carBgTask = .invalid
    }
  }

  // Blind safety net during the head unit's boot/handshake (a Toyota TAMM unit can
  // take 20-30s from engine-on to present CarPlay). These fire while our scene is not
  // yet active (invisible, harmless) and STOP the moment it first goes active, after
  // which activation drives the repaint. Fallback only — for the rare no-activation case.
  static func scheduleCarRepaintTick() {
    // Runs continuously (pre AND post activation) every 0.4s until a real frame
    // commits (carPainted) or the connect ages out. The async [surface start] can
    // land anywhere in the first few seconds on a slow head unit, so we must keep
    // retrying the commit on the SAME surface well past scene activation — not just
    // in a 3-shot burst. Self-terminates on carPainted / empty budget / 40s.
    DispatchQueue.main.asyncAfter(deadline: .now() + 0.4) {
      guard carWindowRef != nil, !carPainted, let t0 = carConnectAt,
            Date().timeIntervalSince(t0) < 40.0 else { return }
      repaintCarSurface()
      scheduleCarRepaintTick()
    }
  }

  // The scene going active/foreground is the reliable "paint now" signal, and on a slow
  // Toyota boot it can land anywhere in 5-30s. Burst a few re-mints right then so the
  // surface commits while active.
  static func burstCarRepaints() {
    // Scene went active/foreground — top up the budget and take an immediate commit
    // attempt. The continuous tick (armed at connect) keeps retrying after this.
    carActivatedOnce = true
    if carRepaintBudget < 60 { carRepaintBudget = 60 }
    repaintCarSurface()
  }

  static func repaintCarSurface() {
    // FORCE A FABRIC COMMIT on the EXISTING car surface — do NOT re-mint. Re-minting
    // builds a fresh surface whose [surface start] is dispatched async all over again,
    // discarding the one that was about to commit (the old bursts only painted by luck).
    // carPainted flips ONLY when a real frame commits (forceCarCommit ->
    // RCTFabricSurface.synchronouslyWaitFor == true), so this bounded tick retries the
    // commit on the one surface until the deferred start() has run and JS rendered.
    if carPainted { return }
    guard started, carRepaintBudget > 0,
          let window = carWindowRef,
          let vc = window.rootViewController as? ConvoyCarRootViewController else { return }
    if let last = carLastPaintAt, Date().timeIntervalSince(last) < 0.1 { return }
    carLastPaintAt = Date()
    carRepaintBudget -= 1
    vc.forceCarCommit()
  }

  // ── PHONE surface rescue (mirror of the car rescue) ─────────────────────
  // When "main" is the SECOND surface (cold-CarPlay-first: the host booted with
  // ConvoyCarSurface, then the phone opens), Expo's superView second-surface mount
  // can fail to commit a frame, leaving the phone window on the native launch logo.
  // armPhoneRepaints forces it to paint. UNLIKE the car (a stateless dashboard we
  // can re-mint freely), the phone is the FULL app, so we STOP at first paint
  // (phonePainted) to avoid thrashing the React tree / app + nav state.
  static func armPhoneRepaints(in window: UIWindow) {
    phoneWindowRef = window
    phoneConnectAt = Date()
    phoneLastPaintAt = nil
    phonePainted = false
    phoneRepaintBudget = 30
    schedulePhoneRepaintTick()
  }

  static func schedulePhoneRepaintTick() {
    DispatchQueue.main.asyncAfter(deadline: .now() + 2.0) {
      // Usually a no-op: the phone VC lays out on makeKeyAndVisible within the first
      // tick → phonePainted true → we never re-mint. Re-mint only fires for a
      // genuinely stuck second surface, and stops the moment it paints (or at 34s).
      guard phoneWindowRef != nil, !phonePainted, let t0 = phoneConnectAt,
            Date().timeIntervalSince(t0) < 34.0 else { return }
      repaintPhoneSurface()
      schedulePhoneRepaintTick()
    }
  }

  static func repaintPhoneSurface() {
    guard started, phoneRepaintBudget > 0,
          let window = phoneWindowRef,
          let appDelegate = UIApplication.shared.delegate as? AppDelegate,
          appDelegate.reactNativeFactory != nil else { return }
    if let last = phoneLastPaintAt, Date().timeIntervalSince(last) < 0.15 { return }
    phoneLastPaintAt = Date()
    phoneRepaintBudget -= 1
    remintHostedSurface(moduleName: "main", in: window) { ConvoyPhoneRootViewController(hosted: $0) }
  }

  // Generic re-mint: create a fresh moduleName surface on the running host (via
  // superView so the one-time handlers don't re-run) and either swap it into the
  // existing hosted VC or create one via the make closure. Used by car + phone.
  static func remintHostedSurface(moduleName: String, in window: UIWindow, make: (UIView) -> (UIViewController & ConvoyHostedVC)) {
    guard let appDelegate = UIApplication.shared.delegate as? AppDelegate,
          let factory = appDelegate.reactNativeFactory else { return }
    let fresh: UIView
    if let expoFactory = factory.rootViewFactory as? ExpoReactRootViewFactory {
      fresh = expoFactory.superView(withModuleName: moduleName, initialProperties: nil, launchOptions: [:])
    } else {
      fresh = factory.rootViewFactory.view(withModuleName: moduleName, initialProperties: nil, launchOptions: nil)
    }
    if let vc = window.rootViewController as? ConvoyHostedVC {
      vc.swapHosted(fresh)
    } else {
      let vc = make(fresh)
      window.rootViewController = vc
      vc.view.frame = window.bounds
      vc.view.setNeedsLayout(); vc.view.layoutIfNeeded()
    }
  }

  static func mount(moduleName: String, in window: UIWindow, appDelegate: AppDelegate, makeVisible: Bool) {
    guard let factory = appDelegate.reactNativeFactory else { return }

    if !started {
      started = true

      // ── PHONE cold boot (UNCHANGED) ───────────────────────────────
      // Start RN directly into the phone window. startReactNative sets that
      // window's root view controller AND makes it key+visible - which is exactly
      // right for the phone window (it SHOULD own the app's key window).
      // appDelegate.window is pointed at it FIRST so expo-updates' deferred
      // getWindow() (which fatalErrors without a key window OR appDelegate.window)
      // is satisfied on the very first connect.
      if makeVisible {
        appDelegate.window = window
        factory.startReactNative(withModuleName: moduleName, in: window, launchOptions: nil)
        return
      }

      // ── CARPLAY cold boot (THE 70x264 FIX) ──────────────────────
      // On a COLD CarPlay connect the car scene is the FIRST scene, so the host
      // has to boot here. The OLD code booted by calling startReactNative ON THE
      // CARPLAY WINDOW - and startReactNative internally calls makeKeyAndVisible()
      // on whatever window it is handed. Making a CarPlay CPWindow key fights
      // CarPlay's own presentation and leaves the window pinned at a degenerate
      // size (the measured car: 70x264 portrait sliver) that never heals, so the
      // RN map physically cannot draw. There is no public way to un-key a window
      // afterward, so the only fix is to never key the carWindow in the first place.
      //
      // Boot the host on a DETACHED window instead - this is the stock Expo SDK 54
      // didFinishLaunching boot (a frame UIWindow + startReactNative). That window
      // has no scene, so it is never shown; it exists only to boot the JS host
      // (which evaluates index.js, registering ConvoyCarSurface and the CarPlay
      // bootstrap) and to satisfy expo-updates' getWindow(). The real carWindow is
      // then mounted the SAME clean way the warm path mounts it: rootViewController
      // only, NEVER made key, so CarPlay keeps ownership and hands it the full
      // head-unit size. ConvoyCarRootViewController re-asserts the hosted surface's
      // frame on every layout pass, so it tracks the real size as it arrives.
      let bootWindow = UIWindow(frame: UIScreen.main.bounds)
      appDelegate.window = bootWindow
      factory.startReactNative(withModuleName: moduleName, in: bootWindow, launchOptions: nil)
      // Deferred one runloop so the freshly started host can mint the car surface.
      DispatchQueue.main.async {
        let carRoot: UIView
        if let expoFactory = factory.rootViewFactory as? ExpoReactRootViewFactory {
          carRoot = expoFactory.superView(withModuleName: moduleName, initialProperties: nil, launchOptions: [:])
        } else {
          carRoot = factory.rootViewFactory.view(withModuleName: moduleName, initialProperties: nil, launchOptions: nil)
        }
        let carVC = ConvoyCarRootViewController(hosted: carRoot)
        window.rootViewController = carVC
        carVC.view.frame = window.bounds
        carVC.view.setNeedsLayout()
        carVC.view.layoutIfNeeded()
      }
      return
    }

    // Host already running: mint another surface WITHOUT re-running the one-time
    // handlers (superView), then attach it to this window ourselves.
    let rootView: UIView
    if let expoFactory = factory.rootViewFactory as? ExpoReactRootViewFactory {
      rootView = expoFactory.superView(withModuleName: moduleName, initialProperties: nil, launchOptions: [:])
    } else {
      rootView = factory.rootViewFactory.view(withModuleName: moduleName, initialProperties: nil, launchOptions: nil)
    }

    // The phone window must be made key + visible (startReactNative would have
    // done this in the boot branch). The CarPlay window must NOT — CarPlay owns
    // its presentation; making it key can fight the template layer.
    if makeVisible {
      // PHONE window: this branch is reached ONLY when the host is already running
      // and the phone opens as the SECOND surface — i.e. the cold-CarPlay-first case
      // (normal phone cold boot returns from the startReactNative path above). Host
      // "main" in ConvoyPhoneRootViewController, which re-asserts the surface's frame
      // + layout on every pass; Expo's superView second-surface mount can otherwise
      // stall at 0x0 on the launch logo. armPhoneRepaints then forces it to commit a
      // frame (no-op once it paints). Do NOT touch the normal-phone-boot path above.
      let viewController = ConvoyPhoneRootViewController(hosted: rootView)
      window.rootViewController = viewController
      viewController.view.frame = window.bounds
      viewController.view.setNeedsLayout()
      viewController.view.layoutIfNeeded()
      window.makeKeyAndVisible()
      armPhoneRepaints(in: window)
    } else {
      // CARPLAY window: host the RN surface in a controller that re-asserts the
      // surface's frame + layout on every layout pass. CarPlay can hand us the window
      // before it has a real size and doesn't reliably trigger the layout the
      // bridgeless Fabric surface needs, so a one-time layout at connect can mount the
      // dashboard at 0x0 and leave it blank. viewDidLayoutSubviews fires whenever the
      // window finally gets its size, so the surface can't stay stuck at 0x0. Do NOT
      // make this window key — CarPlay owns its presentation.
      let viewController = ConvoyCarRootViewController(hosted: rootView)
      window.rootViewController = viewController
      viewController.view.frame = window.bounds
      viewController.view.setNeedsLayout()
      viewController.view.layoutIfNeeded()
    }
  }
}

// Hosts the CarPlay RN surface and keeps it sized to the window. CarPlay sizes its
// window LATE and doesn't reliably trigger the layout the bridgeless Fabric surface
// needs to draw, so we re-assert the hosted view's frame + layout on EVERY layout
// pass — a 0x0 mount then self-heals the moment the real size arrives, instead of
// staying blank (the recurring CarPlay bug).
final class ConvoyCarRootViewController: UIViewController, ConvoyHostedVC {
  private var hosted: UIView
  // TEMP mount diagnostic (remove next native build once CarPlay is confirmed):
  // shows whether THIS controller is on screen and at what size. Real numbers +
  // no map => the surface mounted and any gap is JS (OTA-fixable). 0x0 => still
  // the size bug. No label at all => this controller was never presented.
  private let dbg = UILabel()
  init(hosted: UIView) { self.hosted = hosted; super.init(nibName: nil, bundle: nil) }
  required init?(coder: NSCoder) { fatalError("init(coder:) not used") }
  override func viewDidLoad() {
    super.viewDidLoad()
    view.backgroundColor = .black
    hosted.frame = view.bounds
    hosted.autoresizingMask = [.flexibleWidth, .flexibleHeight]
    view.addSubview(hosted)
    clearCarSplash()
    dbg.textColor = UIColor(red: 0, green: 1, blue: 0.53, alpha: 1)
    dbg.font = .boldSystemFont(ofSize: 13)
    dbg.backgroundColor = UIColor(white: 0, alpha: 0.7)
    dbg.numberOfLines = 0
    dbg.textAlignment = .center
    dbg.text = "car: booting"
    dbg.translatesAutoresizingMaskIntoConstraints = false
    view.addSubview(dbg)
    // Build 61: the green cold-connect diagnostic label is HIDDEN for release (its
    // job — verifying cold-connect reaches p1 — is done). Kept in the tree (still
    // updated/constrained, just not visible) so the load-bearing commit path around
    // it is untouched; flip to false to bring it back for native debugging.
    dbg.isHidden = true
    // CENTERED (was pinned top-left, hidden behind the CarPlay side bar) so the full
    // diagnostic line is readable on the head unit.
    NSLayoutConstraint.activate([
      dbg.centerXAnchor.constraint(equalTo: view.centerXAnchor),
      dbg.centerYAnchor.constraint(equalTo: view.centerYAnchor),
      dbg.widthAnchor.constraint(lessThanOrEqualTo: view.widthAnchor, constant: -24),
    ])
  }

  // expo-splash-screen sets the car surface's loadingView (the CONVOY logo) with
  // auto-hide DISABLED, and hideAsync() already fired for the phone before this
  // surface ever existed — so the splash would otherwise stay pinned on this window
  // forever, even after the surface commits. Clear it so the window shows the real
  // surface (or a black backstop + this label), never a misleading logo.
  func clearCarSplash() {
    // loadingView is a non-optional UIView in Swift (NS_ASSUME_NONNULL) but may be
    // absent at runtime, and re-enabling auto-hide is the supported way to drop it on
    // commit. Reach it via KVC (nil-safe) to hide + detach the splash now, and re-enable
    // auto-hide so it can never re-cover the committed content.
    if let proxy = hosted as? RCTSurfaceHostingProxyRootView {
      proxy.disableActivityIndicatorAutoHide(false)
      if let lv = proxy.value(forKey: "loadingView") as? UIView {
        lv.isHidden = true
        lv.removeFromSuperview()
      }
    }
  }

  // Force a real Fabric commit on the EXISTING car surface at the real head-unit size.
  // setSize stores the constraints; synchronouslyWaitFor drives a mount transaction
  // regardless of the unchanged-size dedup (it waits on the mounting coordinator's
  // revision, then schedules the transaction — the same primitive RN uses to force
  // first paint of RCTLogBoxView). Returns true via carPainted only on a genuine
  // committed frame, which stops the retry tick.
  func forceCarCommit() {
    if ConvoyRNHost.carPainted { return }
    let target = targetBounds()
    guard target.width >= 320, target.height >= 120 else { return }
    if !hosted.bounds.equalTo(target) { hosted.frame = target; hosted.setNeedsLayout(); hosted.layoutIfNeeded() }
    if let proxy = hosted as? RCTSurfaceHostingProxyRootView {
      // proxy.surface is non-optional (NS_ASSUME_NONNULL). setMinimumSize == maximumSize
      // == real size stores the constraints (pure-ObjC RCTSurfaceProtocol).
      // synchronouslyWaitFor (Fabric-only, reached via the @objc shim) then forces a
      // mount transaction regardless of the unchanged-size dedup, returning true once a
      // real frame committed.
      let surface = proxy.surface
      // COLD-CONNECT CRASH GUARD (the warm/cold pipeline fix). On a cold CarPlay-first
      // connect the car surface is minted ASYNC (mount, one runloop after boot) while
      // this 0.4s repaint tick AND the scene-activation burst are ALREADY firing — so
      // forceCarCommit can run BEFORE the surface registered its ShadowTree. The next
      // call, synchronouslyWaitFor, calls getMountingCoordinator() before its own null
      // check -> EXC_BAD_ACCESS on an Unregistered (or stopped-after-reconnect) surface.
      // RCTSurfaceStageIsRunning is true ONLY once the surface reached InitialLayout and
      // is not stopped (i.e. it has a live mounting coordinator), so skip until then —
      // the bounded retry tick (0.4s, budget 120, 40s) just tries again for free. On the
      // WARM path the surface is already Running by the first attempt, so this guard
      // falls straight through and the commit sequence below is byte-for-byte unchanged.
      guard RCTSurfaceStageIsRunning(surface.stage) else { return }
      surface.setMinimumSize(target.size, maximumSize: target.size)
      if (surface as AnyObject).synchronouslyWaitFor?(0.3) == true {
        ConvoyRNHost.carPainted = true
        ConvoyRNHost.endCarBgTask()   // first frame committed — release the hold
      }
    }
  }
  // The REAL head-unit size. CarPlay can hand the carWindow a degenerate placeholder
  // (the measured 70x264 sliver) for window.bounds and never re-report a real one — but
  // carWindow is a CPWindow whose .screen is the head unit's UIScreen, and screen.bounds
  // IS the real size. Prefer the larger of the two so a stuck window.bounds can't pin the
  // surface to the sliver. (Guarded experiment: if screen.bounds is also degenerate on a
  // given unit, target falls back to window.bounds — the dbg "scr" field reveals which.)
  private func targetBounds() -> CGRect {
    let wb = view.bounds
    let sb = (ConvoyRNHost.carWindowRef?.screen.bounds) ?? .zero
    if sb.width * sb.height > wb.width * wb.height { return CGRect(origin: .zero, size: sb.size) }
    return wb
  }
  override func viewDidLayoutSubviews() {
    super.viewDidLayoutSubviews()
    let target = targetBounds()
    // Pin the hosted RN (Fabric) surface to the real size — the bridgeless surface is
    // rigidly constrained to its hosting view's bounds, so this is what actually sizes
    // the map. Also nudge the VC view (UIKit may override it back to window.bounds).
    if !view.bounds.equalTo(target) { view.frame = target }
    if !hosted.bounds.equalTo(target) { hosted.frame = target }
    hosted.setNeedsLayout()
    hosted.layoutIfNeeded()
    // NO carPainted size-latch here — carPainted is set ONLY by forceCarCommit() when a
    // real Fabric frame commits. Latching on VC size was the build-56/57 bug that froze
    // the commit loop before the async [surface start] ran, so the surface never painted.
    // Self-diagnosing label: "car <rawWxH> scr<targetWxH> [<state>] rp<budget> p<painted>".
    //   p1 = a real frame committed (fix worked); p0 = still waiting on the commit.
    dbg.text = "car " + String(Int(view.bounds.width)) + "x" + String(Int(view.bounds.height))
      + " scr" + String(Int(target.width)) + "x" + String(Int(target.height))
      + " [" + ConvoyRNHost.carSceneState + "] rp" + String(ConvoyRNHost.carRepaintBudget)
      + " p" + (ConvoyRNHost.carPainted ? "1" : "0")
    view.bringSubviewToFront(dbg)
  }

  func swapHosted(_ newHosted: UIView) {
    newHosted.autoresizingMask = [.flexibleWidth, .flexibleHeight]
    newHosted.frame = view.bounds
    view.addSubview(newHosted)
    let old = hosted
    hosted = newHosted
    old.removeFromSuperview()
    view.setNeedsLayout(); view.layoutIfNeeded()
    view.bringSubviewToFront(dbg)
  }
}

// Phone equivalent of ConvoyCarRootViewController: hosts the "main" RN surface and
// re-asserts its frame + layout on every pass so a SECOND-surface mount can't stay
// stuck at 0x0 on the launch logo. No dbg label (this is the real app UI).
final class ConvoyPhoneRootViewController: UIViewController, ConvoyHostedVC {
  private var hosted: UIView
  init(hosted: UIView) { self.hosted = hosted; super.init(nibName: nil, bundle: nil) }
  required init?(coder: NSCoder) { fatalError("init(coder:) not used") }
  override func viewDidLoad() {
    super.viewDidLoad()
    view.backgroundColor = .black
    hosted.frame = view.bounds
    hosted.autoresizingMask = [.flexibleWidth, .flexibleHeight]
    view.addSubview(hosted)
  }
  override func viewDidLayoutSubviews() {
    super.viewDidLayoutSubviews()
    if !hosted.bounds.equalTo(view.bounds) { hosted.frame = view.bounds }
    hosted.setNeedsLayout()
    hosted.layoutIfNeeded()
    // Once the phone surface has a real size, mark it painted so the rescue loop
    // stops re-minting (don't thrash the full app tree).
    if view.bounds.width > 0 && view.bounds.height > 0 { ConvoyRNHost.phonePainted = true }
  }
  func swapHosted(_ newHosted: UIView) {
    newHosted.autoresizingMask = [.flexibleWidth, .flexibleHeight]
    newHosted.frame = view.bounds
    view.addSubview(newHosted)
    let old = hosted
    hosted = newHosted
    old.removeFromSuperview()
    view.setNeedsLayout(); view.layoutIfNeeded()
  }
}

@objc(CarSceneDelegate)
class CarSceneDelegate: UIResponder, CPTemplateApplicationSceneDelegate {
  func templateApplicationScene(
    _ templateApplicationScene: CPTemplateApplicationScene,
    didConnect interfaceController: CPInterfaceController
  ) {
    let carWindow = templateApplicationScene.carWindow

    // Let react-native-carplay set up its interface controller + templates.
    RNCarPlay.connect(with: interfaceController, window: carWindow)

    // Mount the Convoy RN dashboard onto the CarPlay window. Boots the RN host
    // first if this is a COLD CarPlay connect (phone app not running) — the case
    // that used to crash (superView on a host that was never started).
    guard let appDelegate = UIApplication.shared.delegate as? AppDelegate else { return }
    ConvoyRNHost.mount(moduleName: "ConvoyCarSurface", in: carWindow, appDelegate: appDelegate, makeVisible: false)
    ConvoyRNHost.armCarRepaints(in: carWindow)
  }

  func templateApplicationScene(
    _ templateApplicationScene: CPTemplateApplicationScene,
    didDisconnectInterfaceController interfaceController: CPInterfaceController
  ) {
    RNCarPlay.disconnect()
    ConvoyRNHost.carRepaintBudget = 0
    ConvoyRNHost.carWindowRef = nil
    ConvoyRNHost.carSceneState = "disc"
    ConvoyRNHost.carConnectAt = nil
    ConvoyRNHost.carActivatedOnce = false
    ConvoyRNHost.endCarBgTask()
  }

  func sceneDidBecomeActive(_ scene: UIScene) {
    ConvoyRNHost.carSceneState = "active"
    ConvoyRNHost.burstCarRepaints()
    // Force the screen-sized layout through on activation — CarPlay may never re-deliver
    // a real window.bounds, so re-assert the carWindow root's frame to the head-unit
    // screen size and relayout. viewDidLayoutSubviews then re-pins the hosted surface.
    if let w = ConvoyRNHost.carWindowRef, let vc = w.rootViewController {
      vc.view.frame = w.screen.bounds
      vc.view.setNeedsLayout(); vc.view.layoutIfNeeded()
    }
  }
  func sceneWillEnterForeground(_ scene: UIScene) { ConvoyRNHost.carSceneState = "fg"; ConvoyRNHost.burstCarRepaints() }
  func sceneWillResignActive(_ scene: UIScene) { ConvoyRNHost.carSceneState = "inactive" }
  func sceneDidEnterBackground(_ scene: UIScene) { ConvoyRNHost.carSceneState = "bg" }

}
`;

// The scene-routing method injected into the AppDelegate.
// NOTE: NOT 'override' — ExpoAppDelegate does not implement this UIApplicationDelegate
// method, so the subclass implements the protocol requirement fresh (marking it
// 'override' fails: "method does not override any method from its superclass").
const CONFIG_FOR_CONNECTING = `  public func application(
    _ application: UIApplication,
    configurationForConnecting connectingSceneSession: UISceneSession,
    options: UIScene.ConnectionOptions
  ) -> UISceneConfiguration {
    if connectingSceneSession.role == .carTemplateApplication {
      let cfg = UISceneConfiguration(name: "CarPlay", sessionRole: connectingSceneSession.role)
      cfg.delegateClass = CarSceneDelegate.self
      return cfg
    }
    let cfg = UISceneConfiguration(name: "Phone", sessionRole: connectingSceneSession.role)
    cfg.delegateClass = PhoneSceneDelegate.self
    return cfg
  }`;

// 1) Info.plist — declare BOTH scenes (phone window + CarPlay).
function withCarPlayScenes(config) {
  return withInfoPlist(config, (cfg) => {
    cfg.modResults.UIApplicationSceneManifest = {
      UIApplicationSupportsMultipleScenes: true,
      UISceneConfigurations: {
        UIWindowSceneSessionRoleApplication: [
          {
            UISceneClassName: 'UIWindowScene',
            UISceneConfigurationName: 'Phone',
            UISceneDelegateClassName: `$(PRODUCT_MODULE_NAME).${PHONE_DELEGATE}`,
          },
        ],
        CPTemplateApplicationSceneSessionRoleApplication: [
          {
            UISceneClassName: 'CPTemplateApplicationScene',
            UISceneConfigurationName: 'CarPlay',
            UISceneDelegateClassName: `$(PRODUCT_MODULE_NAME).${CAR_DELEGATE}`,
          },
        ],
      },
    };
    return cfg;
  });
}

// 2) Entitlement (granted to the App ID; without it signing fails).
function withCarPlayEntitlement(config) {
  return withEntitlementsPlist(config, (cfg) => {
    cfg.modResults['com.apple.developer.carplay-maps'] = true;
    return cfg;
  });
}

// 3) Write the two scene-delegate Swift files into the iOS project.
function withSceneDelegateFiles(config) {
  return withDangerousMod(config, [
    'ios',
    (cfg) => {
      const { projectName, platformProjectRoot } = cfg.modRequest;
      const dir = path.join(platformProjectRoot, projectName);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, `${PHONE_DELEGATE}.swift`), PHONE_DELEGATE_SWIFT, 'utf8');
      fs.writeFileSync(path.join(dir, `${CAR_DELEGATE}.swift`), CAR_DELEGATE_SWIFT, 'utf8');
      return cfg;
    },
  ]);
}

// 4) Register both Swift files in the Xcode project's build sources.
function withSceneFilesInXcode(config) {
  return withXcodeProject(config, (cfg) => {
    const proj = cfg.modResults;
    const { projectName } = cfg.modRequest;
    const groupKey =
      proj.findPBXGroupKey({ name: projectName }) ||
      proj.findPBXGroupKey({ path: projectName });
    const target = proj.getFirstTarget().uuid;
    for (const name of [PHONE_DELEGATE, CAR_DELEGATE]) {
      const rel = `${projectName}/${name}.swift`;
      if (!proj.hasFile(rel)) {
        proj.addSourceFile(rel, { target }, groupKey);
      }
    }
    return cfg;
  });
}

// 5) Patch the Expo SDK 54 AppDelegate.swift: import CarPlay, drop its own
//    window+startReactNative (PhoneScene owns it), add scene routing.
function withAppDelegateScenes(config) {
  return withAppDelegate(config, (cfg) => {
    if (cfg.modResults.language !== 'swift') {
      throw new Error('[withConvoyCarPlay] expected a Swift AppDelegate (Expo SDK 54+).');
    }
    let src = cfg.modResults.contents;

    // import CarPlay (idempotent).
    if (!src.includes('import CarPlay')) {
      src = src.replace(
        'import ReactAppDependencyProvider',
        'import ReactAppDependencyProvider\nimport CarPlay'
      );
    }

    // Remove the AppDelegate's own window + startReactNative block — under the
    // scene lifecycle the PhoneSceneDelegate creates the window and starts RN.
    src = src.replace(
      /#if os\(iOS\) \|\| os\(tvOS\)[\s\S]*?#endif/,
      '    // RN root is created by PhoneSceneDelegate under the CarPlay scene lifecycle.'
    );

    // Add scene-routing before the Linking API section (idempotent).
    if (!src.includes('configurationForConnecting')) {
      src = src.replace('  // Linking API', `${CONFIG_FOR_CONNECTING}\n\n  // Linking API`);
    }

    cfg.modResults.contents = src;
    return cfg;
  });
}

// 6) Best-effort bridging-header import so Swift sees the Obj-C RNCarPlay class.
function withBridgingImport(config) {
  return withDangerousMod(config, [
    'ios',
    (cfg) => {
      const { projectName, platformProjectRoot } = cfg.modRequest;
      // RNCarPlay PLUS the PURE-OBJC surface types we use to force a commit on the
      // CarPlay window: RCTSurfaceHostingProxyRootView (its .surface / .loadingView)
      // and RCTSurfaceProtocol (setMinimumSize:maximumSize: + the `stage` property).
      // RCTSurfaceStage.h gives the RCTSurfaceStageIsRunning() readiness check used to
      // guard the cold-connect commit (it's already pulled in transitively by
      // RCTSurfaceProtocol.h, but import it explicitly so the C function symbol is
      // unambiguously visible to Swift — both are pure-ObjC, no C++). We deliberately do
      // NOT import <React/RCTFabricSurface.h> — it pulls in C++ (react/renderer + a
      // facebook::react:: method) and a Swift bridging header is compiled as Obj-C,
      // not Obj-C++, so importing it would break the build. The Fabric-only
      // synchronouslyWaitFor: is reached via an @objc dynamic shim instead.
      const importLines = [
        '#import <react-native-carplay/RNCarPlay.h>',
        '#import <React/RCTSurfaceHostingProxyRootView.h>',
        '#import <React/RCTSurfaceProtocol.h>',
        '#import <React/RCTSurfaceStage.h>',
      ];
      const candidates = [
        path.join(platformProjectRoot, projectName, `${projectName}-Bridging-Header.h`),
        path.join(platformProjectRoot, projectName, 'noop-Bridging-Header.h'),
      ];
      for (const p of candidates) {
        if (fs.existsSync(p)) {
          let cur = fs.readFileSync(p, 'utf8');
          let changed = false;
          for (const line of importLines) {
            if (!cur.includes(line)) { cur = `${cur.trimEnd()}\n${line}`; changed = true; }
          }
          if (changed) fs.writeFileSync(p, `${cur.trimEnd()}\n`, 'utf8');
          break;
        }
      }
      return cfg;
    },
  ]);
}

module.exports = function withConvoyCarPlay(config) {
  config = withCarPlayScenes(config);
  config = withCarPlayEntitlement(config);
  config = withSceneDelegateFiles(config);
  config = withSceneFilesInXcode(config);
  config = withAppDelegateScenes(config);
  config = withBridgingImport(config);
  return config;
};
