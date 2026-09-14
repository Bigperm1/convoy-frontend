#!/usr/bin/env python3
"""
Receipts for a Hairpin iOS .ipa BEFORE it is uploaded (build 79, 2026-09-14). Works on any Hairpin IPA.

  python3 tools/build/verify-ipa.py <path.ipa> [DTXcodeBuild] [runtimeVersion] [CFBundleVersion]
  (pass "-" to skip an expectation, e.g.  verify-ipa.py b78.ipa - 1.28.0 78)

WHY. Build 79 iOS is built LOCALLY with Xcode 27 RC (EAS has no Xcode 27 image) so the iOS 27 full-page
widget can ship, and a local build leaves NOTHING in `eas build:list`. Every failure below is silent in
the build log and only visible in the binary:
  - the widget's `#if compiler(>=6.4) && canImport(WidgetKit, _version: 749)` gate closes silently on a
    pre-27 SDK (targets/widget/index.swift) — the build succeeds with the XL family absent;
  - fastlane gym may not honour DEVELOPER_DIR (scripts/eas-assert-xcode.sh only sees the npm hook);
  - a bare-env build ships an EMPTY EXPO_PUBLIC_OPENWEATHER_KEY (13 dead-weather OTAs, 2026-08-30);
  - a wrong channel strands the binary from every mapbox-migration OTA (three updates lost 2026-07-05);
  - ASC rejects an embedded bundle whose CFBundleVersion / CFBundleShortVersionString differs from the app;
  - a local signing that drops com.apple.developer.carplay-maps means CarPlay never lists the app.

Checks (exit 1 on any failure):
  every .app/.appex   DTXcodeBuild (== arg 2), one (CFBundleShortVersionString, CFBundleVersion) pair
                      across all of them, CFBundleVersion == arg 4
  HairpinWidget.appex the XL case IN THE EXECUTABLE. A 27-SDK binary imports the enum-case symbol
                      `$s9WidgetKit0A6FamilyO24systemExtraLargePortrait…WC`; measured 2026-09-14 with
                      `swiftc -O` + link on the widget file: Xcode 27 RC (27A266a) = 2 byte hits (still 2
                      after `strip -x`), Xcode 26.6 = 0, local 26.6 HairpinWidget.appex = 0. Required
                      whenever the widget's DTSDKName is iphoneos27+ or arg 2 is a 27+ Xcode build.
                      ⚠ `strings -a <obj> | grep` read 0 on the 27 object that has 1 byte hit — count
                      bytes, never trust strings(1) for this.
  main executable     com.apple.developer.carplay-maps = true in the code-signature entitlements plist
                      (parsed, not a substring: a string literal in code must not pass it), and in
                      embedded.mobileprovision when that file is present
  Expo.plist          EXUpdatesRuntimeVersion (== arg 3), expo-channel-name == mapbox-migration
  main.jsbundle       KEY_PRESENT=1 for EXPO_PUBLIC_OPENWEATHER_KEY. Presence only — the value is never
                      printed. The key file is tools/ota/ow.key (gitignored by *.key; this repo is PUBLIC)
                      or $OW_KEY, and it is DELETED after the run unless KEEP_OW_KEY=1. Create it with:
      npx eas-cli env:exec preview 'printf "%s" "$EXPO_PUBLIC_OPENWEATHER_KEY" > tools/ota/ow.key'

THE BUILD-79 LOCAL iOS RUNBOOK (Jeff decided Option 2 on 2026-09-14). Run it in a separate worktree at the
release SHA, never in the shared checkout (prebuild wipes ios/, which other benches use):
  git worktree add ../frontend-b79 <release SHA> && cd ../frontend-b79 && yarn install --frozen-lockfile
  R=/Applications/Xcode-27.app/Contents/Developer
  WANT=$(defaults read /Applications/Xcode-27.app/Contents/version ProductBuildVersion)   # 27A266a on 09-14
  test "$(DEVELOPER_DIR=$R xcodebuild -version | awk '/^Build version/{print $3}')" = "$WANT" \\
    && DEVELOPER_DIR=$R xcrun --sdk iphoneos --show-sdk-version | grep -q '^27\\.' && echo PREFLIGHT_OK
  DEVELOPER_DIR=$R LANG=en_US.UTF-8 EAS_LOCAL_BUILD_ARTIFACTS_DIR=<scratch>/b79 \\
    npx eas-cli build --platform ios --profile mapbox-ios-x27 --local --non-interactive
  python3 tools/build/verify-ipa.py <scratch>/b79/<file>.ipa "$WANT" <app.json runtimeVersion> <buildNumber>
Then TestFlight INTERNAL only (Jeff's explicit go) -> one real car-first drive on an iOS 27 phone, app
killed + phone locked -> rows ios-toolchain xcode=27A266a, carplay-rootwatch, carplay-phone-hostwait ->
only then external testers. Once 79 is uploaded, falling back to an Xcode 26 cloud 79 is HYPOTHESIS-blocked
(ASC is expected to refuse a second binary at the same version+build): it costs 80 on BOTH platforms.
Record `git rev-parse HEAD` for this IPA and for the cloud Android 79 build — they must match.
"""
import os
import plistlib
import re
import sys
import zipfile

