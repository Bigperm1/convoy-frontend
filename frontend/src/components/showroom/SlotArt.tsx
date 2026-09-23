// showroom/SlotArt.tsx — what stands on the turntable for each Showroom spot (2026-09-22).
//
// Sizes are the CENTRED size; the stage scales a neighbour down (~0.6) and dims it. Only the centred
// spot may go live — see CarArt.tsx; the one overlap is a swipe's handoff, where the car leaving fades out
// under its still (~2 × MOTION.duration.fade) while the new one loads. A 3D car's spot is the SAME tree centred
// or not (Frame3D): only its glbUrl changes, so going live never remounts or moves the still.

import React from "react";
import { StyleSheet, Text, View, useWindowDimensions } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { getClassPaint, getVehicleClass, type Settings } from "../../settings";
import { scanHeroUrl } from "../../carScan";
import { getVehicleModelUrl } from "../../vehicleAssets";
import { skin, type LockMetal, type VisualTier } from "../../tierTheme";
import { withAlpha } from "../../appSkin";
import { TierLock } from "../../PremiumBadge";
import { ScanCountdown, ScanPlaceholder } from "../../ScanHero";
import { class3dChoice, type GarageCar, type GarageTier } from "../../garageCars";
import type { GarageState } from "../../garageStore";
import { CarBox, TURNTABLE_Y } from "./Stage";
import {
  Arrow2D, Arrow3D, Car3DStill, Class3DFramed, ClassCar, GRC_ASPECT, LIVE_H, LiveCar, ScanStill, stillHeight,
  useLiveFrameWidth,
} from "./CarArt";

/** The GLB the live view and the 360° spin load for a car, or null when it has none on this screen
 *  (arrows: the arrow GLB is bundled-only; building scans: not published yet). The 3D class car loads its
 *  chosen bake — the full model; the map loads the same car (getVehicleMapModelUrl of the same key). */
export function carGlbUrl(car: GarageCar, s: Settings, g: GarageState): string | null {
  if (car.kind === "class3d") return getVehicleModelUrl(class3dChoice(s, g).modelKey);
  if (car.kind === "scan" && car.scanId && !car.building) return scanHeroUrl(car.scanId);
  return null;
}

const STILL_W = 330;
/** The lock H's size on a locked spot. */
const LOCK_H = 56;
const ARROW_2D_W = 136;
/** Shrunk from 230 (Jeff, 2026-09-22: "shrink the 3d arrow down a bit"). */
const ARROW_3D_W = 180;
/** The top-down class sprite's square: the car stands ~180 pt tall on it, clear of the words above. */
const CLASS_2D = 190;

/** The class car in its class paint — flat and straight down, hovering over the turntable like the 2D arrow. */
function ClassSlot({ s }: { s: Settings }) {
  const p = getClassPaint(s);
  return (
    <CarBox width={CLASS_2D} height={CLASS_2D} lift={22}>
      <ClassCar size={CLASS_2D} vehicleClass={getVehicleClass(s)} primary={p.primary} secondary={p.secondary} />
    </CarBox>
  );
}

/** The 3D frame's lift: its bottom edge sits this far BELOW the turntable's centre line, so model-viewer's
 *  framing stands the car on the table. */
const FRAME_LIFT = -56;
/** The 3D frame's vertical centre in stage coordinates (CarBox: top = TURNTABLE_Y + 14 − lift − height). Every 3D
 *  still's fit is an offset from this point (CarArt.tsx). */
const FRAME_MID_Y = TURNTABLE_Y + 14 - FRAME_LIFT - LIVE_H / 2;

/** The 3D frame: the live view's box — taller than the car so model-viewer's framing leaves it standing on the
 *  turntable — and the box its still stands in whether or not it is live (the still is placed at the live
 *  model's framing, CarArt.tsx). `glbUrl` null = the still alone. */
