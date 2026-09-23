// showroom/CarArt.tsx — how each car looks on the Showroom stage (2026-09-22).
//
// ONE LIVE 3D VIEW AT A TIME. model-viewer in a WebView is the heavy thing on this screen (a full hero
// GLB is ~9 MB; GarageHeroCarousel used to mount it on every page at once, even while the arrow page
// showed). Here only the CENTRED car may go live; every other car is a still or a sprite:
//   arrow     the 2D arrow: the map's own arrow GLB rendered straight down, so it is exactly what the
//             2D map draws — green body, white rim outline (Jeff, 2026-09-22: "top view 2d with a white
//             outline")
//   arrow3d   the same GLB from the chase cam — behind and above at the map's 48° pitch
//             (chasePitch.ts), nose away from you (Jeff: "the 3d arrow so its chase cam view")
//   class     the class car in the member's class paint: the map's own top-down class sprite (ClassSprite),
//             FLAT and straight down like the 2D arrow — Silver's car is a 2D-map car (Jeff, 2026-09-22:
//             "the … class car need to be 2D top down version and in 2nd slot (silver)")
//   class3d   the member's 3D CLASS car (garageCars.class3dChoice — Jeff, 2026-09-23). Still: the 3/4 render
//             of that class's white bake (Hot Hatch GRC Icecap White, Supercar GT3 RS Carrara White, Exotic
//             LFA Whitest White — restored from ab782791) painted in the chosen bake's hex. Live: that bake's
//             full GLB (getVehicleModelUrl), standing still — the spin is Ultra's. (The scan-built heavy_metal
//             row is not a 3D class colour — garageCars SCAN_BAKES.)
//   scan      still: the car itself, keyed — a transparent PNG this Garage takes of the live model on this phone
//             (scanStill.ts) — so it stands on the turntable exactly as the live model will; until one exists,
//             the scan's hero shot (car-scans/<id>/hero.jpg, a JPEG) as a photo card, or the stock still when a
//             scan has none yet; live: its hero GLB, turning.
//
// EVERY 3D STILL STANDS WHERE ITS LIVE CAR WILL BE (Jeff, 2026-09-23: "when swiping to ultra the 3d car has a
// wierd animation that pops the car into the carasoul, remove that pop and make it smooth"). The live view's
// box (LIVE_H tall, useLiveFrameWidth wide) is the ONE frame a 3D car has, centred or a neighbour, and each still
// is placed inside it at the live model's own framing, so going live changes nothing but which of the two is
// visible — and that is a fade (LiveCar).
// model-viewer frames by bounding sphere (camera-target = bbox centre, radius R = the farthest vertex, camera
// distance R / sin 15°, vertical FOV 30° — the width never binds: the cars' ideal aspect is ~1.0 and the frame is
// wider than that). So a car's size is fixed by the frame HEIGHT and it sits at a fixed offset from the frame's
// centre, whatever the phone's width. The FITs below are that projection of each bake's vertices at the Garage
// orbit (325°, 76°), computed from the GLBs 2026-09-23; the same projection reproduces the still renders'
// measured ink boxes to within 0.3 px, and puts every car inside its frame with room to spare (e.g. the GT3 RS,
// wing included: 218 × 101 pt in a 366 × 250 frame) — so no framing change was needed for any class.
//
// Every rendered still carries the class-sprite paint layers (src/classLayers.tsx): a black floor with
// alpha = the band, then a white mask with alpha = band x shading, tinted at runtime — so any paint hex
// works with no per-colour bake. The arrow's bands are body (primary) and rim (secondary); a class still has
// the body band only.
// Renders: model-viewer 4.0 headless on magenta, keyed — regenerate with tools/garage-stills/render.sh.

import React, { useCallback, useEffect, useRef, useState } from "react";
import { Image as RNImage, StyleSheet, View, useWindowDimensions, type ViewStyle } from "react-native";
import { Image } from "expo-image";
import Animated, {
  ReduceMotion, cancelAnimation, useAnimatedStyle, useSharedValue, withTiming,
} from "react-native-reanimated";
import { scheduleOnRN } from "react-native-worklets";
import { ClassSprite } from "../../classLayers";
import { scanHeroImageSource } from "../../carScan";
import { forgetScanStill, scanStillUri, subscribeScanStills } from "../../scanStill";
import CarHero3D from "../../CarHero3D";
import { MOTION } from "../../motion";
import type { Class3dKey } from "../../garageCars";

