// trips.ts — recorded drives: distance, duration, and the route you actually took.
//
// Jeff, 2026-07-28: "add things into the user profiles like recorded KM when routed /
// previous trips / routes… a visual playback of the route taken when clicking on the
// exact route, and the option to take it again. then add a leaderboard in the club for
// the members who record the most KM/routes."
//
// This is the foundation the other two features sit on: playback needs stored geometry,
// and the leaderboard needs totals that can be compared across members.
//
// ── WHERE THE DATA LIVES, AND WHY IT IS SPLIT ────────────────────────────────
// Hairpin does not use Supabase Auth — auth is the custom backend, and the client holds
// only the RLS-protected anon key. There is no auth.uid(), so Supabase RLS CANNOT scope a
// SELECT to "your own rows": anything readable in that database is readable by any client
// holding the anon key.
//
// The published privacy policy says a member's position is shared only with the crews
// they join and never publicly. A server table of per-trip routes with start and end
// points is precisely a movement history, so it does not go there.
//
//   ON DEVICE (here, AsyncStorage) — the full trip incl. polyline. Powers the history
//     list, the playback, and "take it again". Never leaves the phone.
//   ON THE SERVER (public.trips)   — distance, duration, when, club. NO coordinates.
//     Only what a leaderboard has to compare across members.
//
// If per-trip routes ever need to follow a member across their own devices, that belongs
// on the AUTHENTICATED custom backend, not on the anon-key database.
import AsyncStorage from "@react-native-async-storage/async-storage";

const KEY = "hairpin.trips.v1";
// Keep the on-device history bounded — a polyline is a few kB and a heavy user could
// otherwise grow this without limit. 200 drives is far more than the history UI shows.
const MAX_TRIPS = 200;

export type Trip = {
  id: string;
  /** epoch ms */
  startedAt: number;
  endedAt: number;
  /** Metres driven. See recordTrip() for what this actually measures. */
  distanceM: number;
  durationS: number;
  destLabel: string;
  /** Encoded polyline of the route taken — this is what playback animates. */
  polyline: string;
  /** Named stops, in travel order, if the driver pinned any. */
  stops?: { label: string; lat: number; lng: number }[];
  /** Destination, so "take it again" can re-run the trip. */
  destLat?: number;
  destLng?: number;
  /** Fastest km/h seen on THIS drive — the PB the club board ranks on. */
  topSpeedKmh?: number;
};

function newId(startedAt: number, endedAt: number): string {
  // Date.now-based ids collide only if two trips end in the same millisecond, which one
  // device cannot do. Avoids pulling in a uuid dependency for this.
  return `t${startedAt.toString(36)}_${endedAt.toString(36)}`;
}