function Frame3D({ glbUrl, still, autoRotate, onSnapshot, instantExit }: {
  glbUrl: string | null; still: React.ReactNode; autoRotate: boolean; onSnapshot?: (d: string) => void;
  instantExit?: boolean;
}) {
  const w = useLiveFrameWidth();
  return (
    <CarBox width={w} height={LIVE_H} lift={FRAME_LIFT}>
      <LiveCar
        glbUrl={glbUrl} still={still} autoRotate={autoRotate} onSnapshot={onSnapshot} instantExit={instantExit}
        style={{ width: w, height: LIVE_H }}
      />
    </CarBox>
  );
}

/** Gold's 3D class car — the member's chosen class and bake, standing still (the spin is Ultra's). */
function Class3dSlot({ live, instantExit, s, g }: { live: boolean; instantExit?: boolean; s: Settings; g: GarageState }) {
  const c = class3dChoice(s, g);
  return (
    <Frame3D
      glbUrl={live ? getVehicleModelUrl(c.modelKey) : null}
      autoRotate={false}
      instantExit={instantExit}
      still={<Class3DFramed cls={c.cls} modelKey={c.modelKey} hex={c.hex} />}
    />
  );
}

export function CarSlotArt({ car, centred, live = centred, instantExit, s, g, metal, onHeroShot }: {
  car: GarageCar;
  centred: boolean;
  /** May mount the live 3D view (centred, and nothing covering the stage). Defaults to `centred`. */
  live?: boolean;
  /** Something covers the stage: a live car leaving drops at once instead of fading (CarArt LiveCar). */
  instantExit?: boolean;
  s: Settings;
  g: GarageState;
  metal: VisualTier;
  onHeroShot: (scanId: string, dataUri: string) => void;
}) {
  switch (car.kind) {
    case "arrow":
      // Flat, straight down — it hovers over the turntable like the 2D map's arrow over the road.
      return (
        <CarBox width={ARROW_2D_W} height={stillHeight("arrow", ARROW_2D_W)} lift={22}>
          <Arrow2D width={ARROW_2D_W} primary={s.arrowPaint?.primary} secondary={s.arrowPaint?.secondary} />
        </CarBox>
      );
    case "arrow3d":
      return (
        <CarBox width={ARROW_3D_W} height={stillHeight("arrow3d", ARROW_3D_W)} lift={-6}>
          <Arrow3D width={ARROW_3D_W} primary={s.arrowPaint?.primary} secondary={s.arrowPaint?.secondary} />
        </CarBox>
      );
    case "class":
      return <ClassSlot s={s} />;
    case "class3d":
      return <Class3dSlot live={live} instantExit={instantExit} s={s} g={g} />;
    case "scan": {
      if (car.building) {
        return centred
          ? <View style={StyleSheet.absoluteFill}><ScanCountdown submittedAt={car.createdAt} /></View>
          : <BuildingPeek metal={metal} />;
      }
      const id = car.scanId!;
      // Ultra's own car turns — the only car on the stage that does (Jeff, 2026-09-23).
      return (
        <Frame3D
          glbUrl={live ? scanHeroUrl(id) : null}
          autoRotate
          instantExit={instantExit}
          still={<ScanStill key={id} scanId={id} />}
          onSnapshot={(d) => onHeroShot(id, d)}
        />
      );
    }
  }
}

function BuildingPeek({ metal }: { metal: VisualTier }) {
  const sk = skin(metal);
  return (
    <CarBox width={150} height={150} lift={20}>
      <View style={[styles.ring, { borderColor: withAlpha(sk.accent, 0.45) }]}>
        <Ionicons name="hammer" size={34} color={sk.accent} />
        <Text style={[styles.ringText, { color: sk.accent }]}>BUILDING</Text>
      </View>
    </CarBox>
  );
}

/** The next tier, locked — the real thing it sells, full size, with that tier's H on it. You cannot
 *  want what you cannot see (Jeff, 2026-08-23). */
