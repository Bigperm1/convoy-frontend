/** @type {import('@bacons/apple-targets').Config} */
// Hairpin Apple Watch companion (build 77). Generated into the Xcode project at
// prebuild by @bacons/apple-targets — companion-only: the phone runs the drive and
// pushes state over WatchConnectivity (modules/hairpin-watch). No nav logic here.
module.exports = {
  type: 'watch',
  name: 'HairpinWatch',
  bundleIdentifier: 'com.sw0rdfisch.convoy.watchkitapp',
  deploymentTarget: '10.0',
  frameworks: ['WatchConnectivity', 'WatchKit', 'AVFAudio', 'WidgetKit'],
  colors: { $accent: '#2DEC86' },
};
