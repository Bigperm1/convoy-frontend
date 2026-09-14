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
import React, { useState } from 'react';
import { Image, StyleSheet, Text, View } from 'react-native';

const WORDMARK_ASPECT = 928 / 248;
const SPLASH_W = 1080;
const SPLASH_H = 1920;

type Props = {
  navigating: boolean;
  distanceToTurn?: string;
  instruction?: string;
  metaLine?: string;
  nearby?: number;
  /** Self-diagnosing readout, shown only when Settings → CarPlay debug is on. */
  debugText?: string | null;
};

export default function CarBootScreen({ navigating, distanceToTurn, instruction, metaLine, nearby, debugText }: Props) {
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
            </View>
          ) : (
            <View style={[styles.head, { top: headCenterY - wmH / 2, height: undefined }]}>
              <Image
                source={require('../../assets/images/car-boot-wordmark.png')}
                resizeMode="contain"
                style={{ width: wmW, height: wmH }}
              />
              {!!nearby && nearby > 0 && (
                <Text style={styles.nearby}>{`${nearby} ${nearby === 1 ? 'car' : 'cars'} nearby`}</Text>
              )}
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
});
