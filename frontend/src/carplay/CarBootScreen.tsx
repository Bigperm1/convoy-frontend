// CarBootScreen — what the car surface shows before there is a GPS fix to map.
//
// ── THE NEW BRAND, AND ONLY THE NEW BRAND (Jeff, 2026-09-13) ─────────────────
// "why are we using that old screen alfred sent????? i specifically said to remove
//  everything in the files that used that old logo."
// This used to draw assets/final_icon.png — the pre-rebrand green "C" pin — over the word
// HAIRPIN in plain text and the tagline "Drive together". It was the LAST place in the app
// that old mark survived, and Alfred photographed it on his PHONE on 09-13 (a CarPlay
// cold boot that laid the car surface out at 402x874; see
// memory alfred-phone-shows-carplay-boot-screen). It is now the launch splash's own art
// (assets/images/splash2.png): the bevelled Hairpin wordmark over the wireframe terrain
// with the green road through it.
//
// ── WHY THREE NEW FILES AND NOT splash2.png DIRECTLY ─────────────────────────
// splash2 is a 1080x1920 PORTRAIT image with the wordmark baked into its top quarter.
// Car canvases are wide and short — 470x265, 427x240, 775x291 measured — so a cover crop
// of the whole splash keeps a slice of grid and cuts the wordmark off entirely. On a WIDE
// canvas the parts are split instead, cut from the same art (a PORTRAIT canvas just draws
// splash2 itself — see the branch below):
//   car-boot-road.jpg      splash2 y 700-1500, the S-curve of the road (JPEG: 143 KB vs a
//                          PNG of that grid noise several times larger)
//   car-boot-wordmark.png  hairpin-word.png trimmed to its alpha bounds — the source has
//                          ~40% transparent padding, which makes `contain` sizing guesswork
//   car-boot-fade.png      a 1x128 black→clear ramp, stretched over the band's top edge
// New file NAMES, not new pixels under old names: the OTA asset path-key trap (see
// ConvoyLogo.tsx) means a changed image under an unchanged require() path ships nothing.
//
// ── WHY THE FADE IS AN IMAGE, NOT A LinearGradient ───────────────────────────
// This component renders on Android Auto too (registerAndroidAuto.ts registers ConvoyCarPlay's
// CarSurface as 'convoy-aa-nav'), and LinearGradient on the AA car surface is
// one of the two changes held iOS-only since the 2026-08-18 crash bisect (see the speed
// pill in ConvoyCarPlay.tsx). A stretched PNG is a plain <Image>, which this surface has
// always drawn on both head units.
//
// ── WHAT IS MISSING (build 79, 2026-09-14) ────────────────────────────────────
// This screen is what the car shows whenever there is no fix, and a missing location permission
// used to leave the driver looking at the wordmark with no explanation. `status` (words from
// carStatusCopy.ts, decided by carStatus.ts) is drawn under the wordmark. It is our own surface,
// never a presented or pushed template, so it can never cover a car button (CARPLAY.md rule 5).
// SHORT canvases (h < COMPACT_H): the measured Android Auto canvas is 213x107 dp (memory
// android-auto-canvas-measured) and this screen is NOT scaled by hudScale. Wordmark + title + two
// detail lines lands at ~108 dp on a 107 dp canvas (review, 2026-09-14 — HYPOTHESIS on exact glyph
// widths until a bench render), so there the words REPLACE the wordmark and are centred.
import React, { useState } from 'react';
import { Image, StyleSheet, Text, View } from 'react-native';

const WORDMARK_ASPECT = 928 / 248;
const SPLASH_W = 1080;
const SPLASH_H = 1920;
// Below this height the message replaces the wordmark instead of stacking under it (see header).
// 160 sits between the 107 dp AA canvas and the shortest measured CarPlay canvas (240 pt).
const COMPACT_H = 160;

type Props = {
  navigating: boolean;
  distanceToTurn?: string;
  instruction?: string;
  metaLine?: string;
  nearby?: number;
  /** Self-diagnosing readout, shown only when Settings → CarPlay debug is on. */
  debugText?: string | null;
  /** What is missing, in words the car may show (carStatusCopy.ts). null = nothing to say. */
  status?: { title: string; detail?: string } | null;
};

