// Runs the actual startNavBanner function with native services replaced by fakes.
// node tools/sim-qc/nav_start_permissions_test.cjs
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');
const file = process.env.NAV_SOURCE_FILE || path.resolve(__dirname, '../../src/navNotification.ts');
const source = ts.createSourceFile(file, fs.readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true);
const start = source.statements.find(n => ts.isFunctionDeclaration(n) && n.name?.text === 'startNavBanner');
assert.ok(start, 'startNavBanner exists');
const code = ts.transpileModule(start.getText(source), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 } }).outputText;

for (const platform of ['ios', 'android']) {
  for (const status of ['undetermined', 'denied', 'granted']) {
    test(`${platform}: navigation starts with ${status} notifications without a permission prompt`, async () => {
      const writes = [];
      const channels = [];
      const acquisitions = [];
      let prompts = 0;
      const context = {
        exports: {}, Platform: { OS: platform }, Date,
        _stopPromise: null, _route: null, _routePolyline: null, _navEnding: false,
        _stepIdx: 0, _notifiedStep: -1, _routeLookAt: 0, _progressReadAt: 0, _progressWritten: '',
        ROUTE_KEY: 'route', PROGRESS_KEY: 'progress', NAV_POLY_KEY: 'polyline', NAV_CHANNEL: 'nav',
        buildSlimRoute: (route, label) => ({ routeId: 1, label }),
        resetColdArrival() {}, setMapView2D() {}, setCarState() {},
        AsyncStorage: { async setItem(key, value) { writes.push([key, value]); } },
        async acquireBgLocation(owner) { acquisitions.push(owner); return true; },
        Notifications: {
          async getPermissionsAsync() { return { status, granted: status === 'granted' }; },
          async requestPermissionsAsync() { prompts++; return { status: 'granted', granted: true }; },
          async setNotificationChannelAsync(id) { channels.push(id); },
          AndroidImportance: { HIGH: 4 },
        },
      };
      vm.runInNewContext(code, context);
      const result = await context.exports.startNavBanner({ polyline: 'route-line' }, 'Destination');
      assert.equal(result, true);
      assert.equal(prompts, 0);
      assert.deepEqual(acquisitions, ['nav']);
      assert.ok(writes.some(([key, value]) => key === 'polyline' && value === 'route-line'));
      assert.deepEqual(channels, platform === 'android' ? ['nav'] : []);
    });
  }
}
