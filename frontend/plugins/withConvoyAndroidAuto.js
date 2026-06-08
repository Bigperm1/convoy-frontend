// plugins/withConvoyAndroidAuto.js
//
// Makes Convoy discoverable as an Android Auto app.
//
// react-native-carplay's own library manifest declares the CarAppService
// (action androidx.car.app.CarAppService + category NAVIGATION) and the car
// template permissions, and those merge into the app at build time. BUT Android
// Auto will not LIST an app unless the app itself also declares that it is a car
// app, via:
//   1. res/xml/automotive_app_desc.xml  ->  <automotiveApp><uses name="template"/></automotiveApp>
//   2. <meta-data android:name="com.google.android.gms.car.application"
//                 android:resource="@xml/automotive_app_desc" /> in <application>
//
// react-native-carplay intentionally does NOT add these for you (they are
// app-level), so without this plugin the app never appears on the head unit /
// in "Unknown sources", even though the service is present.
//
// Ref: https://github.com/birkir/react-native-carplay/blob/master/AndroidAuto.md

const {
  AndroidConfig,
  withAndroidManifest,
  withDangerousMod,
} = require('@expo/config-plugins');
const fs = require('fs');
const path = require('path');

const CAR_APP_META = 'com.google.android.gms.car.application';

const AUTOMOTIVE_APP_DESC = `<?xml version="1.0" encoding="utf-8"?>
<automotiveApp>
  <uses name="template" />
</automotiveApp>
`;

// 1) Add the car-app descriptor <meta-data> to the main <application>.
const withCarAppMetaData = (config) =>
  withAndroidManifest(config, (cfg) => {
    const app = AndroidConfig.Manifest.getMainApplicationOrThrow(cfg.modResults);
    if (!Array.isArray(app['meta-data'])) {
      app['meta-data'] = [];
    }
    const already = app['meta-data'].some(
      (item) => item && item.$ && item.$['android:name'] === CAR_APP_META
    );
    if (!already) {
      app['meta-data'].push({
        $: {
          'android:name': CAR_APP_META,
          'android:resource': '@xml/automotive_app_desc',
        },
      });
    }
    return cfg;
  });

// 2) Write res/xml/automotive_app_desc.xml into the generated android project.
const withAutomotiveAppDescResource = (config) =>
  withDangerousMod(config, [
    'android',
    async (cfg) => {
      const xmlDir = path.join(
        cfg.modRequest.platformProjectRoot,
        'app',
        'src',
        'main',
        'res',
        'xml'
      );
      fs.mkdirSync(xmlDir, { recursive: true });
      fs.writeFileSync(
        path.join(xmlDir, 'automotive_app_desc.xml'),
        AUTOMOTIVE_APP_DESC
      );
      return cfg;
    },
  ]);

module.exports = function withConvoyAndroidAuto(config) {
  config = withCarAppMetaData(config);
  config = withAutomotiveAppDescResource(config);
  return config;
};
