// crewWidgetRule — the PURE half of the iOS 27 full-page widget's crew feed.
//
// Same split as selfLiftRule.ts / selfLift.ts: everything decidable without React
// Native, the native module or a clock lives here so tools/sim-qc can gate it, and
// src/crewWidgetFeed.ts does only the IO (throttle bookkeeping, UserDefaults write,
// Mapbox snapshot). Import nothing from 'react-native' in this file.

export type CrewPeer = {
  handle?: string | null;
  status?: 'live' | 'parked' | null;
  /** true while this peer is actively navigating — drawn amber, "driving". */
  navigating?: boolean | null;
  lat?: number | null;
  lng?: number | null;
  tier?: 'gold' | 'silver' | null;
};

export type CrewMemberPayload = {
  h: string;
  s: 'live' | 'driving' | 'parked';
  km?: number;
  tier?: 'gold' | 'silver';
};

export type CrewPayload = {
  live: number;
  members: CrewMemberPayload[];
  /** Cheap change-detector: equal signatures mean the widget would render identically. */
  sig: string;
};

/** The widget draws exactly five ring slots. */
export const CREW_MAX = 5;
/** JSON republish floor. Twice a minute is plenty for a widget timeline. */
export const CREW_MIN_MS = 30_000;
/** Snapshot floor — the render is expensive and the widget refreshes hourly anyway. */
export const MAP_MIN_MS = 5 * 60_000;
/** Crew older than this is not shown live; a dead convoy must not look alive. */
export const CREW_STALE_MS = 30 * 60_000;

export function haversineKm(aLat: number, aLng: number, bLat: number, bLng: number): number {
  const R = 6371;
  const dLat = ((bLat - aLat) * Math.PI) / 180;
  const dLng = ((bLng - aLng) * Math.PI) / 180;
  const s =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((aLat * Math.PI) / 180) * Math.cos((bLat * Math.PI) / 180) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(s)));
}

/** driving first, then live, then parked — the order the ring row reads left to right. */
function rank(p: CrewPeer): number {
  return p.navigating ? 0 : p.status === 'parked' ? 2 : 1;
}

/**
 * Shape the crew ring row. Pure: same inputs, same output, no clock and no IO.
 * Peers without a handle are dropped (the widget has no other way to name them).
 */
export function crewPayload(
  peers: CrewPeer[] | null | undefined,
  me?: { lat: number; lng: number } | null,
): CrewPayload {
  const list = (peers ?? []).filter((p) => p && String(p.handle ?? '').trim().length > 0);
  const withKm = list.map((p) => ({
    p,
    km:
      me && typeof p.lat === 'number' && typeof p.lng === 'number' && Number.isFinite(p.lat) && Number.isFinite(p.lng)
        ? haversineKm(me.lat, me.lng, p.lat, p.lng)
        : null,
  }));
  // Stable: bucket, then nearest, then handle so equal inputs never reorder between ticks.
  withKm.sort(
    (a, b) =>
      rank(a.p) - rank(b.p) ||
      (a.km ?? Number.POSITIVE_INFINITY) - (b.km ?? Number.POSITIVE_INFINITY) ||
      String(a.p.handle).localeCompare(String(b.p.handle)),
  );

  const members: CrewMemberPayload[] = withKm.slice(0, CREW_MAX).map(({ p, km }) => ({
    h: String(p.handle).trim().slice(0, 12),
    s: p.navigating ? 'driving' : p.status === 'parked' ? 'parked' : 'live',
    ...(km != null && Number.isFinite(km) ? { km: Math.round(km * 10) / 10 } : {}),
    ...(p.tier === 'gold' || p.tier === 'silver' ? { tier: p.tier } : {}),
  }));

  return {
    // "live" is the pill count: anyone not parked is out.
    live: members.filter((m) => m.s !== 'parked').length,
    members,
    sig: members.map((m) => `${m.h}:${m.s}:${m.km ?? ''}:${m.tier ?? ''}`).join('|'),
  };
}

/**
 * Should we publish? Only when the floor has elapsed AND the render would differ.
 * An unchanged crew still refreshes the clock so we do not re-compare every tick.
 */
export function shouldPublishCrew(
  now: number,
  lastAt: number,
  lastSig: string,
  sig: string,
  minMs: number = CREW_MIN_MS,
): boolean {
  if (now - lastAt < minMs) return false;
  return sig !== lastSig;
}

/** Snapshot gate: foregrounded, not navigating, floor elapsed, not already running. */
export function shouldSnapshotMap(args: {
  now: number;
  lastAt: number;
  busy: boolean;
  navActive: boolean;
  appActive: boolean;
  hasCenter: boolean;
  minMs?: number;
}): boolean {
  const { now, lastAt, busy, navActive, appActive, hasCenter, minMs = MAP_MIN_MS } = args;
  if (!hasCenter || busy || navActive || !appActive) return false;
  return now - lastAt >= minMs;
}

/** The widget treats crew older than CREW_STALE_MS as absent. */
export function crewIsFresh(now: number, writtenAt: number): boolean {
  return writtenAt > 0 && now - writtenAt < CREW_STALE_MS;
}

/** A leave-by time is shown until 15 min after it passes, then it is cleared. */
export const LEAVE_GRACE_MS = 15 * 60_000;
export function leaveByIsShowable(now: number, at: number | null | undefined): boolean {
  return typeof at === 'number' && Number.isFinite(at) && at > 0 && at > now - LEAVE_GRACE_MS;
}
