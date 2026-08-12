// UpdateRequiredGate — hard-stops any build older than MIN_BUILD.
//
// ── WHY (Jeff, 2026-08-12) ───────────────────────────────────────────────────
// "Let's make it so that build 72 is a must for all the TestFlight and Android testers. I
//  don't want anything previous to build 72 to be available... I wanna move forward on a
//  clean slate. Even if the app doesn't work, if they're on build 71, I don't care."
//
// Two mechanisms deliver that, and this is the second one:
//   1. runtimeVersion 1.24.0 on build 72 — an OTA only lands on an EXACT runtime match, so
//      every group published to 1.22.0/1.23.0 is structurally unable to reach a 72 device.
//      That half is automatic and needs no code.
//   2. THIS. Shipped as an OTA to the OLD runtimes (1.22.0 + 1.23.0), it replaces the app on
//      builds 70/71 with a dead end pointing at 72. Store controls alone cannot do this:
//      TestFlight expiry stops new INSTALLS, and Play auto-update is eventually-consistent,
//      so neither is a hard stop on a device already running.
//
// ⚠ IT IS SAFE TO SHIP IN BUILD 72 ITSELF. The test is `build < MIN_BUILD`, and 72 < 72 is
// false, so 72 never blocks itself. That matters because this lives in the shared tree and
// gets baked into 72's embedded bundle either way — it must be inert there by construction,
// not by remembering to strip it.
//
// ⚠ KNOWN HOLE, stated rather than papered over: a device that is not picking up OTAs — the
// exact bug being chased — never receives this gate either, and will keep running happily.
// TestFlight expiry / deactivating old Play releases is what covers those.
//
// Nothing here touches the network, storage, or a permission: it reads one constant and
// renders. A gate that can fail to render is worse than no gate.
import React from 'react';
import { View, Text, StyleSheet, Linking, Pressable, Platform } from 'react-native';
import Constants from 'expo-constants';
import { COLORS } from './theme';

// The first build of the clean slate. Anything below this is end-of-life.
export const MIN_BUILD = 72;

/** Native build number as an integer, or null when it cannot be read. */
export function currentBuild(): number | null {
  try {
    const raw = (Constants as any)?.nativeBuildVersion
      ?? Constants.expoConfig?.ios?.buildNumber
      ?? (Constants.expoConfig as any)?.android?.versionCode;
    const n = Number(String(raw ?? '').trim());
    return Number.isFinite(n) && n > 0 ? n : null;
  } catch { return null; }
}

/**
 * True only when we can PROVE the build is too old. An unreadable build number returns
 * false — fail OPEN. Bricking an app because a constant could not be parsed would be a
 * self-inflicted outage, and the runtime split already isolates 72 regardless.
 */
export function isBuildTooOld(): boolean {
  const b = currentBuild();
  return b !== null && b < MIN_BUILD;
}

const IOS_URL = 'https://testflight.apple.com/';
const ANDROID_URL = 'https://expo.dev/accounts/sw0rdfisch/projects/convoy/builds';

export default function UpdateRequiredGate() {
  const build = currentBuild();
  const isIOS = Platform.OS === 'ios';
  return (
    <View style={styles.wrap}>
      <Text style={styles.h}>Update required</Text>
      <Text style={styles.p}>
        This version of Hairpin ({build != null ? `build ${build}` : 'this build'}) has been
        retired. Everything has moved to <Text style={styles.b}>build {MIN_BUILD}</Text>, and
        older builds no longer receive updates or fixes.
      </Text>
      <Text style={styles.p}>
        {isIOS
          ? 'Open TestFlight and install the latest Hairpin build, then come back.'
          : 'Install the latest Hairpin build from the link Jeff sent, then come back.'}
      </Text>
      <Pressable
        style={styles.btn}
        onPress={() => { Linking.openURL(isIOS ? IOS_URL : ANDROID_URL).catch(() => {}); }}
      >
        <Text style={styles.btnText}>{isIOS ? 'Open TestFlight' : 'Open the install page'}</Text>
      </Pressable>
      <Text style={styles.small}>Claude here (Jeff's AI dev) — sorry for the interruption.</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: COLORS?.bg ?? '#000',
    paddingHorizontal: 28,
    alignItems: 'center',
    justifyContent: 'center',
    zIndex: 9999,
  },
  h: { color: '#fff', fontSize: 26, fontWeight: '800', marginBottom: 14, textAlign: 'center' },
  p: { color: '#c9c9c9', fontSize: 15, lineHeight: 22, textAlign: 'center', marginBottom: 14 },
  b: { color: '#fff', fontWeight: '800' },
  btn: {
    marginTop: 10,
    backgroundColor: COLORS?.accent ?? '#e11d2e',
    paddingHorizontal: 26,
    paddingVertical: 14,
    borderRadius: 999,
  },
  btnText: { color: '#fff', fontSize: 16, fontWeight: '700' },
  small: { color: '#7a7a7a', fontSize: 12, marginTop: 22, textAlign: 'center' },
});
