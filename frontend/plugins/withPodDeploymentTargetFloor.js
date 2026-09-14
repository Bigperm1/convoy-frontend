// plugins/withPodDeploymentTargetFloor.js
//
// Raises every Pods target build configuration whose IPHONEOS_DEPLOYMENT_TARGET is
// EXPLICITLY set below 15.1 up to 15.1, from inside the generated Podfile's
// post_install block. iOS only; Android is untouched.
//
// ─── WHY (2026-09-14, build 79 — the first build cut locally with Xcode 27) ──────
// Xcode 27.0 RC (27A266a) turns a low pod deployment target into a hard ERROR. The
// qualification build of the full Hairpin scheme (Release, iOS Simulator) failed with
// 13 of these and ** BUILD FAILED **:
//
//   Pods.xcodeproj: error: The iOS Simulator deployment target
//   'IPHONEOS_DEPLOYMENT_TARGET' is set to 10.0, but the range of supported deployment
//   target versions is 15.0 to 27.0.x. (in target
//   'GTMSessionFetcher-GTMSessionFetcher_Core_Privacy' from project 'Pods')
//
// The 13 targets and the value each one carried:
//   AppAuth-AppAuthCore_Privacy                        12.0
//   GTMAppAuth-GTMAppAuth_Privacy                      12.0
//   GTMSessionFetcher-GTMSessionFetcher_Core_Privacy   10.0
//   GTMSessionFetcher-GTMSessionFetcher_Full_Privacy   10.0
//   GoogleSignIn-GoogleSignIn                          12.0
//   GoogleUtilities-GoogleUtilities_Privacy            12.0
//   MapboxMaps-MapboxMapsResources                     14.0
//   PromisesObjC-FBLPromises_Privacy                    9.0
//   PromisesSwift-Promises_Privacy                      9.0
//   RNCAsyncStorage-RNCAsyncStorage_resources          13.4
//   RNSVG-RNSVGFilters                                 12.4
//   ReachabilitySwift-ReachabilitySwift                12.0
//   SDWebImage-SDWebImage                               9.0
//
// Xcode 26.6 (17F113) only WARNS: a control build of
// GTMSessionFetcher-GTMSessionFetcher_Core_Privacy with it printed "... is set to 10.0, but
// the range of supported deployment target versions is 12.0 to 26.5.99" and ended
// ** BUILD SUCCEEDED **. The floor is a no-op for anything already >= 15.1, so the Xcode
// 26.6 build keeps working (re-verified the day this landed, full scheme, both Xcodes).
//
// These are CocoaPods resource-bundle targets (<pod>-<bundle>). react_native_post_install
// does not reach them: RN 0.81.5 ReactNativePodsUtils.updateOSDeploymentTarget
// (node_modules/react-native/scripts/cocoapods/utils.rb) walks only each pod's
// native_target, raising it to Helpers::Constants.min_ios_version_supported ('15.1').
// This plugin applies that same 15.1 floor to EVERY pods_project target, bundles included.
//
// Rules the Ruby below keeps:
//   - only a value that is explicitly set AND parses as a version is considered;
//     a target with no IPHONEOS_DEPLOYMENT_TARGET of its own is never given one;
//   - it only ever RAISES (Gem::Version compare, so '15.10' is not read as 15.1);
//   - WATCHOS_ / MACOSX_ / TVOS_DEPLOYMENT_TARGET are never read or written.
//
// It is inserted as the LAST statement of post_install (just above that block's
// closing `end`), after react_native_post_install and $RNMapboxMaps.post_install, so
// no later hook in the block can undo it. Idempotent: any previous copy between the
// markers is removed before the current one is inserted, so re-running prebuild
// without --clean leaves exactly one copy (verified 2026-09-14 by planting a stale copy
// and re-running: replaced, count 1). ⚠ A non-clean `expo prebuild -p ios` itself exits 1
// today in @bacons/apple-targets 4.0.7 ("[ios.xcodeProjectBeta2] ... Cannot read
// properties of undefined (reading 'removeFromProject')") WITH OR WITHOUT this plugin —
// measured both ways; dangerous mods run first, so the Podfile is already rewritten by
// then. Use --clean for a real build. If the post_install anchor or its closing
// `end` cannot be found, prebuild THROWS — a template change must never silently drop
// the floor and hand the next Xcode 27 build the 13 errors back.
// Guarded in scripts/trap-check.py (pod-deployment-target-floor-unregistered).

const { withDangerousMod } = require('expo/config-plugins');
const fs = require('fs');
const path = require('path');

const TAG = 'hairpin-pod-deployment-target-floor';
const FLOOR = '15.1';
const BEGIN = `# @generated begin ${TAG} - plugins/withPodDeploymentTargetFloor.js (DO NOT MODIFY)`;
const END = `# @generated end ${TAG}`;

const POST_INSTALL_RE = /^([ \t]*)post_install do \|installer\|[ \t]*$/;

