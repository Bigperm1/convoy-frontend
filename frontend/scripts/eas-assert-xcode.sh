#!/usr/bin/env bash
# Build 79 (2026-09-14): fail an iOS EAS build in its FIRST MINUTE when it is not running on the exact
# Xcode build the profile demands. Runs from package.json "eas-build-pre-install".
#
# OPT-IN. A no-op unless HAIRPIN_REQUIRE_XCODE_BUILD is set — only the eas.json `mapbox-ios-x27` profile
# sets it — and a no-op on Android (EAS_BUILD_PLATFORM != ios), so the paid Android cloud build and the
# plain `mapbox-ios` cloud profile are untouched.
#
# WHY. The iOS 27 full-page widget (targets/widget/index.swift, `systemExtraLargePortrait`) sits behind
# `#if compiler(>=6.4) && canImport(WidgetKit, _version: 749)`, and that gate closes SILENTLY on a pre-27
# SDK: the build succeeds and the family is simply not in the binary. EAS has no Xcode 27 image (infra
# page checked 2026-09-13; the newest runs macOS 26.5.2, below the RC's "macOS Tahoe 26.6 or later"), so
# build 79 iOS is built LOCALLY on Jeff's Mac. eas.json `image` is ignored for --local builds, and
# xcodebuild follows DEVELOPER_DIR / xcode-select — the currently SELECTED Xcode there is 26.6. An EXACT
# build match, because ASC takes Xcode 27 RC builds for TestFlight + App Store (ASC release notes
# 2026-09-09) and a beta must not ship. 27A266a is the ProductBuildVersion read from the installed
# /Applications/Xcode-27.app/Contents/version.plist on 2026-09-14.
#
# ⚠ WHAT THIS CANNOT SEE. It runs in the npm pre-install hook, not inside fastlane gym, so it proves the
# hook's toolchain, not gym's. The HARD gate is the IPA itself:
#   python3 tools/build/verify-ipa.py <ipa> 27A266a <runtimeVersion> <buildNumber>
# (DTXcodeBuild on every bundle + the XL case in the widget binary). Env plumbing for a local build,
# read 2026-09-14 in the npx cache: eas-cli 24.3.0 build/ios/prepareJob.js puts the profile `env` into
# builderEnvironment.env; eas-cli-local-build-plugin 20.5.1 build.js spreads process.env + that env and
# sets EAS_BUILD_PLATFORM; @expo/build-tools 20.5.1 utils/hooks.js runs this hook with ctx.env.
set -euo pipefail

[ "${EAS_BUILD_PLATFORM:-}" = "ios" ] || exit 0
want="${HAIRPIN_REQUIRE_XCODE_BUILD:-}"
[ -n "$want" ] || exit 0

have="$(xcodebuild -version | awk '/^Build version/ {print $3}')"
sdk="$(xcrun --sdk iphoneos --show-sdk-version)"
echo "[eas-assert-xcode] developer_dir=$(xcode-select -p) DEVELOPER_DIR=${DEVELOPER_DIR:-unset} xcode_build=$have iphoneos_sdk=$sdk want=$want"

if [ "$have" != "$want" ]; then
  echo "[eas-assert-xcode] FAIL: Xcode build $have, profile wants $want — the iOS 27 widget family would be compiled out, or a beta would ship." >&2
  echo "[eas-assert-xcode] run it as: DEVELOPER_DIR=/Applications/Xcode-27.app/Contents/Developer npx eas-cli build --platform ios --profile mapbox-ios-x27 --local" >&2
  exit 1
fi

major="${sdk%%.*}"
if ! [[ "$major" =~ ^[0-9]+$ ]] || [ "$major" -lt 27 ]; then
  echo "[eas-assert-xcode] FAIL: iphoneos SDK $sdk is older than 27 — systemExtraLargePortrait would be compiled out." >&2
  exit 1
fi
echo "[eas-assert-xcode] OK"
