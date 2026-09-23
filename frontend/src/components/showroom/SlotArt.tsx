// showroom/SlotArt.tsx — what stands on the turntable for each Showroom spot (2026-09-22).
//
// Sizes are the CENTRED size; the stage scales a neighbour down (~0.6) and dims it. Only the centred
// spot may go live (one WebView on the page — see CarArt.tsx).

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
import { identityFor, type GarageCar, type GarageTier } from "../../garageCars";
import type { GarageState } from "../../garageStore";
import { CarBox } from "./Stage";
import { Arrow2D, Arrow3D, Car3DStill, ClassCar, GRC_ASPECT, LiveCar, ScanStill, stillHeight } from "./CarArt";

/** The GLB the live view and the 360° spin load for a car, or null when it has none on this screen
 *  (arrows: the arrow GLB is bundled-only; building scans: not published yet). */
export function carGlbUrl(car: GarageCar, s: Settings, g: GarageState): string | null {
  if (car.kind === "class3d") return getVehicleModelUrl(identityFor(car.id, s, g).color);
  if (car.kind === "scan" && car.scanId && !car.building) return scanHeroUrl(car.scanId);
  return null;
}

const STILL_W = 330;
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

/** Live 3D box: taller than the car so model-viewer's framing leaves it standing on the turntable. */
function LiveBox({ glbUrl, still, onSnapshot }: {
  glbUrl: string; still: React.ReactNode; onSnapshot?: (d: string) => void;
}) {
  const { width: W } = useWindowDimensions();
  const w = Math.min(W - 24, 380);
  return (
    <CarBox width={w} height={250} lift={-56}>
      <LiveCar glbUrl={glbUrl} still={still} onSnapshot={onSnapshot} style={{ width: w, height: 250 }} />
    </CarBox>
  );
}

function stillFor3D(): React.ReactNode {
  return <Car3DStill width={STILL_W} />;
}

export function CarSlotArt({ car, centred, live = centred, s, g, metal, onHeroShot }: {
  car: GarageCar;
  centred: boolean;
  /** May mount the live 3D view (centred, and nothing covering the stage). Defaults to `centred`. */
  live?: boolean;
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
    case "class3d": {
      const url = carGlbUrl(car, s, g);
      if (live && url) return <LiveBox key={car.id} glbUrl={url} still={stillFor3D()} />;
      return (
        <CarBox width={STILL_W} height={Math.round(STILL_W * GRC_ASPECT)}>
          <Car3DStill width={STILL_W} />
        </CarBox>
      );
    }
    case "scan": {
      if (car.building) {
        return centred
          ? <View style={StyleSheet.absoluteFill}><ScanCountdown submittedAt={car.createdAt} /></View>
          : <BuildingPeek metal={metal} />;
      }
      const id = car.scanId!;
      if (live) {
        return (
          <LiveBox
            key={car.id}
            glbUrl={scanHeroUrl(id)}
            still={<ScanStill key={id} scanId={id} width={STILL_W} />}
            onSnapshot={(d) => onHeroShot(id, d)}
          />
        );
      }
      return (
        <CarBox width={STILL_W} height={Math.round(STILL_W * 0.62)}>
          <ScanStill key={id} scanId={id} width={STILL_W} />
        </CarBox>
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
export function LockedSlotArt({ next, centred, live = centred, s }: {
  next: GarageTier;
  centred: boolean;
  /** May mount the live 3D view (the Gold preview). Defaults to `centred`. */
  live?: boolean;
  s: Settings;
}) {
  if (next === "silver") return <ClassSlot s={s} />;
  if (next === "gold") {
    return live
      ? <LiveBox key="locked-gold" glbUrl={getVehicleModelUrl(s.carColor)} still={stillFor3D()} />
      : (
        <CarBox width={STILL_W} height={Math.round(STILL_W * GRC_ASPECT)}>
          <Car3DStill width={STILL_W} />
        </CarBox>
      );
  }
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
 *  (≈12 pt in from the right edge, ≈190 pt down, 34 pt tall). Centred, it sits top-right of the car. */
export function LockedBadge({ lockTier, centred }: { lockTier: LockMetal; centred: boolean }) {
  const { width: W } = useWindowDimensions();
  const at = centred ? { top: 140, right: 26 } : { top: 183, left: W / 2 - 63 };
  return (
    <View style={[styles.lock, at]} pointerEvents="none">
      <TierLock tier={lockTier} size={56} />
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
