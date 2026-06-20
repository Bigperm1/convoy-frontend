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
enum ConvoyRNHost {
  static var started = false

  static func mount(moduleName: String, in window: UIWindow, appDelegate: AppDelegate, makeVisible: Bool) {
    guard let factory = appDelegate.reactNativeFactory else { return }

    if !started {
      // First scene in this process: full boot + mount. startReactNative sets
      // the window's root view controller (and makes it visible) itself.
      //
      // CRITICAL (cold CarPlay crash fix): point appDelegate.window at whichever
      // window boots first BEFORE startReactNative. expo-updates' deferred startup
      // calls getWindow() on completion, which fatalErrors unless it finds a key
      // window OR appDelegate.window. On a cold CarPlay boot the car scene is
      // first and the CarPlay window is not key, so without this the app traps in
      // ExpoUpdatesReactDelegateHandler.getWindow() on the very first connect.
      started = true
      appDelegate.window = window
      factory.startReactNative(withModuleName: moduleName, in: window, launchOptions: nil)
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
      // PHONE window (unchanged): pin the RN root with constraints and present.
      let viewController = UIViewController()
      rootView.translatesAutoresizingMaskIntoConstraints = false
      viewController.view.addSubview(rootView)
      NSLayoutConstraint.activate([
        rootView.leadingAnchor.constraint(equalTo: viewController.view.leadingAnchor),
        rootView.trailingAnchor.constraint(equalTo: viewController.view.trailingAnchor),
        rootView.topAnchor.constraint(equalTo: viewController.view.topAnchor),
        rootView.bottomAnchor.constraint(equalTo: viewController.view.bottomAnchor),
      ])
      window.rootViewController = viewController
      window.makeKeyAndVisible()
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
final class ConvoyCarRootViewController: UIViewController {
  private let hosted: UIView
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
  }

  func templateApplicationScene(
    _ templateApplicationScene: CPTemplateApplicationScene,
    didDisconnectInterfaceController interfaceController: CPInterfaceController
  ) {
    RNCarPlay.disconnect()
  }

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
