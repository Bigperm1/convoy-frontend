// Community-shared routes.
//
// - WRITES are gated to the FastAPI backend (admin-only check, then service-role insert).
// - READS happen directly against Supabase (anon) so we get Realtime for free.
//
// A "route" here is a saved destination an admin shares with their community
// (cruise mode). Members tap it on the map and the destination loads into
// their navigation. Optional precomputed `polyline` lets us draw the line
// instantly without a second Directions API call.

import { useEffect, useState } from "react";
import { supabase, SUPABASE_ENABLED } from "./supabase";
import { api } from "./api";

export type CommunityRoute = {
  id: string;
  community_id: string;
  created_by: string | null;
  name: string;
  description: string | null;
  dest_label: string | null;
  dest_lat: number;
  dest_lng: number;
  origin_label: string | null;
  origin_lat: number | null;
  origin_lng: number | null;
  polyline: string | null;
  scheduled_at: string | null;
  is_active: boolean;
  created_at: string;
  updated_at: string;
};

export type CreateRouteInput = {
  community_id: string;
  name: string;
  description?: string;
  dest_label?: string;
  dest_lat: number;
  dest_lng: number;
  origin_label?: string;
  origin_lat?: number;
  origin_lng?: number;
  polyline?: string;
  scheduled_at?: string;
};

/**
 * Subscribe to a community's active routes with live updates.
 * Returns the current snapshot + a `loading` flag.
 *
 * - On mount: pulls active rows ordered by created_at desc.
 * - INSERT: prepended to the list.
 * - UPDATE: replaced in place. If is_active flips to false, removed.
 * - DELETE: removed from the list.
 */
export function useCommunityRoutes(communityId: string | null) {
  const [routes, setRoutes] = useState<CommunityRoute[]>([]);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!communityId || !SUPABASE_ENABLED || !supabase) {
      setRoutes([]);
      return;
    }
    let cancelled = false;
    setLoading(true);

    (async () => {
      const { data, error } = await supabase
        .from("routes")
        .select("*")
        .eq("community_id", communityId)
        .eq("is_active", true)
        .order("created_at", { ascending: false })
        .limit(100);
      if (!cancelled) {
        if (!error && data) setRoutes(data as CommunityRoute[]);
        setLoading(false);
      }
    })();

    const channel = supabase
      .channel(`routes:community:${communityId}`)
      .on(
        "postgres_changes",
        { event: "INSERT", schema: "public", table: "routes", filter: `community_id=eq.${communityId}` },
        (payload: any) => {
          const r = payload.new as CommunityRoute;
          if (!r.is_active) return;
          setRoutes((cur) => [r, ...cur.filter((x) => x.id !== r.id)]);
        }
      )
      .on(
        "postgres_changes",
        { event: "UPDATE", schema: "public", table: "routes", filter: `community_id=eq.${communityId}` },
        (payload: any) => {
          const r = payload.new as CommunityRoute;
          setRoutes((cur) => {
            const without = cur.filter((x) => x.id !== r.id);
            return r.is_active ? [r, ...without] : without;
          });
        }
      )
      .on(
        "postgres_changes",
        { event: "DELETE", schema: "public", table: "routes", filter: `community_id=eq.${communityId}` },
        (payload: any) => {
          const r = payload.old as CommunityRoute;
          setRoutes((cur) => cur.filter((x) => x.id !== r.id));
        }
      )
      .subscribe();

    return () => {
      cancelled = true;
      try { if (supabase) supabase.removeChannel(channel); } catch {}
    };
  }, [communityId]);

  return { routes, loading };
}

/** Admin only — server enforces this via the JWT. */
export async function createCommunityRoute(input: CreateRouteInput): Promise<CommunityRoute> {
  const { data } = await api.post(`/communities/${input.community_id}/routes`, input);
  return data as CommunityRoute;
}

/** Admin only — soft-deletes (sets is_active=false). Members get a Realtime UPDATE. */
export async function deleteCommunityRoute(communityId: string, routeId: string): Promise<void> {
  await api.delete(`/communities/${communityId}/routes/${routeId}`);
}
