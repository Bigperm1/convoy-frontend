/** @type {import('@bacons/apple-targets').Config} */
// Watch-face complication: crew-live count from the watch app's own store.
module.exports = {
  type: 'watch-widget',
  name: 'HairpinWatchWidget',
  bundleIdentifier: 'com.sw0rdfisch.convoy.watchkitapp.widget',
  deploymentTarget: '10.0',
  frameworks: ['WidgetKit', 'SwiftUI'],
};