function rubyBlock(indent) {
  const i = indent;
  return [
    BEGIN,
    `${i}# Xcode 27 errors on IPHONEOS_DEPLOYMENT_TARGET < 15.0 (2026-09-14). Raise explicit values below ${FLOOR}; never add, never lower.`,
    `${i}hairpin_dt_floor = Gem::Version.new('${FLOOR}')`,
    `${i}installer.pods_project.targets.each do |hairpin_dt_target|`,
    `${i}  hairpin_dt_target.build_configurations.each do |hairpin_dt_config|`,
    `${i}    hairpin_dt_current = hairpin_dt_config.build_settings['IPHONEOS_DEPLOYMENT_TARGET']`,
    `${i}    next unless hairpin_dt_current.is_a?(String) && hairpin_dt_current.strip.match?(/\\A\\d+(\\.\\d+){0,2}\\z/)`,
    `${i}    next unless Gem::Version.new(hairpin_dt_current.strip) < hairpin_dt_floor`,
    `${i}    Pod::UI.puts "[pod-dt-floor] #{hairpin_dt_target.name} #{hairpin_dt_config.name} IPHONEOS_DEPLOYMENT_TARGET #{hairpin_dt_current} -> ${FLOOR}"`,
    `${i}    hairpin_dt_config.build_settings['IPHONEOS_DEPLOYMENT_TARGET'] = '${FLOOR}'`,
    `${i}  end`,
    `${i}end`,
    END,
  ];
}

function removeExistingBlock(lines) {
  const begins = lines.reduce((acc, l, idx) => (l.includes(`@generated begin ${TAG}`) ? acc.concat(idx) : acc), []);
  const ends = lines.reduce((acc, l, idx) => (l.includes(`@generated end ${TAG}`) ? acc.concat(idx) : acc), []);
  if (begins.length !== ends.length) {
    throw new Error(
      `[withPodDeploymentTargetFloor] ios/Podfile has ${begins.length} begin and ${ends.length} end markers for ${TAG}; ` +
        'refusing to guess which lines to replace. Run `npx expo prebuild -p ios --clean`.'
    );
  }
  let out = lines;
  for (let k = begins.length - 1; k >= 0; k--) {
    if (ends[k] < begins[k]) {
      throw new Error(`[withPodDeploymentTargetFloor] ios/Podfile ${TAG} end marker precedes its begin marker.`);
    }
    out = out.slice(0, begins[k]).concat(out.slice(ends[k] + 1));
  }
  return out;
}

function applyFloor(src) {
  let lines = removeExistingBlock(src.split('\n'));

  const anchors = lines.reduce((acc, l, idx) => (POST_INSTALL_RE.test(l) ? acc.concat(idx) : acc), []);
  if (anchors.length !== 1) {
    throw new Error(
      `[withPodDeploymentTargetFloor] expected exactly 1 \`post_install do |installer|\` line in ios/Podfile, found ${anchors.length}. ` +
        'The Expo Podfile template changed — re-anchor this plugin; without it Xcode 27 fails on 13 pod targets ' +
        "(IPHONEOS_DEPLOYMENT_TARGET 9.0-14.0, 'range of supported deployment target versions is 15.0 to 27.0.x')."
    );
  }
  const start = anchors[0];
  const outer = POST_INSTALL_RE.exec(lines[start])[1];
  // The block's closing `end` is the first code line back at the anchor's own indentation.
  // Comment lines are skipped (the @generated markers sit at column 0 INSIDE the block);
  // any other code line at or left of that indentation means the shape changed — stop.
  let close = -1;
  for (let j = start + 1; j < lines.length; j++) {
    const line = lines[j].replace(/[ \t]+$/, '');
    const trimmed = line.trim();
    if (trimmed === '' || trimmed.startsWith('#')) continue;
    const indent = line.length - line.trimStart().length;
    if (indent > outer.length) continue;
    if (line === `${outer}end`) close = j;
    break;
  }
  if (close < 0) {
    throw new Error(
      `[withPodDeploymentTargetFloor] found \`post_install do |installer|\` in ios/Podfile but no closing \`${outer}end\` ` +
        'at the same indentation. The Expo Podfile template changed — re-anchor this plugin.'
    );
  }

  lines = lines.slice(0, close).concat(rubyBlock(`${outer}  `), lines.slice(close));
  return lines.join('\n');
}

module.exports = function withPodDeploymentTargetFloor(config) {
  return withDangerousMod(config, [
    'ios',
    async (cfg) => {
      const file = path.join(cfg.modRequest.platformProjectRoot, 'Podfile');
      if (!fs.existsSync(file)) {
        throw new Error(`[withPodDeploymentTargetFloor] ${file} does not exist at prebuild.`);
      }
      const src = fs.readFileSync(file, 'utf8');
      const next = applyFloor(src);
      if (next !== src) fs.writeFileSync(file, next, 'utf8');
      return cfg;
    },
  ]);
};

module.exports.applyFloor = applyFloor;
