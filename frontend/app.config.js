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
        // Pin the native Mapbox Maps SDK to a stable v11 matching the installed
        // @rnmapbox/maps 10.3.1 JS package (its documented iOS default).
        RNMapboxMapsVersion: '11.16.2',
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