XL = b'systemExtraLargePortrait'
CARPLAY = 'com.apple.developer.carplay-maps'
CHANNEL = 'mapbox-migration'


def arg(i):
    v = sys.argv[i] if len(sys.argv) > i else None
    return None if v in (None, '', '-') else v


def embedded_plists(data):
    """Every XML plist embedded in a binary blob (code-signature entitlements, a CMS-wrapped profile)."""
    out = []
    for m in re.finditer(rb'<\?xml[^>]*\?>.*?</plist>', data, re.S):
        try:
            p = plistlib.loads(m.group(0))
        except Exception:
            continue
        if isinstance(p, dict):
            out.append(p)
    return out


def sdk_major(name):
    m = re.match(r'iphoneos(\d+)', str(name or ''))
    return int(m.group(1)) if m else None


def xcode_major(build):
    m = re.match(r'(\d+)[A-Z]', str(build or ''))
    return int(m.group(1)) if m else None


def main():
    if len(sys.argv) < 2:
        sys.exit(__doc__)
    ipa = sys.argv[1]
    want_xcode, want_rtv, want_build = arg(2), arg(3), arg(4)
    fail = []
    z = zipfile.ZipFile(ipa)
    names = set(z.namelist())

    bundles = sorted(n for n in names if n.startswith('Payload/')
                     and (n.endswith('.app/Info.plist') or n.endswith('.appex/Info.plist')))
    vers = {}
    for n in bundles:
        p = plistlib.loads(z.read(n))
        label = n[len('Payload/'):-len('/Info.plist')]
        row = {k: p.get(k, '-') for k in ('DTXcodeBuild', 'DTSDKName', 'DTPlatformVersion',
                                           'BuildMachineOSBuild', 'CFBundleShortVersionString', 'CFBundleVersion')}
        print(label.ljust(58), '  '.join(k + '=' + str(v) for k, v in row.items()))
        vers.setdefault((p.get('CFBundleShortVersionString'), p.get('CFBundleVersion')), []).append(label)
        if want_xcode and row['DTXcodeBuild'] != want_xcode:
            fail.append(label + ': DTXcodeBuild=' + str(row['DTXcodeBuild']) + ' expected ' + want_xcode)
    if len(vers) != 1:
        fail.append('version/build mismatch across bundles (ASC rejects this): ' + repr(vers))
    if want_build and any(b != want_build for (_, b) in vers):
        fail.append('CFBundleVersion ' + repr(sorted({b for (_, b) in vers}, key=str)) + ' expected ' + want_build)

    top = [n for n in bundles if n.count('/') == 2 and n.endswith('.app/Info.plist')]
    if len(top) != 1:
        sys.exit('expected exactly one top-level .app, found ' + str(len(top)))
    app = top[0][:-len('Info.plist')]
    ap = plistlib.loads(z.read(top[0]))

    # ── the iOS 27 full-page widget: the case must be IN THE BINARY, not inferred from DTSDKName ──
    widget = [n for n in bundles if n.endswith('/HairpinWidget.appex/Info.plist')]
    if not widget:
        fail.append('HairpinWidget.appex missing')
    else:
        wp = plistlib.loads(z.read(widget[0]))
        exe = widget[0][:-len('Info.plist')] + str(wp.get('CFBundleExecutable', 'HairpinWidget'))
        if exe not in names:
            fail.append('widget executable missing: ' + exe)
        else:
            hits = z.read(exe).count(XL)
            print('widget XL case in binary:', 'PRESENT' if hits else 'ABSENT', '(hits=%d)' % hits,
                  'DTSDKName=' + str(wp.get('DTSDKName')))
            expect = (sdk_major(wp.get('DTSDKName')) or 0) >= 27 or (xcode_major(want_xcode) or 0) >= 27
            if expect and not hits:
                fail.append('XL family compiled OUT (gate closed) on a 27 SDK / Xcode ' + str(want_xcode or wp.get('DTXcodeBuild')))

    # ── CarPlay entitlement, parsed out of the signature (and the profile, when there is one) ──
    mainexe = app + str(ap.get('CFBundleExecutable', ''))
    if mainexe not in names:
        fail.append('main executable missing: ' + mainexe)
    else:
        ents = [p for p in embedded_plists(z.read(mainexe)) if 'application-identifier' in p or CARPLAY in p]
        signed = any(p.get(CARPLAY) is True for p in ents)
        print('signature entitlements plists=%d carplay-maps=%s team=%s' % (
            len(ents), 'true' if signed else 'MISSING',
            next((p.get('com.apple.developer.team-identifier') for p in ents if p.get('com.apple.developer.team-identifier')), '-')))
        if not signed:
            fail.append(CARPLAY + ' missing from the code signature - CarPlay would not list the app')
    prov = app + 'embedded.mobileprovision'
    if prov in names:
        pp = [p for p in embedded_plists(z.read(prov)) if isinstance(p.get('Entitlements'), dict)]
        granted = any(p['Entitlements'].get(CARPLAY) is True for p in pp)
        print('embedded.mobileprovision name=%s carplay-maps=%s' % (
            next((p.get('Name') for p in pp), '-'), 'true' if granted else 'MISSING'))
        if not granted:
            fail.append(CARPLAY + ' missing from embedded.mobileprovision')
    else:
        print('embedded.mobileprovision: not in this IPA (profile check skipped)')

    # ── expo-updates: runtime + channel ──
    expo = app + 'Expo.plist'
    if expo in names:
        e = plistlib.loads(z.read(expo))
        rtv = e.get('EXUpdatesRuntimeVersion', '-')
        hdrs = e.get('EXUpdatesRequestHeaders') or {}
        ch = hdrs.get('expo-channel-name', '-') if isinstance(hdrs, dict) else '-'
        print('Expo.plist runtime=' + str(rtv) + ' channel=' + str(ch))
        if want_rtv and rtv != want_rtv:
            fail.append('runtime ' + str(rtv) + ' expected ' + want_rtv)
        if ch != CHANNEL:
            fail.append('channel ' + str(ch) + ' - OTAs on ' + CHANNEL + ' would never reach this binary')
    else:
        fail.append('Expo.plist missing')

    # ── the OpenWeather key in the embedded JS (presence only) ──
    bundle = app + 'main.jsbundle'
    key_path = os.environ.get('OW_KEY') or os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'ota', 'ow.key')
    try:
        if bundle not in names:
            fail.append('main.jsbundle missing')
        elif not os.path.exists(key_path):
            fail.append(os.path.relpath(key_path) + ' missing - create it with the env:exec line in the docstring')
        else:
            key = open(key_path, 'rb').read().strip()
            if len(key) != 32:
                fail.append('key file wrong length (value not printed)')
            else:
                data = z.read(bundle)
                present = key in data
                print('main.jsbundle size=%d KEY_PRESENT=%d openweathermap=%d' % (
                    len(data), 1 if present else 0, data.count(b'openweathermap')))
                if not present:
                    fail.append('KEY_PRESENT=0 - weather dead on every surface')
    finally:
        if os.path.exists(key_path) and os.environ.get('KEEP_OW_KEY') != '1':
            os.remove(key_path)
            print('removed ' + os.path.relpath(key_path) + ' (KEEP_OW_KEY=1 keeps it)')

    if fail:
        print('FAIL:')
        for f in fail:
            print('  ' + f)
        sys.exit(1)
    print('OK')


if __name__ == '__main__':
    main()