type Layers = { black: number; mask: number };
type Still = { base: number; aspect: number; pri?: Layers; sec?: Layers };

const ARROW_2D: Still = {
  base: require("../../../assets/images/garage/garage-arrow-2d.png"),
  aspect: 473 / 540,
  pri: { black: require("../../../assets/images/garage/garage-arrow-2d_bodyblack.png"), mask: require("../../../assets/images/garage/garage-arrow-2d_bodymask.png") },
  sec: { black: require("../../../assets/images/garage/garage-arrow-2d_rimblack.png"), mask: require("../../../assets/images/garage/garage-arrow-2d_rimmask.png") },
};
const ARROW_3D: Still = {
  base: require("../../../assets/images/garage/garage-arrow-3d.png"),
  aspect: 344 / 540,
  pri: { black: require("../../../assets/images/garage/garage-arrow-3d_bodyblack.png"), mask: require("../../../assets/images/garage/garage-arrow-3d_bodymask.png") },
  sec: { black: require("../../../assets/images/garage/garage-arrow-3d_rimblack.png"), mask: require("../../../assets/images/garage/garage-arrow-3d_rimmask.png") },
};
export const GRC_3D = require("../../../assets/images/garage/grc-3d.png");
/** grc-3d.png is 479×251 — keep every box at that aspect or the car squashes. */
export const GRC_ASPECT = 251 / 479;

// ── The live 3D frame ─────────────────────────────────────────────────────────────────────────────────
/** The live view's height — the frame every 3D car stands in (SlotArt Frame3D). The FITs are at this height. */
export const LIVE_H = 250;
/** The live view's width on this phone. */
export function useLiveFrameWidth(): number {
  const { width } = useWindowDimensions();
  return Math.min(width - 24, 380);
}

/** A still's box inside the frame: width, and its top-left as offsets from the frame's centre (pt at LIVE_H). */
type Fit = { w: number; left: number; top: number };

/** The GR Corolla bakes' 3/4 renders, one per 3D class, from the class's WHITE bake (restored from ab782791;
 *  tools/garage-stills/build_stills.py CAR_BANDS made their paint bands). Placed over the live framing of the
 *  bake they were rendered from (out_ice_cap_white · out_gt3rs_carrara_white · out_lfa_whitest_white2 — every
 *  colour of a class is the same mesh: same vertex count, same 1.9101 × h × w box). */
const CLASS_3D_STILL: Record<Class3dKey, Still & { fit: Fit }> = {
  hatchback: {
    base: require("../../../assets/images/garage/garage-class-hatchback.png"),
    aspect: 467 / 900,
    pri: { black: require("../../../assets/images/garage/garage-class-hatchback_priblack.png"), mask: require("../../../assets/images/garage/garage-class-hatchback_primask.png") },
    fit: { w: 230.7, left: -121.8, top: -49.7 },
  },
  supercar: {
    base: require("../../../assets/images/garage/garage-class-supercar.png"),
    aspect: 439 / 900,
    pri: { black: require("../../../assets/images/garage/garage-class-supercar_priblack.png"), mask: require("../../../assets/images/garage/garage-class-supercar_primask.png") },
    fit: { w: 226.4, left: -114.4, top: -50.3 },
  },
  exotic: {
    base: require("../../../assets/images/garage/garage-class-exotic.png"),
    aspect: 403 / 900,
    pri: { black: require("../../../assets/images/garage/garage-class-exotic_priblack.png"), mask: require("../../../assets/images/garage/garage-class-exotic_primask.png") },
    fit: { w: 232.3, left: -123.3, top: -40.1 },
  },
};
/** grc-3d.png over GRC2.glb's live framing (Jeff's own scan, a little bigger than the authored hatch) — the stand-in
 *  for a scan that has no still or hero shot yet.
 *  ⚠ The one still that is NOT an exact match: grc-3d.png predates the Garage orbit renders, and its car's aspect
 *  (479 × 250 ink, 1.916) is not the live GRC2's at this orbit (228.6 × 115.5 pt, 1.979). Fitted by WIDTH and
 *  centred, so the still's car stands ~3.8 pt taller than the live one — ~1.9 pt past the roof and under the tyres
 *  for the 2 × MOTION.duration.fade of a crossfade (fit3d/place.py, 2026-09-23; the class stills are within
 *  −1.5 … +0.2 pt). Exact needs a re-render at the live framing (orbit 325°/76°, 30° FOV, radius 100%) with
 *  tools/garage-stills, then this fit re-measured. */
