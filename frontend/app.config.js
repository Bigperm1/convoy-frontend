// app.config.js — dynamic Expo config.
//
// The full static config still lives in app.json and is preserved verbatim.
// Expo reads app.json first and passes it here as `config`; this file ONLY
// layers on the @rnmapbox/maps config plugin so the Mapbox *download* token can
// be supplied from an environment variable (process.env.RNMAPBOX_DOWNLOAD_TOKEN)
// instead of being hardcoded in a committed file.
//
// react-native-maps stays registered in app.json — both map libraries coexist
// during the Mapbox migration; nothing here removes it.
module.exports = ({ config }) => {
  config.plugins = [
    ...(config.plugins ?? []),
    [
      '@rnmapbox/maps',
      {
        // Pin the native MapboxMaps SDK to 11.25.0 (was: unpinned → package default
        // 11.20.1). REASON: Mapbox maps-ios fixed "MapView rendering blank when
        // attached to an already-active CarPlay scene" in 11.24.0 — the exact bug
        // that left Convoy's live CarPlay map blank on the secondary window. 11.25.0
        // is the latest stable 11.x carrying that fix; 11.24.0 itself is flagged
        // "should not be used" by Mapbox, hence .25. This single string drives BOTH
        // the iOS pod and the Android Maven dependency. Stay on 11.x (rnmapbox 10.3.1
        // is not written against 12.x). Validate on a dev-client build before the
        // paid production build — see the CarPlay live-map work order.
        RNMapboxMapsVersion: '11.25.0',
        // SECRET download token — read from the environment, NEVER hardcoded or
        // committed. Set RNMAPBOX_DOWNLOAD_TOKEN in .env (local, untracked) and
        // as an EAS secret right before the build. The @rnmapbox plugin writes
        // this into the generated Podfile at prebuild; this project has no
        // committed native dirs, so the token never lands in source control.
        RNMapboxMapsDownloadToken: process.env.RNMAPBOX_DOWNLOAD_TOKEN,
      },
    ],
  ];
  return config;
};
