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
    guard let appDelegate = UIApplication.shared.delegate as? AppDelegate,
          let factory = appDelegate.reactNativeFactory else { return }
    let window = UIWindow(windowScene: windowScene)
    self.window = window
    appDelegate.window = window
    factory.startReactNative(withModuleName: "main", in: window, launchOptions: nil)
  }
}
`;

const CAR_DELEGATE_SWIFT = `import Foundation
import CarPlay

// Forwards CarPlay scene lifecycle to react-native-carplay's RNCarPlay bridge.
// 2-arg form (window taken from the scene) matches the library's example.
@objc(CarSceneDelegate)
class CarSceneDelegate: UIResponder, CPTemplateApplicationSceneDelegate {
  func templateApplicationScene(
    _ templateApplicationScene: CPTemplateApplicationScene,
    didConnect interfaceController: CPInterfaceController
  ) {
    RNCarPlay.connect(with: interfaceController, window: templateApplicationScene.carWindow)
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
