/** @type {import('@bacons/apple-targets').Config} */
// Hairpin Apple Watch companion (build 77). Generated into the Xcode project at
// prebuild by @bacons/apple-targets — companion-only: the phone runs the drive and
// pushes state over WatchConnectivity (modules/hairpin-watch). No nav logic here.
module.exports = {
  type: 'watch',
  name: 'HairpinWatch',
  bundleIdentifier: 'com.sw0rdfisch.convoy.watchkitapp',
  deploymentTarget: '10.0',
  // App icon is REQUIRED for a watch app: App Store Connect rejected build 77 with ITMS-90713
  // (no CFBundleIconName) + ITMS-90391 (no icons in Hairpin.app/Watch/HairpinWatch.app). The plugin
  // resizes this to the single 1024×1024 watchOS icon and sets ASSETCATALOG_COMPILER_APPICON_NAME.
  icon: '../../assets/HAIRPIN.png',
  frameworks: ['WatchConnectivity', 'WatchKit', 'AVFAudio', 'WidgetKit'],
  colors: { $accent: '#2DEC86' },
  entitlements: { 'com.apple.security.application-groups': ['group.com.sw0rdfisch.convoy.watch'] },
};
