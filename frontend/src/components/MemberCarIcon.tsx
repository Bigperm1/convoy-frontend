// MemberCarIcon.tsx — THE round (or square) member icon, drawn as the car that member actually drives
// (Jeff, 2026-09-23: "make sure that the user icons are the actual class/color/2d/3d for all the round user
// icons system wide").
//
// Before this every roster, sheet and card drew getVehiclePngOrDefault(car_color) — the GR Corolla top-down
// photo in the member's paint, whatever they had picked in the Garage: an arrow driver was a grey GRC, a
// Silver exotic was a grey GRC, a Gold 3D class car was a grey GRC. The phone map's CarMarker
// (ConvoyMapbox.tsx) already knew better — arrow → glyph, class → ClassSprite, else the colour picture — so
// this is that rule, lifted into one component every site shares.
//
// ONE identity, FOUR sources, in this order (memberIdentityFrom):
//   1. LIVE PRESENCE for the member's user id (convoyPresence payload: marker/cls/clsPri/clsSec/arrPri/arrSec/
//      arrPick/scanId/activeColor) — exactly what the map draws for them right now.
//   2. The backend profile's `appearance` field ({kind, cls?, pri?, sec?, bake?}) when the roster carries it —
//      the car they chose, even offline. Tolerated absent: the backend is growing it separately.
//   3. Their REAL car from the profile: car_scan_id → the scan's hero shot; car_color → the colour picture.
//   4. Nothing known → the default colour picture (Heavy Metal GRC), as before.
// The member's OWN icon (the Club driver band, your rows) never guesses: memberIdentityForSelf reads local
// settings + the Garage store (activeCarId / class3dChoice), the same source the map draws you from.
//
// Rendering, by kind (all static art — no WebView, no 3D, no map):
//   scan     the hero shot (car-scans/<id>/hero.jpg, cached on disk — the MemberCarousel loader), and the colour
//            picture when it has not been uploaded / cannot load
//   class    ClassSprite — the map's own top-down class sprite in the member's paint (canonicalClass)
//   arrow    Arrow2D — the 2D map arrow, straight down, in their arrow paint (stock green/white unpainted)
//   arrow3d  Arrow3D — the chase-cam arrow in their arrow paint
//   class3d  Class3DStill — the 3/4 render of the class's white bake painted in the bake's hex, for the three
//            classes that have a model (hatchback / supercar / exotic); any other 3D paint (Yaris, S2000, M2,
//            LC) is the colour picture of that paint
//   car      getVehiclePngOrDefault(color) — the 44 pt top-down picture of that paint
// The frame keeps whatever the site had — size, round/square, ring, background (pass them in `style`) — and
// the art is INSET so it never touches the frame: a nose-up class sprite at 82 % of the box has a diagonal
// of 0.88 × size, the widest still (the 3D class car at 84 %) 0.95 × size, both inside a circle of that
// diameter. A scan's hero shot fills the frame edge to edge, as the Crew tiles always showed it.
//
// React.memo on the identity's VALUE (memberIdentityKey), not its object — resolvers build a fresh identity
// object every render, so a shallow compare would never hit.

import React, { useState } from "react";
import { Image as RNImage, StyleSheet, View, type StyleProp, type ViewStyle } from "react-native";
import { Image } from "expo-image";
import { ClassSprite } from "../classLayers";
import { Arrow2D, Arrow3D, Class3DStill } from "./showroom/CarArt";
import { getVehiclePngOrDefault, resolveGRCKey } from "../vehicleAssets";
import { scanHeroImageSource } from "../carScan";
import { CLASS_MODEL_3D } from "../classModels";
import { canonicalClass, getClassPaint, getVehicleClass, type Settings } from "../settings";
import { CLASS_3D_KEYS, activeCarId, class3dChoice, isClass3dKey, type Class3dKey } from "../garageCars";
import type { GarageState } from "../garageStore";

// ── Types ─────────────────────────────────────────────────────────────────────────────────────────────

export type MemberIdentityKind = "arrow" | "arrow3d" | "class" | "class3d" | "scan" | "car";

/** What one member icon draws. `color` is any paint label or grc_* slug (the colour picture, the 3D class
 *  bake, a scan's fallback); `activeColor` the presence slug when the member is live. */
export type MemberIdentity = {
  kind?: MemberIdentityKind;
  cls?: string;
  pri?: string;
  sec?: string;
  scanId?: string;
  color?: string;
  activeColor?: string;
};

