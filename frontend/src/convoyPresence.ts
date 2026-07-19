// Supabase Realtime Presence — live peer tracking for the Convoy.
//
// Each user joins a channel and broadcasts their position + metadata. Presence
// auto-handles join/leave so the map updates instantly when someone connects
// or drops off (no polling, no manual disconnect plumbing).
//
// Channel naming convention:
//   - "convoy:global"          — everyone, default
//   - "convoy:community:<id>"   — scoped to a specific community
//
// Each peer payload looks like:
//   { user_id, handle, lat, lng, carType, heading?, online_at }
//
// The actual channel is owned by presenceHub.ts (ONE per topic) — this hook is
// just the phone-map consumer of that hub. See presenceHub for why.

import { useEffect, useRef, useState } from "react";
import { supabase, SUPABASE_ENABLED } from "./supabase";
import { toGRCSlug } from "./vehicleAssets";
import { joinPresence, type PresenceHandle } from "./presenceHub";

export type ConvoyPresencePeer = {
  user_id: string;
  handle?: string;
  lat: number;
  lng: number;
  carType?: string;
  carBody?: string;     // sedan / coupe / suv / sports / truck / hatch / motorcycle / van
  carColor?: string;
  // Canonical GR Corolla broadcast slug (e.g. "grc_heavy_metal"). Empty/undefined
  // when the user hasn't picked one of the official GRC paints — peer marker
  // falls back to the SVG silhouette so we never render a broken image.
  activeColor?: string;
  heading?: number;
  online_at?: string;
  // Personal best top cruise speed (km/h) — broadcast so peers can see each other's record.
  topSpeed?: number;
  // "live" = actively driving; "parked" = full-mode user broadcasting last-known
  // location while their CarPlay/AA head unit is disconnected.
  status?: "live" | "parked";
  // Class appearance (Garage): marker === 'class' means peers should render the
  // vehicleClass top-down sprite in this driver's saved paint instead of the
  // GRC avatar. Paint is LOCAL-only, so presence is its only carrier.
  marker?: string;
  cls?: string;
  clsPri?: string;
  clsSec?: string;
  // Arrow appearance paint (marker === 'arrow'): peers render a 2-tone arrow.
  arrPri?: string;
  arrSec?: string;
};

export type ConvoyMe = {
  user_id: string;
  handle?: string;
  carType?: string;
  carBody?: string;
  carColor?: string;
  // Optional pre-resolved slug — if omitted we compute it from carColor below.
  activeColor?: string;
  // Personal best top cruise speed (km/h). Sent every time we re-track the channel.
  topSpeed?: number;
  // Presence status broadcast to peers — "live" (default) or "parked".
  status?: "live" | "parked";
  // Class appearance broadcast (see PresencePayload).
  marker?: string;
  cls?: string;
  clsPri?: string;
  clsSec?: string;
  // Arrow appearance paint (marker === 'arrow'): peers render a 2-tone arrow.
  arrPri?: string;
  arrSec?: string;
};

type Status = "idle" | "joining" | "subscribed" | "error" | "disabled";

/**
 * Subscribe to a Convoy presence channel and continuously broadcast our coords.
 * Returns the live list of *other* peers (we exclude ourselves).
 *
 * Usage:
 *   const { peers, status } = useConvoyPresence("convoy:global", { user_id, handle, carType }, coords);
 */