export async function getTrips(): Promise<Trip[]> {
  try {
    const raw = await AsyncStorage.getItem(KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

async function saveTrips(list: Trip[]): Promise<void> {
  try {
    await AsyncStorage.setItem(KEY, JSON.stringify(list.slice(0, MAX_TRIPS)));
  } catch {
    // storage full / unavailable — a lost history entry must never break arrival
  }
}

/**
 * Record a completed drive. Called on ARRIVAL, from the map's onArrive.
 *
 * `distanceM` is the ROUTE's distance, not an integral of GPS fixes. That is a deliberate
 * choice: integrating raw GPS accumulates jitter (a phone parked for an hour can invent
 * hundreds of metres), so route distance is both steadier and the number the driver was
 * shown for the whole trip. It under-reports a detour and over-reports a short-cut; if
 * that ever matters, the honest upgrade is to integrate the SNAPPED positions, not the raw ones.
 *
 * Fails soft everywhere: arriving somewhere must never throw because history didn't save.
 */
export async function recordTrip(input: {
  startedAt: number;
  distanceM: number;
  durationS: number;
  destLabel: string;
  polyline: string;
  stops?: { label: string; lat: number; lng: number }[];
  destLat?: number;
  destLng?: number;
  topSpeedKmh?: number;
  userId?: string;
  handle?: string;
  communityId?: string;
}): Promise<Trip | null> {
  try {
    const endedAt = Date.now();
    const startedAt = Number.isFinite(input.startedAt) && input.startedAt > 0 ? input.startedAt : endedAt;
    const distanceM = Number.isFinite(input.distanceM) && input.distanceM > 0 ? input.distanceM : 0;
    // Ignore trivial drives — a route started and cancelled in the driveway is noise in
    // both the history list and the leaderboard.
    if (distanceM < 500) return null;

    const trip: Trip = {
      id: newId(startedAt, endedAt),
      startedAt,
      endedAt,
      distanceM,
      durationS: Number.isFinite(input.durationS) && input.durationS > 0
        ? input.durationS
        : Math.max(0, (endedAt - startedAt) / 1000),
      destLabel: input.destLabel || "Drive",
      polyline: input.polyline || "",
      stops: input.stops?.length ? input.stops : undefined,
      destLat: input.destLat,
      destLng: input.destLng,
      topSpeedKmh: Number.isFinite(input.topSpeedKmh) && (input.topSpeedKmh as number) > 0
        ? Math.round((input.topSpeedKmh as number) * 10) / 10
        : 0,
    };

    const list = await getTrips();
    await saveTrips([trip, ...list]);

    // Server half — AGGREGATE ONLY. No coordinates, no polyline. Best-effort: a failed
    // upload costs a leaderboard entry, never the local history.
    void pushTripAggregate(trip, input.userId, input.handle, input.communityId);
    return trip;
  } catch {
    return null;
  }
}

async function pushTripAggregate(
  trip: Trip,
  userId?: string,
  handle?: string,
  communityId?: string,
): Promise<void> {
  try {
    if (!userId) return;                       // signed-out / unknown — nothing to attribute
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { supabase } = require("./supabase");
    if (!supabase) return;
    await supabase.from("trips").insert([{
      user_id: userId,
      handle: handle || null,
      community_id: communityId || null,
      distance_m: trip.distanceM,
      duration_s: trip.durationS,
      top_speed_kmh: trip.topSpeedKmh || 0,
      started_at: new Date(trip.startedAt).toISOString(),
      ended_at: new Date(trip.endedAt).toISOString(),
    }]);
  } catch {
    // offline / RLS / shape — never surface
  }
}

/** Lifetime totals for the profile header. */
export async function tripTotals(): Promise<{ km: number; drives: number; hours: number }> {
  const list = await getTrips();
  let m = 0, s = 0;
  for (const t of list) { m += t.distanceM || 0; s += t.durationS || 0; }
  return { km: m / 1000, drives: list.length, hours: s / 3600 };
}

export async function removeTrip(id: string): Promise<Trip[]> {
  const list = (await getTrips()).filter((t) => t.id !== id);
  await saveTrips(list);
  return list;
}

/**
 * Club leaderboard — total distance and drive count per member.
 *
 * Aggregated client-side from the aggregate rows. Fine at club scale (tens of members,
 * a few thousand rows); if a club ever outgrows that, this becomes a Postgres view or an
 * RPC rather than a bigger download.
 */
export async function fetchClubLeaderboard(
  communityId: string,
  sinceDays?: number,
): Promise<{ userId: string; handle: string; km: number; drives: number; pb: number }[]> {
  try {
    if (!communityId) return [];
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { supabase } = require("./supabase");
    if (!supabase) return [];
    let q = supabase
      .from("trips")
      .select("user_id,handle,distance_m,top_speed_kmh")
      .eq("community_id", communityId);
    if (sinceDays && sinceDays > 0) {
      q = q.gte("ended_at", new Date(Date.now() - sinceDays * 86400000).toISOString());
    }
    const { data, error } = await q;
    if (error || !Array.isArray(data)) return [];

    const by = new Map<string, { userId: string; handle: string; km: number; drives: number; pb: number }>();
    for (const row of data as any[]) {
      const uid = String(row?.user_id || "");
      if (!uid) continue;
      const cur = by.get(uid) || { userId: uid, handle: row?.handle || "Driver", km: 0, drives: 0, pb: 0 };
      cur.km += (Number(row?.distance_m) || 0) / 1000;
      cur.drives += 1;
      // PB is a MAX across the member's trips, not a sum.
      cur.pb = Math.max(cur.pb, Number(row?.top_speed_kmh) || 0);
      // Keep the freshest handle we see — members rename themselves.
      if (row?.handle) cur.handle = row.handle;
      by.set(uid, cur);
    }
    return [...by.values()].sort((a, b) => b.km - a.km);
  } catch {
    return [];
  }
}

/** "1,240 km" / "980 m" */
export function fmtKm(km: number): string {
  if (!Number.isFinite(km) || km <= 0) return "0 km";
  if (km < 1) return `${Math.round(km * 1000)} m`;
  return `${Math.round(km).toLocaleString()} km`;
}

/** "2h 14m" / "46m" */
export function fmtDur(sec: number): string {
  const s = Math.max(0, Math.floor(sec));
  const h = Math.floor(s / 3600), m = Math.round((s % 3600) / 60);
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
}

// ── "Take it again" hand-off ─────────────────────────────────────────────────
// The Drives screen and the map are different screens; this is the one value that
// crosses between them. A module-level slot rather than router params because the trip
// carries stops (an array of objects) and serialising that through a URL just to parse
// it back is noise. The map CONSUMES it (read-once) on focus, so re-opening the map
// later can't silently restart an old drive.
let _takeAgain: Trip | null = null;
export function setTakeAgain(t: Trip | null): void { _takeAgain = t; }
export function consumeTakeAgain(): Trip | null {
  const t = _takeAgain;
  _takeAgain = null;
  return t;
}

// ── Peer PB cache ────────────────────────────────────────────────────────────
// The club leaderboard needs each member's personal-best speed, but the club roster
// endpoint (/communities/:id -> members_users) does not carry top_speed_record. The
// number DOES reach the app — it rides the peer pipeline (/users/nearby + presence),
// which is where the peer card gets the "PB 174 km/h" it shows when you tap a car.
//
// So the map records what it sees, and the Hub reads it back. Client-side only: no
// backend change, and no extra request just to render a board. Speeds carry no location.
const PB_KEY = "hairpin.peerPb.v1";

export async function cachePeerPbs(pairs: { id: string; pb?: number }[]): Promise<void> {
  try {
    const good = pairs.filter((p) => p?.id && Number.isFinite(p.pb) && (p.pb as number) > 0);
    if (!good.length) return;
    const raw = await AsyncStorage.getItem(PB_KEY);
    const map: Record<string, number> = raw ? JSON.parse(raw) : {};
    let changed = false;
    for (const p of good) {
      const v = Math.round((p.pb as number) * 10) / 10;
      // Only ever climbs — a PB is a record, so a stale lower reading must not erase it.
      if (!(map[p.id] >= v)) { map[p.id] = v; changed = true; }
    }
    if (changed) await AsyncStorage.setItem(PB_KEY, JSON.stringify(map));
  } catch {}
}

export async function getPeerPbs(): Promise<Record<string, number>> {
  try {
    const raw = await AsyncStorage.getItem(PB_KEY);
    return raw ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
}
