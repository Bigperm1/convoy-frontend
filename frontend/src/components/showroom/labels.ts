// showroom/labels.ts — what the Showroom calls each car (2026-09-22).

import { getVehicleClass, getClassPaint, type Settings, type VehicleClass } from "../../settings";
import { classPaintName } from "../../classModels";
import type { GarageState } from "../../garageStore";
import { CLASS_3D_KEYS, CLASS_3D_SOON, class3dChoice, identityFor, isClass3dKey, type GarageCar } from "../../garageCars";

// ---- The class picker (moved unchanged from app/(app)/garage.tsx) ----
// Top-down vehicle classes. Hatchback previews with the GR Corolla asset; the rest use MCI glyph
// PLACEHOLDERS until Jeff's top-down class photos land.
export const VEHICLE_CLASSES: { key: VehicleClass; label: string; icon: string }[] = [
  { key: "hatchback", label: "Hot Hatch", icon: "car-hatchback" }, // storage key stays 'hatchback'
  { key: "muscle", label: "Muscle", icon: "car-side" },
  { key: "supercar", label: "Supercar", icon: "car-sports" },
  { key: "exotic", label: "Exotic", icon: "car-convertible" },
  { key: "sedan", label: "Sedan", icon: "car" },
  { key: "truck", label: "Truck", icon: "car-pickup" },
  { key: "electric", label: "Electric", icon: "car-electric" },
  { key: "jeep", label: "Jeep", icon: "car-estate" },
  // Motorcycle / ATV / SxS / Boat pulled from the picker 8/20 (Jeff: parked for a future release; the
  // class ladder goes 3D and these have no 3D model planned). The TYPES stay valid so anyone who
  // already picked one keeps rendering.
];

export function classLabel(cls: string): string {
  return VEHICLE_CLASSES.find((c) => c.key === cls)?.label
    ?? (cls ? cls.charAt(0).toUpperCase() + cls.slice(1) : "Class car");
}

/** Customize's 3D class picker: the three classes with a model first, then the five that are coming (Jeff scans
 *  each class in turn) — same labels and icons as the class picker above. */
export const CLASS_3D_PICKER: { key: VehicleClass; label: string; icon: string; soon: boolean }[] =
  [...CLASS_3D_KEYS, ...CLASS_3D_SOON].map((key) => {
    const c = VEHICLE_CLASSES.find((v) => v.key === key);
    return { key, label: c?.label ?? classLabel(key), icon: c?.icon ?? "car", soon: !isClass3dKey(key) };
  });

/** The class car's paint in words: the real paint name when the class palette has it, else the hex. */
export function classPaintWords(s: Settings): string {
  const cls = getVehicleClass(s);
  const p = getClassPaint(s);
  if (!p.primary) return "Original paint";
  return classPaintName(cls, p.primary) ?? p.primary.toUpperCase();
}

const joinMM = (make?: string, model?: string) => [make, model].filter((x) => !!x && x.trim()).join(" ").trim();

/** The car's big name on the stage: the member's nickname when they gave one. */
export function carName(car: GarageCar, s: Settings, g: GarageState): string {
  const nick = g.nicknames[car.id]?.trim();
  if (nick) return nick;
  switch (car.kind) {
    case "arrow": return "Arrow";
    case "arrow3d": return "3D Arrow";
    case "class": return classLabel(getVehicleClass(s));
    // Gold's 3D class car is headlined by the member's 3D CLASS choice — "Exotic · 3D" — and it is that class's
    // car on the stage and the map (garageCars.class3dChoice; Jeff, 2026-09-23).
    case "class3d": return `${classLabel(class3dChoice(s, g).cls)} · 3D`;
    case "scan": {
      if (car.building) return "Building your car";
      const id = identityFor(car.id, s, g);
      return joinMM(id.make, id.model) || "Your scanned car";
    }
  }
}

function shortDate(iso?: string | null): string | null {
  const t = iso ? Date.parse(iso) : NaN;
  if (!Number.isFinite(t)) return null;
  return new Date(t).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

export const scannedOn = (car: GarageCar): string | null => shortDate(car.createdAt);

/** The line under the name — what it is and which map it drives on (the approved sub lines). */
export function carSub(car: GarageCar, s: Settings, g: GarageState): string {
  switch (car.kind) {
    case "arrow":
      return s.arrowPaint?.primary || s.arrowPaint?.secondary
        ? "Your painted arrow · 2D map"
        : "The 2D green arrow · 2D map";
    case "arrow3d":
      return "The 3D arrow · 3D map";
    case "class":
      return `Class car · ${classPaintWords(s)} · 2D map`;
    case "class3d": {
      // The real car and the real paint of the bake it drives: "Lexus LFA · Pearl Blue · 3D map".
      const c = class3dChoice(s, g);
      return `${c.make} ${c.model} · ${c.paint} · 3D map`;
    }
    case "scan": {
      if (car.building) return "Rebuilding it in 3D from your four photos";
      const id = identityFor(car.id, s, g);
      const mm = joinMM(id.make, id.model);
      return mm ? `Your scanned ${mm} · 3D map` : "Your own car, scanned · 3D map";
    }
  }
}