export function useConvoyPresence(
  channelName: string | null,
  me: ConvoyMe | null,
  coords: { lat: number; lng: number; heading?: number } | null
) {
  const [peers, setPeers] = useState<ConvoyPresencePeer[]>([]);
  const [status, setStatus] = useState<Status>("idle");
  const handleRef = useRef<PresenceHandle | null>(null);
  // Fresh me/coords so the hub's getPayload closure always reads the latest.
  const meRef = useRef(me); meRef.current = me;
  const coordsRef = useRef(coords); coordsRef.current = coords;
  const lastTrackRef = useRef<number>(0);
  // Last status we actually broadcast — lets a live<->parked flip (CarPlay connect/
  // disconnect) bypass the position throttle so the parked pin reaches peers even when
  // the pinned coords don't change.
  const lastStatusRef = useRef<string | undefined>(undefined);

  // Build OUR presence payload from the freshest me/coords (the hub calls this
  // on every track(), and once automatically when the channel goes SUBSCRIBED).
  const buildPayload = (): Record<string, any> | null => {
    const m = meRef.current, c = coordsRef.current;
    if (!m?.user_id || !c) return null;
    return {
      user_id: m.user_id,
      handle: m.handle,
      carType: m.carType,
      carBody: m.carBody,
      carColor: m.carColor,
      // Canonical GRC slug — auto-derived if caller didn't pre-resolve.
      activeColor: m.activeColor || toGRCSlug(m.carColor) || undefined,
      topSpeed: m.topSpeed,
      status: m.status ?? "live",
      marker: m.marker,
      cls: m.cls,
      clsPri: m.clsPri,
      clsSec: m.clsSec,
      arrPri: m.arrPri,
      arrSec: m.arrSec,
      lat: c.lat,
      lng: c.lng,
      heading: c.heading,
    };
  };

  // Join / leave the SHARED presence hub (single channel per topic — the phone
  // map + CarPlay service can never double-join, so the "cannot add presence
  // callbacks" crash is structurally impossible now, not merely swallowed).
  useEffect(() => {
    // No channel = privacy-off / no active community — opt out and clear peers so
    // the previous community's pins disappear the moment Avatar Live is toggled off.
    if (!channelName || !SUPABASE_ENABLED || !supabase || !me?.user_id) {
      setPeers([]);
      setStatus(SUPABASE_ENABLED ? "idle" : "disabled");
      return;
    }
    setStatus("joining");
    const handle = joinPresence({
      topic: channelName,
      selfId: me.user_id,
      priority: 2, // phone map owns the broadcast (richest marker/paint payload)
      getPayload: buildPayload,
      onPeers: (raw) => {
        const list: ConvoyPresencePeer[] = [];
        for (const p of raw) {
          if (typeof p.lat !== "number" || typeof p.lng !== "number") continue;
          list.push({
            user_id: p.user_id,
            handle: p.handle,
            lat: p.lat,
            lng: p.lng,
            carType: p.carType,
            carBody: p.carBody,
            carColor: p.carColor,
            activeColor: typeof p.activeColor === "string" ? p.activeColor : undefined,
            heading: p.heading,
            online_at: p.online_at,
            topSpeed: typeof p.topSpeed === "number" ? p.topSpeed : undefined,
            status: p.status === "parked" ? "parked" : "live",
            marker: typeof p.marker === "string" ? p.marker : undefined,
            cls: typeof p.cls === "string" ? p.cls : undefined,
            clsPri: typeof p.clsPri === "string" ? p.clsPri : undefined,
            clsSec: typeof p.clsSec === "string" ? p.clsSec : undefined,
            arrPri: typeof p.arrPri === "string" ? p.arrPri : undefined,
            arrSec: typeof p.arrSec === "string" ? p.arrSec : undefined,
          });
        }
        setPeers(list);
      },
    });
    handleRef.current = handle;
    setStatus("subscribed");
    handle.track(); // initial broadcast (hub replays it once the channel SUBSCRIBEs)
    return () => {
      handle.leave();
      handleRef.current = null;
      setPeers([]);
      setStatus("idle");
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [channelName, me?.user_id]);

  // Re-broadcast our position as it changes (throttled to ~1 update / 1.5s). A STATUS
  // change (live <-> parked, e.g. CarPlay connect/disconnect) ALWAYS re-tracks and
  // bypasses the throttle — otherwise a parked flip whose pinned coords didn't change
  // would never reach peers (the position deps wouldn't fire, the throttle would eat it).
  useEffect(() => {
    if (!handleRef.current || !coords || !me) return;
    const now = Date.now();
    const statusChanged = (me.status ?? "live") !== lastStatusRef.current;
    if (!statusChanged && now - lastTrackRef.current < 1500) return;
    lastTrackRef.current = now;
    lastStatusRef.current = me.status ?? "live";
    handleRef.current.track();
  }, [coords?.lat, coords?.lng, coords?.heading, me?.user_id, me?.handle, me?.carType, me?.carBody, me?.carColor, me?.activeColor, me?.topSpeed, me?.status, me?.marker, me?.cls, me?.clsPri, me?.clsSec, me?.arrPri, me?.arrSec]);

  return { peers, status };
}