const GRC2_FIT: Fit = { w: 228.6, left: -118.6, top: -49.2 };

function AtFit({ fit, aspect, children }: { fit: Fit; aspect: number; children: React.ReactNode }) {
  return (
    <View
      style={{
        position: "absolute",
        left: "50%",
        top: "50%",
        marginLeft: fit.left,
        marginTop: fit.top,
        width: fit.w,
        height: Math.round(fit.w * aspect),
      }}
    >
      {children}
    </View>
  );
}

/** Height a still takes at `width`, so the stage can size its box. */
export const stillHeight = (still: "arrow" | "arrow3d", width: number) =>
  Math.round(width * (still === "arrow" ? ARROW_2D : ARROW_3D).aspect);

/** A rendered still with its paint layers: photo → [black + tinted mask] per painted band. */
function PaintedStill({ still, width, primary, secondary }: {
  still: Still; width: number; primary?: string | null; secondary?: string | null;
}) {
  const box = { width, height: Math.round(width * still.aspect) };
  const over = { position: "absolute" as const, top: 0, left: 0, ...box };
  const band = (l: Layers | undefined, tint: string | null | undefined) =>
    l && tint ? (
      <>
        <RNImage source={l.black} style={over} resizeMode="contain" fadeDuration={0} />
        <RNImage source={l.mask} style={[over, { tintColor: tint }]} resizeMode="contain" fadeDuration={0} />
      </>
    ) : null;
  return (
    <View style={box}>
      <RNImage source={still.base} style={box} resizeMode="contain" fadeDuration={0} />
      {band(still.pri, primary)}
      {band(still.sec, secondary)}
    </View>
  );
}

/** The 2D arrow, straight down — the 2D map's own arrow, in the member's arrow paint. */
export function Arrow2D({ width, primary, secondary }: { width: number; primary?: string; secondary?: string }) {
  return <PaintedStill still={ARROW_2D} width={width} primary={primary} secondary={secondary} />;
}

/** The 3D arrow from the chase cam, in the member's arrow paint. */
export function Arrow3D({ width, primary, secondary }: { width: number; primary?: string; secondary?: string }) {
  return <PaintedStill still={ARROW_3D} width={width} primary={primary} secondary={secondary} />;
}

/** The class car in its class paint — the map's own top-down sprite, flat, nose up (the car fills ~95% of
 *  the square's height and ~45% of its width). */
export function ClassCar({ size, vehicleClass, primary, secondary }: {
  size: number; vehicleClass: string; primary?: string | null; secondary?: string | null;
}) {
  return <ClassSprite vehicleClass={vehicleClass} primary={primary} secondary={secondary} size={size} />;
}

/** The stock 3D car still. `silhouette` = the locked "your own car" teaser (no paint, just the shape). */
export function Car3DStill({ width, silhouette }: { width: number; silhouette?: boolean }) {
  const box = { width, height: Math.round(width * GRC_ASPECT) };
  return (
    <RNImage
      source={GRC_3D}
      style={[box, silhouette ? { tintColor: "#2A2F35" } : null]}
      resizeMode="contain"
      fadeDuration={0}
    />
  );
}

/** A 3D class car at `width`, in the bake's paint — the Customize preview. */
export function Class3DStill({ cls, hex, width }: { cls: Class3dKey; hex: string; width: number }) {
  return <PaintedStill still={CLASS_3D_STILL[cls]} width={width} primary={hex} />;
}

/** The 3D class car's still INSIDE the live frame, exactly where its live model will stand. */
export function Class3DFramed({ cls, hex }: { cls: Class3dKey; hex: string }) {
  const st = CLASS_3D_STILL[cls];
  return (
    <AtFit fit={st.fit} aspect={st.aspect}>
      <PaintedStill still={st} width={st.fit.w} primary={hex} />
    </AtFit>
  );
}