export function LockedSlotArt({ next, centred, live = centred, instantExit, s, g }: {
  next: GarageTier;
  centred: boolean;
  /** May mount the live 3D view (the Gold preview). Defaults to `centred`. */
  live?: boolean;
  /** Something covers the stage: a live car leaving drops at once instead of fading (CarArt LiveCar). */
  instantExit?: boolean;
  s: Settings;
  g: GarageState;
}) {
  if (next === "silver") return <ClassSlot s={s} />;
  // Gold's preview is the 3D class car it sells — the member's own 3D class choice, as Gold's 4th spot shows it.
  if (next === "gold") return <Class3dSlot live={live} instantExit={instantExit} s={s} g={g} />;
  // next === "ultra": your own car — a shape, not somebody else's car.
  return centred
    ? <ScanPlaceholder />
    : (
      <CarBox width={STILL_W} height={Math.round(STILL_W * GRC_ASPECT)}>
        <Car3DStill width={STILL_W} silhouette />
      </CarBox>
    );
}

/** The next tier's H on its locked spot — full strength even while the car behind it is dimmed (the
 *  stage's badge layer). The locked spot is always the LAST one, so it only ever peeks at the RIGHT
 *  edge, drawn at 0.6 about the stage centre and pushed 0.48 W right (Stage.tsx); this is placed in the
 *  slot's own coordinates so that, after that transform, the H lands where the approved drawing has it
 *  (≈12 pt in from the right edge, ≈190 pt down, 34 pt tall). Centred, it sits top-right of the car.
 *  Gold's preview (Silver's locked spot) is the 3D class car in the live frame (Class3dSlot), not the old 330-pt
 *  still the centred spot was tuned on, so there the H is placed as it sat on that still — its centre 24 pt in
 *  from the car's right edge and 5 pt above its roof: every class's still spans ≈ W/2 − 122 … W/2 + 110 across
 *  and its roof is ≈ 50 pt above the frame's middle (CarArt CLASS_3D_STILL / GRC2_FIT; the Exotic's 10 pt
 *  lower), so the centre is (W/2 + 86, FRAME_MID_Y − 55). The Silver and Ultra previews keep the old spot. */
export function LockedBadge({ lockTier, next, centred }: { lockTier: LockMetal; next: GarageTier; centred: boolean }) {
  const { width: W } = useWindowDimensions();
  const at = !centred
    ? { top: 183, left: W / 2 - 63 }
    : next === "gold"
      ? { top: FRAME_MID_Y - 55 - LOCK_H / 2, left: W / 2 + 86 - LOCK_H / 2 }
      : { top: 140, right: 26 };
  return (
    <View style={[styles.lock, at]} pointerEvents="none">
      <TierLock tier={lockTier} size={LOCK_H} />
    </View>
  );
}

/** Ultra's last spot: "+ Scan a car". Centred, it is the scan invitation (ScanPlaceholder). */
export function AddSlotArt({ centred, metal }: { centred: boolean; metal: VisualTier }) {
  if (centred) return <ScanPlaceholder />;
  const sk = skin(metal);
  return (
    <CarBox width={186} height={144} lift={36}>
      <View style={[styles.addCard, { borderColor: withAlpha(sk.accent, 0.55) }]}>
        <Text style={[styles.addPlus, { color: sk.accent }]}>+</Text>
        <Text style={[styles.addText, { color: sk.accent }]}>SCAN A CAR</Text>
      </View>
    </CarBox>
  );
}

const styles = StyleSheet.create({
  lock: { position: "absolute" },
  ring: {
    width: 150,
    height: 150,
    borderRadius: 75,
    borderWidth: 2,
    alignItems: "center",
    justifyContent: "center",
    gap: 6,
  },
  ringText: { fontSize: 12, fontWeight: "800", letterSpacing: 1.6 },
  addCard: {
    width: 186,
    height: 144,
    borderRadius: 30,
    borderWidth: 2.5,
    borderStyle: "dashed",
    justifyContent: "center",
    paddingLeft: 26,
    gap: 4,
  },
  addPlus: { fontSize: 40, lineHeight: 42, fontWeight: "300" },
  addText: { fontSize: 16, fontWeight: "800", letterSpacing: 0.8 },
});