/** The backend profile's `appearance` as the rosters echo it (server.py _clean_appearance). Read tolerantly —
 *  a member whose profile predates the field has none, and a malformed one draws the real car instead. */
export type MemberAppearance = {
  kind: MemberIdentityKind;
  cls?: string;
  pri?: string;
  sec?: string;
  /** class3d: the bake's GRCColorKey. */
  bake?: string;
};

/** A live presence payload (ConvoyPresencePeer / ConvoyMapbox Peer / presenceHub RawPeer) — every field
 *  optional so any of the three shapes fits. */
export type PresenceLike = {
  user_id?: string;
  marker?: string;
  cls?: string;
  clsPri?: string;
  clsSec?: string;
  arrPri?: string;
  arrSec?: string;
  arrPick?: string;
  scanId?: string;
  activeColor?: string;
  carColor?: string;
};

/** ANY of the app's member objects: a presence Peer, a CarouselMember, a roster members_users / attendees_users /
 *  pending_users / /users/search row, talk's RosterMember, or just `{ id }` from a PTT message. */
export type MemberLike = PresenceLike & {
  id?: string | number;
  car_color?: string | null;
  car_scan_id?: string | null;
  appearance?: MemberAppearance | null;
};

/** Where to look a member up by user id: the map's livePeerById, the hub's raw crew list, or one peer. */
export type LiveLookup = ReadonlyMap<string, PresenceLike> | ReadonlyArray<PresenceLike> | PresenceLike | null | undefined;

// ── Resolution ────────────────────────────────────────────────────────────────────────────────────────

/** The 3D class a paint belongs to, when it is one of the three classes' authored bakes (CLASS_MODEL_3D). */
function class3dFor(color?: string | null): { cls: Class3dKey; hex: string } | null {
  const key = resolveGRCKey(color);
  if (!key) return null;
  for (const cls of CLASS_3D_KEYS) {
    const e = CLASS_MODEL_3D[cls]?.palette.find((x) => x.modelKey === key);
    if (e) return { cls, hex: e.hex };
  }
  return null;
}

/** The hex Class3DStill paints: the bake's swatch, else the class's first bake (a class3d identity whose colour
 *  did not resolve — a backend `bake` this build does not know yet). */
function class3dHex(cls: Class3dKey, color?: string | null): string {
  const key = resolveGRCKey(color);
  const pal = CLASS_MODEL_3D[cls]?.palette ?? [];
  return (key && pal.find((x) => x.modelKey === key)?.hex) || pal[0]?.hex || "#F0F0F0";
}

/** What the map draws for a live peer — the presence payload, read by the CarMarker's own rule plus the
 *  Garage's: marker 'car' with no scan IS the 3D class car when the paint is one of the class bakes
 *  (garageCars.activeCarId), else the colour picture. */
export function identityFromPresence(p: PresenceLike): MemberIdentity {
  const color = p.activeColor || p.carColor || undefined;
  if (p.marker === "arrow") {
    return { kind: p.arrPick === "arrow3d" ? "arrow3d" : "arrow", pri: p.arrPri, sec: p.arrSec, color, activeColor: p.activeColor };
  }
  if (p.marker === "class") {
    return { kind: "class", cls: canonicalClass(p.cls), pri: p.clsPri, sec: p.clsSec, color, activeColor: p.activeColor };
  }
  if (p.scanId) return { kind: "scan", scanId: p.scanId, color, activeColor: p.activeColor };
  const c3 = class3dFor(color);
  if (c3) return { kind: "class3d", cls: c3.cls, color, activeColor: p.activeColor };
  return { kind: "car", color, activeColor: p.activeColor };
}

/** The backend's `appearance` → identity. null when it cannot be drawn (unknown kind, a scan with no
 *  car_scan_id, a 3D class with neither a known bake nor a class) — the caller falls through to the real car. */
export function identityFromAppearance(a: MemberAppearance | null | undefined, m: MemberLike): MemberIdentity | null {
  if (!a || typeof a !== "object" || typeof a.kind !== "string") return null;
  const color = m.car_color || m.carColor || undefined;
  const pri = typeof a.pri === "string" ? a.pri : undefined;
  const sec = typeof a.sec === "string" ? a.sec : undefined;
  switch (a.kind) {
    case "arrow":
    case "arrow3d":
      return { kind: a.kind, pri, sec, color };
    case "class":
      return { kind: "class", cls: canonicalClass(typeof a.cls === "string" ? a.cls : undefined), pri, sec, color };
    case "class3d": {
      const bake = typeof a.bake === "string" ? a.bake : undefined;
      const c3 = class3dFor(bake);
      if (c3) return { kind: "class3d", cls: c3.cls, color: bake };
      if (isClass3dKey(a.cls)) return { kind: "class3d", cls: a.cls, color: bake ?? color };
      return null;
    }
    case "scan":
      return m.car_scan_id ? { kind: "scan", scanId: m.car_scan_id, color } : null;
    case "car":
      return { kind: "car", color };
    default:
      return null;
  }
}