/** The stock still (GRC2) inside the live frame, at GRC2's framing. */
function StockFramed() {
  return (
    <AtFit fit={GRC2_FIT} aspect={GRC_ASPECT}>
      <Car3DStill width={GRC2_FIT.w} />
    </AtFit>
  );
}

// The hero shot is the live canvas itself (model-viewer toDataURL, CarHero3D) — a JPEG, so its transparent
// background came out black and it is framed as a photo card on purpose (sim render, 2026-09-22). The card is
// centred on the frame and the photo inside it is drawn at the FRAME's size, 1:1, so the car in the photo lies
// where the live car will (exactly, when the shot was taken in a frame of this width; a shot from a different
// width or from the old Garage's hero box is still centred, just not to the point).
const CARD_W = 300;
const CARD_H = 180;

/** The keyed still's URI for a scan (scanStill.ts), re-read when one is saved. */
function useScanStillUri(scanId: string): string | null {
  const [, bump] = useState(0);
  useEffect(() => subscribeScanStills(() => bump((n) => n + 1)), []);
  return scanStillUri(scanId);
}

/** A scan's still in the live frame: the keyed PNG of its live model when this phone has one — the frame itself,
 *  1:1, no card — else its hero shot as a photo card, else the stock still (only a car that was once live in this
 *  Garage has either — both are taken here). */
export function ScanStill({ scanId }: { scanId: string }) {
  const fw = useLiveFrameWidth();
  const keyed = useScanStillUri(scanId);
  const [failed, setFailed] = useState(false);
  if (keyed) {
    // No transition: it must never fade in from nothing — that would be the pop again.
    return (
      <Image
        source={{ uri: keyed }}
        style={StyleSheet.absoluteFill}
        contentFit="contain"
        transition={0}
        onError={() => forgetScanStill(scanId)}
      />
    );
  }
  const src = failed ? null : scanHeroImageSource(scanId);
  if (!src) return <StockFramed />;
  return (
    <View style={[styles.photo, styles.card]}>
      <Image
        source={src}
        style={{ position: "absolute", left: (CARD_W - fw) / 2, top: (CARD_H - LIVE_H) / 2, width: fw, height: LIVE_H }}
        contentFit="cover"
        cachePolicy="disk"
        transition={180}
        onError={() => setFailed(true)}
      />
    </View>
  );
}

// ── The live car ──────────────────────────────────────────────────────────────────────────────────────
// What used to POP (read 2026-09-23, before this change): the centred car rendered a different tree from its
// neighbour self (SlotArt LiveBox vs CarBox), so going live REMOUNTED the still in another box — a scan's card
// dropped 34 pt, the 3D class still 18 pt, and its hero photo could fade in again from blank; then the frame
// model-viewer said 'load', `{!ready ? still : null}` took the still away in one render and the model was just
// there — ~30% smaller than the 330 pt still (model-viewer's sphere framing puts a car ~220 pt wide in this
// frame), and in another place.
// Now: one frame (above), the still under the model at the model's own framing, and FADES — in: the model fades
// in over the still, and only once it is fully on screen does the still fade out; out: the still fades back in
// first, then the model fades out under it and unmounts. Opacity only, so they run under Reduce Motion too
// (DESIGN.md §11.9 — ReduceMotion.Never, as LogoMenu's fade).
const FADE = { duration: MOTION.duration.fade, easing: MOTION.ease.out, reduceMotion: ReduceMotion.Never };
/** The model's resting opacity while it is not shown: never 0, so the WebView is always DRAWN and its page keeps
 *  animation frames (model-viewer's 'load' waits on two of them). 1% over the still is invisible. */
const DRAWN = 0.01;

/** The one live 3D view: a transparent model-viewer over `still`. `glbUrl` null = the still alone (not centred,
 *  or something covers the stage); the WebView outlives it by the fade-out — or not at all with `instantExit`.
 *  A failed load simply leaves the still. Never interactive — it sits under the stage's swipe layer; the
 *  full-screen spin is CarViewer3D (the "360° spin" action, scans only). */
