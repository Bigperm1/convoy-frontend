/** @type {import('@bacons/apple-targets').Config} */
// Hairpin home-screen widget (build 65). Generated into the Xcode project at
// prebuild by @bacons/apple-targets (plugin registered in app.json). Reads the
// "nextEvent" JSON the app writes into the shared App Group defaults
// (src/widgetFeed.ts → HairpinSystem.setSharedDefaults).
module.exports = {
  type: 'widget',
  name: 'HairpinWidget',
  deploymentTarget: '17.0',
  entitlements: {
    'com.apple.security.application-groups': ['group.com.sw0rdfisch.convoy'],
  },
};