/** The real car from the profile: the scan's hero shot when they have one, else the colour picture. */
export function identityFromProfile(m: MemberLike): MemberIdentity {
  const color = m.car_color || m.carColor || undefined;
  return m.car_scan_id ? { kind: "scan", scanId: m.car_scan_id, color } : { kind: "car", color };
}

const memberId = (m: MemberLike): string | undefined =>
  m.user_id ? String(m.user_id) : m.id != null && m.id !== "" ? String(m.id) : undefined;

/** A member object that IS a presence payload (a Peer, a RawPeer): it carries the map's appearance fields. */
const carriesPresence = (m: MemberLike): boolean =>
  typeof m.marker === "string" || typeof m.activeColor === "string" || typeof m.scanId === "string";

function lookupLive(id: string | undefined, live: LiveLookup): PresenceLike | undefined {
  if (!live || !id) return undefined;
  if (live instanceof Map) return live.get(id) ?? undefined;
  if (Array.isArray(live)) return (live as ReadonlyArray<PresenceLike>).find((p) => p && String(p.user_id) === id);
  const one = live as PresenceLike;
  return !one.user_id || String(one.user_id) === id ? one : undefined;
}

/**
 * The identity for ANY member object. `live` is where to find their presence payload by user id when they are
 * online (the map's livePeerById, useCrewPeers()'s list, or the one peer already in hand); a member object that
 * is itself a presence payload needs none.
 */
export function memberIdentityFrom(member: MemberLike | null | undefined, live?: LiveLookup): MemberIdentity {
  if (!member) return { kind: "car" };
  const id = memberId(member);
  const peer = lookupLive(id, live) ?? (carriesPresence(member) ? member : undefined);
  if (peer) return identityFromPresence(peer);
  return identityFromAppearance(member.appearance, member) ?? identityFromProfile(member);
}

/** YOUR icon: today's car exactly as the map draws it (settings + the Garage store), never the profile copy —
 *  the profile keeps the real car, not the class car, and knows nothing of the arrow. */
export function memberIdentityForSelf(s: Settings, g: GarageState): MemberIdentity {
  const id = activeCarId(s, g);
  if (id === "arrow" || id === "arrow3d") {
    return { kind: id, pri: s.arrowPaint?.primary, sec: s.arrowPaint?.secondary, color: s.carColor };
  }
  if (id === "class") {
    const p = getClassPaint(s);
    return { kind: "class", cls: getVehicleClass(s), pri: p.primary, sec: p.secondary, color: s.carColor };
  }
  if (id.startsWith("scan:")) return { kind: "scan", scanId: id.slice("scan:".length), color: s.carColor };
  const c = class3dChoice(s, g);
  return { kind: "class3d", cls: c.cls, color: c.modelKey };
}

/** The identity's value as a string — the memo key, and a cheap "did their car change" signature. */
export function memberIdentityKey(i?: MemberIdentity | null): string {
  if (!i) return "";
  return [i.kind ?? "", i.cls ?? "", i.pri ?? "", i.sec ?? "", i.scanId ?? "", i.color ?? "", i.activeColor ?? ""].join("|");
}

// ── Rendering ─────────────────────────────────────────────────────────────────────────────────────────

// Inset of each art kind inside the frame (fraction of the frame's side) — see the header for the geometry.
const INSET = { car: 0.8, class: 0.82, arrow: 0.7, arrow3d: 0.8, class3d: 0.84 } as const;

function CarPicture({ color, size, dim }: { color?: string; size: number; dim?: boolean }) {
  const px = Math.round(size * INSET.car);
  return (
    <RNImage
      source={getVehiclePngOrDefault(color)}
      style={{ width: px, height: px, opacity: dim ? 0.85 : 1 }}
      resizeMode="contain"
      fadeDuration={0}
    />
  );
}

/** The scan's hero shot filling the frame; the colour picture until it loads or when it never does. Keyed by
 *  scanId at the call site so a failed shot is retried for a different scan. */
