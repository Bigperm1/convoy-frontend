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

enum ConvoyRNHost {
  static var started = false

  static weak var carWindowRef: UIWindow?
  static var carRepaintBudget = 0
  static var carSceneState = "?"
  static var carConnectAt: Date?
  static var carLastPaintAt: Date?
  static var carActivatedOnce = false
  // Once the car surface has a real (non-zero) size, STOP re-minting it. The live
  // @rnmapbox MapView takes 1-3s to load its style; re-minting it mid-load (the
  // boot burst) tears the GL map down before it can paint. One stable mount lets
  // the map converge; the JS frame watchdog still demotes to static if it fails.
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
    carRepaintBudget = 30
    scheduleCarRepaintTick()
  }

  // Blind safety net during the head unit's boot/handshake (a Toyota TAMM unit can
  // take 20-30s from engine-on to present CarPlay). These fire while our scene is not
  // yet active (invisible, harmless) and STOP the moment it first goes active, after
  // which activation drives the repaint. Fallback only — for the rare no-activation case.
  static func scheduleCarRepaintTick() {
    DispatchQueue.main.asyncAfter(deadline: .now() + 2.0) {
      guard carWindowRef != nil, !carPainted, !carActivatedOnce, let t0 = carConnectAt,
            Date().timeIntervalSince(t0) < 34.0 else { return }
      repaintCarSurface()
      scheduleCarRepaintTick()
    }
  }

  // The scene going active/foreground is the reliable "paint now" signal, and on a slow
  // Toyota boot it can land anywhere in 5-30s. Burst a few re-mints right then so the
  // surface commits while active.
  static func burstCarRepaints() {
    carActivatedOnce = true
    if carRepaintBudget < 6 { carRepaintBudget = 6 }
    for d in [0.0, 0.25, 0.6] {
      DispatchQueue.main.asyncAfter(deadline: .now() + d) { repaintCarSurface() }
    }
  }

  static func repaintCarSurface() {
    // Surface already mounted at a real size — don't tear it down again (this is
    // what kept re-creating the live MapView mid style-load). carPainted is set by
    // ConvoyCarRootViewController.viewDidLayoutSubviews once it has non-zero bounds.
    if carPainted { return }
    guard started, carRepaintBudget > 0,
          let window = carWindowRef,
          let appDelegate = UIApplication.shared.delegate as? AppDelegate,
          appDelegate.reactNativeFactory != nil else { return }
    if let last = carLastPaintAt, Date().timeIntervalSince(last) < 0.15 { return }
    carLastPaintAt = Date()
    carRepaintBudget -= 1
    remintHostedSurface(moduleName: "ConvoyCarSurface", in: window) { ConvoyCarRootViewController(hosted: $0) }
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
    dbg.textColor = UIColor(red: 0, green: 1, blue: 0.53, alpha: 1)
    dbg.font = .boldSystemFont(ofSize: 13)
    dbg.backgroundColor = UIColor(white: 0, alpha: 0.7)
    dbg.text = "car: booting"
    dbg.translatesAutoresizingMaskIntoConstraints = false
    view.addSubview(dbg)
    NSLayoutConstraint.activate([
      dbg.topAnchor.constraint(equalTo: view.safeAreaLayoutGuide.topAnchor, constant: 4),
      dbg.leadingAnchor.constraint(equalTo: view.leadingAnchor, constant: 8),
    ])
  }
  override func viewDidLayoutSubviews() {
    super.viewDidLayoutSubviews()
    if !hosted.bounds.equalTo(view.bounds) { hosted.frame = view.bounds }
    hosted.setNeedsLayout()
    hosted.layoutIfNeeded()
    // Real size reached → mark painted so the repaint loop stops re-minting (the
    // single stable mount lets the live MapView's style finish loading).
    if view.bounds.width > 0 && view.bounds.height > 0 { ConvoyRNHost.carPainted = true }
    dbg.text = "car: " + String(Int(view.bounds.width)) + "x" + String(Int(view.bounds.height)) + " [" + ConvoyRNHost.carSceneState + "] rp" + String(ConvoyRNHost.carRepaintBudget)
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
  }

  func sceneDidBecomeActive(_ scene: UIScene) { ConvoyRNHost.carSceneState = "active"; ConvoyRNHost.burstCarRepaints() }
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
      const importLine = '#import <react-native-carplay/RNCarPlay.h>';
      const candidates = [
        path.join(platformProjectRoot, projectName, `${projectName}-Bridging-Header.h`),
        path.join(platformProjectRoot, projectName, 'noop-Bridging-Header.h'),
      ];
      for (const p of candidates) {
        if (fs.existsSync(p)) {
          const cur = fs.readFileSync(p, 'utf8');
          if (!cur.includes(importLine)) {
            fs.writeFileSync(p, `${cur.trimEnd()}\n${importLine}\n`, 'utf8');
          }
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
