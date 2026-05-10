// Supabase Realtime Presence — live peer tracking for the Convoy.
//
// Each user joins a channel and broadcasts their position + metadata. Presence
// auto-handles join/leave so the map updates instantly when someone connects
// or drops off (no polling, no manual disconnect plumbing).
//
// Channel naming convention:
//   - "convoy:global"       — everyone, default
//   - "convoy:community:<id>" — scoped to a specific community
//
// Each peer payload looks like:
//   { user_id, handle, lat, lng, carType, heading?, online_at }

import { useEffect, useRef, useState } from "react";
import type { RealtimeChannel } from "@supabase/supabase-js";
import { supabase, SUPABASE_ENABLED } from "./supabase";
import { toGRCSlug } from "./vehicleAssets";

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
  channelName: string,
  me: ConvoyMe | null,
  coords: { lat: number; lng: number; heading?: number } | null
) {
  const [peers, setPeers] = useState<ConvoyPresencePeer[]>([]);
  const [status, setStatus] = useState<Status>("idle");
  const channelRef = useRef<RealtimeChannel | null>(null);
  const lastTrackRef = useRef<number>(0);

  // Join / leave channel when channelName or me.user_id changes
  useEffect(() => {
    if (!SUPABASE_ENABLED || !supabase || !me?.user_id) {
      setStatus(SUPABASE_ENABLED ? "idle" : "disabled");
      return;
    }
    setStatus("joining");

    const channel = supabase.channel(channelName, {
      config: { presence: { key: me.user_id } },
    });
    channelRef.current = channel;

    channel
      .on("presence", { event: "sync" }, () => {
        const state = channel.presenceState();
        // Flatten { user_id: [payload, ...] } → array, drop ourselves
        const list: ConvoyPresencePeer[] = [];
        Object.entries(state).forEach(([uid, presences]) => {
          if (uid === me.user_id) return;
          // The most recent payload wins if there are multiple presences for the same key
          const p: any = (presences as any[])[0];
          if (!p) return;
          if (typeof p.lat !== "number" || typeof p.lng !== "number") return;
          list.push({
            user_id: uid,
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
          });
        });
        setPeers(list);
      })
      .subscribe(async (s) => {
        if (s === "SUBSCRIBED") {
          setStatus("subscribed");
          // Initial broadcast as soon as we're subscribed
          if (coords) {
            await channel.track({
              user_id: me.user_id,
              handle: me.handle,
              carType: me.carType,
              carBody: me.carBody,
              carColor: me.carColor,
              // Canonical GRC slug — auto-derived if caller didn't pre-resolve.
              activeColor: me.activeColor || toGRCSlug(me.carColor) || undefined,
              topSpeed: me.topSpeed,
              lat: coords.lat,
              lng: coords.lng,
              heading: coords.heading,
              online_at: new Date().toISOString(),
            });
            lastTrackRef.current = Date.now();
          }
        } else if (s === "CHANNEL_ERROR" || s === "TIMED_OUT" || s === "CLOSED") {
          setStatus("error");
        }
      });

    return () => {
      try { channel.untrack().catch(() => {}); } catch {}
      try { supabase.removeChannel(channel); } catch {}
      channelRef.current = null;
      setPeers([]);
      setStatus("idle");
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [channelName, me?.user_id]);

  // Re-broadcast our position as it changes (throttled to ~1 update / 1.5s)
  useEffect(() => {
    const ch = channelRef.current;
    if (!ch || status !== "subscribed" || !coords || !me) return;
    const now = Date.now();
    if (now - lastTrackRef.current < 1500) return;
    lastTrackRef.current = now;
    ch.track({
      user_id: me.user_id,
      handle: me.handle,
      carType: me.carType,
      carBody: me.carBody,
      carColor: me.carColor,
      activeColor: me.activeColor || toGRCSlug(me.carColor) || undefined,
      topSpeed: me.topSpeed,
      lat: coords.lat,
      lng: coords.lng,
      heading: coords.heading,
      online_at: new Date().toISOString(),
    }).catch(() => {});
  }, [coords?.lat, coords?.lng, coords?.heading, status, me?.user_id, me?.handle, me?.carType, me?.carBody, me?.carColor, me?.activeColor, me?.topSpeed]);

  return { peers, status };
}