function ScanHero({ scanId, size, color, dim }: { scanId: string; size: number; color?: string; dim?: boolean }) {
  const [failed, setFailed] = useState(false);
  const src = failed ? null : scanHeroImageSource(scanId);
  if (!src) return <CarPicture color={color} size={size} dim={dim} />;
  return (
    <Image
      source={src}
      style={{ width: size, height: size, opacity: dim ? 0.85 : 1 }}
      contentFit="cover"
      cachePolicy="disk"
      transition={0}
      onError={() => setFailed(true)}
    />
  );
}

function CarArtFor({ identity, size, dim }: { identity: MemberIdentity; size: number; dim?: boolean }) {
  const fade = dim ? { opacity: 0.85 } : null;
  switch (identity.kind) {
    case "scan":
      if (identity.scanId) return <ScanHero key={identity.scanId} scanId={identity.scanId} size={size} color={identity.color} dim={dim} />;
      return <CarPicture color={identity.color} size={size} dim={dim} />;
    case "class":
      return (
        <View style={fade}>
          <ClassSprite vehicleClass={canonicalClass(identity.cls)} primary={identity.pri} secondary={identity.sec} size={Math.round(size * INSET.class)} />
        </View>
      );
    case "arrow":
      return (
        <View style={fade}>
          <Arrow2D width={Math.round(size * INSET.arrow)} primary={identity.pri} secondary={identity.sec} />
        </View>
      );
    case "arrow3d":
      return (
        <View style={fade}>
          <Arrow3D width={Math.round(size * INSET.arrow3d)} primary={identity.pri} secondary={identity.sec} />
        </View>
      );
    case "class3d":
      if (isClass3dKey(identity.cls)) {
        return (
          <View style={fade}>
            <Class3DStill cls={identity.cls} hex={class3dHex(identity.cls, identity.color)} width={Math.round(size * INSET.class3d)} />
          </View>
        );
      }
      return <CarPicture color={identity.color} size={size} dim={dim} />;
    default:
      return <CarPicture color={identity.color} size={size} dim={dim} />;
  }
}

export type MemberCarIconProps = {
  /** The frame's side in pt. */
  size: number;
  /** Always the H menu button's rounded square now (Jeff, 2026-09-24: "consistent with the same square as the H
   *  logo menu for all places"); `round` is kept for the type only and draws the same square. */
  shape?: "round" | "square";
  /** The corner radius — default 28 % of the side, the ConvoyLogo / mapLogoBacking ratio (14 on 50). */
  radius?: number;
  identity?: MemberIdentity | null;
  /** Offline members: the art at 85 % (the Crew carousel's rule — a white paint must still read white). */
  dim?: boolean;
  /** The site's own tint / ring colour. The shape itself is not the site's to change: the radius is applied last. */
  style?: StyleProp<ViewStyle>;
  testID?: string;
};

/** The H menu button's frame (map.tsx mapLogoBacking: 50 × 50, r14, a 1 px 18 % white hairline over clear glass) —
 *  every member icon wears it so a car reads the same in a roster, a sheet, a picker and the Club. On a sheet the
 *  glass is a dark tint rather than a live blur (a blur per row is what the old pill rows cost). */
const FRAME_BORDER = "rgba(255,255,255,0.18)";
const FRAME_FILL = "rgba(20,22,26,0.6)";

function MemberCarIconImpl({ size, radius, identity, dim, style, testID }: MemberCarIconProps) {
  const r = radius ?? Math.round(size * 0.28);
  return (
    <View
      testID={testID}
      style={[
        { width: size, height: size, overflow: "hidden", alignItems: "center", justifyContent: "center", backgroundColor: FRAME_FILL, borderWidth: 1, borderColor: FRAME_BORDER },
        style,
        { width: size, height: size, borderRadius: r },
      ]}
    >
      <CarArtFor identity={identity ?? { kind: "car" }} size={size} dim={dim} />
    </View>
  );
}

const flat = (s: StyleProp<ViewStyle>): string => {
  try { return JSON.stringify(StyleSheet.flatten(s) ?? null); } catch { return ""; }
};

export const MemberCarIcon = React.memo(
  MemberCarIconImpl,
  (a, b) =>
    a.size === b.size && a.shape === b.shape && a.radius === b.radius && a.dim === b.dim && a.testID === b.testID
    && memberIdentityKey(a.identity) === memberIdentityKey(b.identity) && flat(a.style) === flat(b.style),
);

export default MemberCarIcon;
