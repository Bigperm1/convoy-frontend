// plugins/withConvoyCarPlay.js
//
// Expo config plugin — wires react-native-carplay's iOS CarPlay scene into the
// prebuilt iOS project. At prebuild it does four things:
//   1. Declares the CarPlay scene in Info.plist (UIApplicationSceneManifest →
//      CPTemplateApplicationSceneSessionRoleApplication → CarSceneDelegate).
//      Only the CarPlay scene role is declared, so the phone app keeps its
//      existing AppDelegate-based window untouched.
//   2. Adds the navigation entitlement `com.apple.developer.carplay-maps`.
//   3. Writes CarSceneDelegate.swift (forwards connect/disconnect to RNCarPlay)
//      into the iOS project and registers it in the Xcode build.
//   4. Best-effort: appends `#import <react-native-carplay/RNCarPlay.h>` to the
//      app's bridging header so the Swift delegate can see RNCarPlay.
//
// ─── STAGED — do NOT add to app.json `plugins` yet ───────────────────────────
// Activate this ONLY for the iOS build, and ONLY after Apple grants the CarPlay
// entitlement. Building with `com.apple.developer.carplay-maps` before the App
// ID is authorized for it fails code signing. Android builds are never affected
// by this plugin (it only touches iOS).
//
// ─── VALIDATE FOR FREE before any paid build ─────────────────────────────────
// `npx expo prebuild -p ios --no-install` generates the ios/ project locally
// (no EAS build, no cost) so we can confirm: the Info.plist scene block, the
// .entitlements key, that CarSceneDelegate.swift exists and is in the Xcode
// sources, and the bridging import. Discard the generated ios/ dir afterward
// (don't commit it) to stay in the managed workflow.
//
// The ONE thing to confirm on that first prebuild is step 4 — how Swift sees
// RNCarPlay. If the bridging-header path differs (Expo's Swift-AppDelegate
// projects name it differently across SDKs) or pods are built modular, we
// switch the Swift file to `import react_native_carplay` instead. Everything
// else is standard CarPlay wiring.

const {
  withInfoPlist,
  withEntitlementsPlist,
  withDangerousMod,
  withXcodeProject,
} = require('expo/config-plugins');
const fs = require('fs');
const path = require('path');

const DELEGATE = 'CarSceneDelegate';

const DELEGATE_SWIFT = `import CarPlay
import Foundation

// Forwards CarPlay scene lifecycle to react-native-carplay's RNCarPlay bridge.
// Referenced by name from Info.plist's UIApplicationSceneManifest.
@objc(CarSceneDelegate)
class CarSceneDelegate: UIResponder, CPTemplateApplicationSceneDelegate {
  func templateApplicationScene(
    _ templateApplicationScene: CPTemplateApplicationScene,
    didConnect interfaceController: CPInterfaceController,
    to window: CPWindow
  ) {
    RNCarPlay.connect(with: interfaceController, window: window)
  }

  func templateApplicationScene(
    _ templateApplicationScene: CPTemplateApplicationScene,
    didDisconnectInterfaceController interfaceController: CPInterfaceController,
    from window: CPWindow
  ) {
    RNCarPlay.disconnect()
  }
}
`;

function withCarPlayScene(config) {
  return withInfoPlist(config, (cfg) => {
    cfg.modResults.UIApplicationSceneManifest = {
      UIApplicationSupportsMultipleScenes: true,
      UISceneConfigurations: {
        CPTemplateApplicationSceneSessionRoleApplication: [
          {
            UISceneClassName: 'CPTemplateApplicationScene',
            UISceneConfigurationName: 'CarPlay',
            UISceneDelegateClassName: `$(PRODUCT_MODULE_NAME).${DELEGATE}`,
          },
        ],
      },
    };
    return cfg;
  });
}

function withCarPlayEntitlement(config) {
  return withEntitlementsPlist(config, (cfg) => {
    cfg.modResults['com.apple.developer.carplay-maps'] = true;
    return cfg;
  });
}

function withDelegateFile(config) {
  return withDangerousMod(config, [
    'ios',
    (cfg) => {
      const { projectName, platformProjectRoot } = cfg.modRequest;
      const dest = path.join(platformProjectRoot, projectName, `${DELEGATE}.swift`);
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.writeFileSync(dest, DELEGATE_SWIFT, 'utf8');
      return cfg;
    },
  ]);
}

function withDelegateInXcode(config) {
  return withXcodeProject(config, (cfg) => {
    const proj = cfg.modResults;
    const { projectName } = cfg.modRequest;
    const relPath = `${projectName}/${DELEGATE}.swift`;
    if (!proj.hasFile(relPath)) {
      const groupKey =
        proj.findPBXGroupKey({ name: projectName }) ||
        proj.findPBXGroupKey({ path: projectName });
      const target = proj.getFirstTarget().uuid;
      proj.addSourceFile(relPath, { target }, groupKey);
    }
    return cfg;
  });
}

// Best-effort: let the Swift delegate see the RNCarPlay Obj-C class. If no
// bridging header is found (or pods are modular), this is a no-op and we adjust
// after the first prebuild — see the VALIDATE note at the top.
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
  config = withCarPlayScene(config);
  config = withCarPlayEntitlement(config);
  config = withDelegateFile(config);
  config = withDelegateInXcode(config);
  config = withBridgingImport(config);
  return config;
};