export function LiveCar({ glbUrl, still, style, onSnapshot, onStill, autoRotate = true, instantExit = false }: {
  glbUrl: string | null;
  still: React.ReactNode;
  style?: ViewStyle;
  onSnapshot?: (jpegDataUri: string) => void;
  /** The model's keyed PNG at its framing orbit (CarHero3D STILL). */
  onStill?: (pngDataUri: string) => void;
  /** false = the model stands still (the 3D class car); only a scan turns. */
  autoRotate?: boolean;
  /** The stage is covered (the 360° viewer, another screen): when `glbUrl` goes null, drop the model at once —
   *  nobody can see a fade, and the WebView must not live on beside the viewer's. */
  instantExit?: boolean;
}) {
  // The model the WebView is showing, and the one that has reported it is on screen.
  const [shown, setShown] = useState<string | null>(glbUrl);
  const [readyUrl, setReadyUrl] = useState<string | null>(null);
  const model = useSharedValue(DRAWN);
  const cover = useSharedValue(1);
  const wantRef = useRef(glbUrl);
  const shownRef = useRef(shown);
  useEffect(() => {
    wantRef.current = glbUrl;
    shownRef.current = shown;
  });

  // The model has faded out under the still: unmount it, or swap in the model wanted now. A fade-out that was
  // reversed in time never gets here (its animation is cancelled) — and if it does, nothing changed.
  const settle = useCallback(() => {
    if (wantRef.current === shownRef.current) return;
    setReadyUrl(null);
    setShown(wantRef.current);
  }, []);

  // A reversal mid-fade settles where it was last sent, because each chain's FIRST step is a no-op when its value
  // is already there: Reanimated's valueSetter completes a withTiming to the value the shared value holds at once
  // (callback(true), no duration — react-native-reanimated 4.1.7 src/valueSetter.ts), so the reversal's second
  // step starts immediately and, by assigning the same value, cancels the stale chain's pending step (which then
  // calls back finished = false). Read, not run on a device (review 2026-09-23 had assumed the opposite).
  useEffect(() => {
    if (glbUrl && glbUrl === shown) {
      if (readyUrl === shown) {
        model.set(withTiming(1, FADE, (done) => {
          "worklet";
          if (done) cover.set(withTiming(0, FADE));
        }));
      } else {
        // Still loading: stay under the still (and stop a fade-out that was on its way to unmounting it).
        cancelAnimation(model);
      }
      return;
    }
    if (glbUrl && !shown) {
      setShown(glbUrl);
      return;
    }
    if (!shown) return;
    if (instantExit) {
      // Covered: nobody sees a fade. Put the still back and let the model go now (a plain assignment cancels
      // whatever chain was running on each value).
      cover.set(1);
      model.set(DRAWN);
      settle();
      return;
    }
    cover.set(withTiming(1, FADE, (done) => {
      "worklet";
      if (done) {
        model.set(withTiming(DRAWN, FADE, (out) => {
          "worklet";
          if (out) scheduleOnRN(settle);
        }));
      }
    }));
  }, [glbUrl, shown, readyUrl, instantExit, model, cover, settle]);

  const coverStyle = useAnimatedStyle(() => ({ opacity: cover.get() }));
  const modelStyle = useAnimatedStyle(() => ({ opacity: model.get() }));

  return (
    <View style={style} pointerEvents="none">
      <Animated.View style={[StyleSheet.absoluteFill, coverStyle]}>{still}</Animated.View>
      {shown ? (
        <Animated.View style={[StyleSheet.absoluteFill, modelStyle]}>
          <CarHero3D
            key={shown}
            glbUrl={shown}
            interactive={false}
            transparent
            autoRotate={autoRotate}
            onReady={() => setReadyUrl(shown)}
            onSnapshot={onSnapshot}
            onStill={onStill}
            style={StyleSheet.absoluteFill}
          />
        </Animated.View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  photo: {
    borderRadius: 22,
    overflow: "hidden",
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: "rgba(255,255,255,0.14)",
    backgroundColor: "#000",
  },
  card: {
    position: "absolute",
    left: "50%",
    top: "50%",
    marginLeft: -CARD_W / 2,
    marginTop: -CARD_H / 2,
    width: CARD_W,
    height: CARD_H,
  },
});