export default function CarBootScreen({ navigating, distanceToTurn, instruction, metaLine, nearby, debugText, status }: Props) {
  const [box, setBox] = useState({ w: 0, h: 0 });
  const { w, h } = box;
  // PORTRAIT gets the launch splash itself, untouched: it IS a portrait image, and it is the
  // screen the driver just saw at boot. Only a wide car canvas needs the split layout below.
  // (A portrait car surface should not exist — the one we have seen is the 402x874 phone-sized
  // window from a CarPlay cold boot — but if it paints, it paints the right brand.)
  const landscape = w >= h;
  // The road band owns the lower 60%; the wordmark sits over black above it.
  const bandH = h * 0.6;
  // Height-limited on a short canvas: 775x291 would otherwise hand the wordmark 356 pt of
  // width and push it down into the road.
  const wmW = Math.min(w * 0.46, h * 0.26 * WORDMARK_ASPECT);
  const wmH = wmW / WORDMARK_ASPECT;
  const headCenterY = h * 0.26;
  const coverSc = Math.max(w / SPLASH_W, h / SPLASH_H);
  const compact = h < COMPACT_H;

  return (
    <View
      // PURE black, not the surface's #0B0B0C: the art's ground is #000, and the fade ramps to
      // #000, so anything lighter shows as a hard line where the road band starts (seen on the
      // 09-13 sim bench before this was set).
      style={[StyleSheet.absoluteFill, styles.root]}
      pointerEvents="none"
      onLayout={(e) => {
        const { width, height } = e.nativeEvent.layout;
        if (Math.abs(width - w) > 1 || Math.abs(height - h) > 1) setBox({ w: width, h: height });
      }}
    >
      {w > 0 && h > 0 && !landscape ? (
        <>
          {/* Cover math done HERE, with an explicit box — the same way AnimatedSplash sizes this
              image. `absoluteFill` + resizeMode="cover" drew it ~2.7x too large on the 09-13 sim
              bench (the H filled the canvas). */}
          <Image
            source={require('../../assets/images/splash2.png')}
            resizeMode="stretch"
            style={{ position: 'absolute', width: SPLASH_W * coverSc, height: SPLASH_H * coverSc, left: (w - SPLASH_W * coverSc) / 2, top: (h - SPLASH_H * coverSc) / 2 }}
          />
          {!!status && (
            <View style={[styles.head, { top: h * 0.62, height: undefined }]}>
              <Text style={styles.statusTitle} numberOfLines={2}>{status.title}</Text>
              {!!status.detail && <Text style={styles.statusDetail} numberOfLines={2}>{status.detail}</Text>}
            </View>
          )}
          {!!debugText && <Text style={styles.dbg} numberOfLines={2}>{debugText}</Text>}
        </>
      ) : w > 0 && h > 0 ? (
        <>
          <Image
            source={require('../../assets/images/car-boot-road.jpg')}
            resizeMode="cover"
            style={[styles.band, { height: bandH }]}
          />
          <Image
            source={require('../../assets/images/car-boot-fade.png')}
            resizeMode="stretch"
            style={[styles.fade, { top: h - bandH, height: bandH * 0.45 }]}
          />
          {navigating ? (
            // No fix yet, but a route is running: the driver needs the turn, not the brand.
            <View style={[styles.head, { top: h * 0.08, height: h - bandH * 0.55 - h * 0.08 }]}>
              <Text style={styles.dist}>{distanceToTurn || '—'}</Text>
              <Text style={styles.inst} numberOfLines={2}>{instruction || 'Continue'}</Text>
              {!!metaLine && <Text style={styles.meta}>{metaLine}</Text>}
              {/* NOT on a short canvas: the 09-14 bench at 213x107 showed this branch ALREADY overflows
                  (the 48 pt distance is clipped at the top), and a status line there was cut off at the
                  bottom. Navigating on Android Auto with no fix is the rare case; the turn keeps the room. */}
              {!!status && !compact && (
                <Text style={styles.statusTitle} numberOfLines={1} adjustsFontSizeToFit minimumFontScale={0.7}>{status.title}</Text>
              )}
            </View>
          ) : status && compact ? (
            // Short canvas (Android Auto 213x107): the words replace the wordmark (review correction 4).
            // The box stays clear of what ConvoyCarPlay.tsx documents Android Auto drawing over this
            // surface: the crew pill and the host's top-right action strip (text starts below ~17 dp,
            // where the AA status row sits at hudScale 0.446), the host's right-hand zoom rail
            // (CAR_RIGHT_INSET 28 on AA) and the bottom-left speedo (21 dp tall at 6 dp). DERIVED, not
            // photographed — and the titled "Allow location" action makes that top strip wider than the
            // ~128 dp start measured with icons (unmeasured). A head-unit photo settles it.
            <View style={[styles.head, styles.headCompact]}>
              <Text style={[styles.statusTitle, styles.statusTitleCompact]} numberOfLines={1} adjustsFontSizeToFit minimumFontScale={0.7}>{status.title}</Text>
              {!!status.detail && (
                <Text style={styles.statusDetail} numberOfLines={3} adjustsFontSizeToFit minimumFontScale={0.7}>{status.detail}</Text>
              )}
            </View>
          ) : (
            <View style={[styles.head, { top: headCenterY - wmH / 2, height: undefined }]}>
              <Image
                source={require('../../assets/images/car-boot-wordmark.png')}
                resizeMode="contain"
                style={{ width: wmW, height: wmH }}
              />
              {status ? (
                <>
                  <Text style={styles.statusTitle} numberOfLines={1} adjustsFontSizeToFit minimumFontScale={0.8}>{status.title}</Text>
                  {!!status.detail && (
                    <Text style={styles.statusDetail} numberOfLines={2} adjustsFontSizeToFit minimumFontScale={0.8}>{status.detail}</Text>
                  )}
                </>
              ) : !!nearby && nearby > 0 ? (
                <Text style={styles.nearby}>{`${nearby} ${nearby === 1 ? 'car' : 'cars'} nearby`}</Text>
              ) : null}
            </View>
          )}
          {!!debugText && <Text style={styles.dbg} numberOfLines={2}>{debugText}</Text>}
        </>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  root: { backgroundColor: '#000' },
  band: { position: 'absolute', left: 0, right: 0, bottom: 0, width: '100%' },
  fade: { position: 'absolute', left: 0, right: 0, width: '100%' },
  head: { position: 'absolute', left: 0, right: 0, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 20 },
  nearby: { color: '#C9D1CC', fontSize: 15, fontWeight: '600', marginTop: 10 },
  dist: { color: '#F4F4F4', fontSize: 48, fontWeight: '800', letterSpacing: -1 },
  inst: { color: '#F4F4F4', fontSize: 22, fontWeight: '600', marginTop: 4, textAlign: 'center' },
  meta: { color: '#9AA0A6', fontSize: 18, marginTop: 10 },
  dbg: { position: 'absolute', left: 12, right: 12, bottom: 8, color: '#77FF88', fontSize: 11, fontWeight: '700', textAlign: 'center' },
  // Status lines sit over black above the road band (and over the art on portrait) — the shadow is
  // for where the fade meets the road.
  statusTitle: { color: '#F4F4F4', fontSize: 17, fontWeight: '700', marginTop: 10, textAlign: 'center', textShadowColor: 'rgba(0,0,0,0.9)', textShadowRadius: 4, textShadowOffset: { width: 0, height: 1 } },
  statusTitleCompact: { marginTop: 0 },
  headCompact: { top: 18, bottom: 24, height: undefined, paddingLeft: 12, paddingRight: 34 },
  statusDetail: { color: '#C9D1CC', fontSize: 14, fontWeight: '600', marginTop: 2, textAlign: 'center', textShadowColor: 'rgba(0,0,0,0.9)', textShadowRadius: 4, textShadowOffset: { width: 0, height: 1 } },
});
