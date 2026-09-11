// crewWidgetFeed — the IO half of the iOS 27 FULL-PAGE widget's feed (design approved
// by Jeff 2026-09-11: concept A, "crew page", with the Departure-IQ leave-by swap).
//
// Every decision lives in src/crewWidgetRule.ts and is gated by
// tools/sim-qc/crew_widget_test.mts. This file only does the things a test cannot:
// read the clock and AppState, write the App Group, and render the Mapbox snapshot.
//
// The small/medium widget is fed by widgetFeed.ts and is NOT touched here — its key
// ("nextEvent") keeps its exact build-65 shape so build 78 installs keep working.
// This adds two OPTIONAL keys plus one image file:
//
//   "crew"    { at, live, members:[{h,s,km,tier}], map }
//   "leaveBy" { at, dest, driveMin }
//   crew-map.png in the App Group container
//
// The widget reads all three defensively and degrades to the plain card when they are
// missing, so the app half and the widget half can ship in either order.
//
// ⚠ COST DISCIPLINE. This is driven from the live map screen, so: the JSON write is
// throttled and skipped when nothing visible changed, and the map SNAPSHOT (which spins
// up an offscreen Mapbox renderer) is throttled harder, never taken while the app is
// backgrounded, and skipped entirely while turn-by-turn nav is running — the main thread
// belongs to the drive then (see the watchdog note in CLAUDE.md).
import { AppState, Platform } from 'react-native';
import { HairpinSystem } from '../modules/hairpin-system';
import {
  crewPayload, shouldPublishCrew, shouldSnapshotMap, leaveByIsShowable,
  type CrewPeer,
} from './crewWidgetRule';

export type { CrewPeer } from './crewWidgetRule';

const SUITE = 'group.com.sw0rdfisch.convoy';
const KEY_CREW = 'crew';
const KEY_LEAVE = 'leaveBy';
const MAP_FILE = 'crew-map.png';
const MAP_W = 634;   // 317 pt panel @2x — the widget draws it aspect-fill
const MAP_H = 464;

let _crewAt = 0;
let _crewSig = '';
let _mapAt = 0;
let _mapBusy = false;

function ok(): boolean {
  return Platform.OS === 'ios' && !!HairpinSystem;
}

/**
 * Publish the crew half. Safe to call on every presence tick — it throttles and
 * de-dupes internally (see crewWidgetRule.shouldPublishCrew).
 */
export function updateCrewWidget(
  peers: CrewPeer[] | null | undefined,
  me?: { lat: number; lng: number } | null,
): void {
  if (!ok()) return;
  try {
    const now = Date.now();
    const { live, members, sig } = crewPayload(peers, me);
    if (!shouldPublishCrew(now, _crewAt, _crewSig, sig)) {
      // Unchanged: still move the clock so we are not re-comparing on every delta.
      if (now - _crewAt >= 0 && sig === _crewSig) _crewAt = now;
      return;
    }
    _crewSig = sig;
    _crewAt = now;
    HairpinSystem!.setSharedDefaults(
      SUITE, KEY_CREW,
      JSON.stringify({ at: now, live, members, map: MAP_FILE }),
    );
  } catch {}
}

/**
 * Publish the Departure-IQ "leave by" headline, which the full-page card swaps to when
 * present. Pass null to clear it and fall back to the next-cruise countdown.
 */
export function updateLeaveByWidget(
  leave: { at: number; dest?: string; driveMin?: number } | null,
): void {
  if (!ok()) return;
  try {
    if (!leave || !leaveByIsShowable(Date.now(), leave.at)) {
      HairpinSystem!.removeSharedDefaults?.(SUITE, KEY_LEAVE);
      return;
    }
    HairpinSystem!.setSharedDefaults(
      SUITE, KEY_LEAVE,
      JSON.stringify({
        at: Math.round(leave.at),
        dest: (leave.dest || '').slice(0, 40),
        driveMin: Math.max(0, Math.round(leave.driveMin || 0)),
      }),
    );
  } catch {}
}

/**
 * Render the crew snapshot map into the App Group container. A widget cannot draw a
 * live Mapbox view and must not network, so the app renders a static PNG and hands it
 * over through the native `writeSharedFile`.
 */
export async function refreshCrewMapSnapshot(
  center: { lat: number; lng: number } | null | undefined,
  navActive: boolean,
): Promise<void> {
  if (!ok()) return;
  if (typeof HairpinSystem!.writeSharedFile !== 'function') return;   // older binary
  if (!shouldSnapshotMap({
    now: Date.now(), lastAt: _mapAt, busy: _mapBusy, navActive,
    appActive: AppState.currentState === 'active', hasCenter: !!center,
  })) return;
  _mapBusy = true;
  try {
    // Imported lazily: @rnmapbox/maps runs native side effects at import and must stay
    // out of the web bundle (same rule as the CarPlay surface).
    const Mapbox = (await import('@rnmapbox/maps')).default as any;
    const uri: string | undefined = await Mapbox?.snapshotManager?.takeSnap({
      centerCoordinate: [center!.lng, center!.lat],
      width: MAP_W,
      height: MAP_H,
      zoomLevel: 11.5,
      pitch: 0,
      heading: 0,
      styleURL: Mapbox?.StyleURL?.Dark,
      writeToDisk: true,
      withLogo: false,
    });
    if (uri) {
      HairpinSystem!.writeSharedFile!(SUITE, MAP_FILE, uri);
      _mapAt = Date.now();
    }
  } catch {
  } finally {
    _mapBusy = false;
  }
}

/** Test seam — lets a gate drive the throttles deterministically. */
export function __resetCrewWidgetFeedForTest(): void {
  _crewAt = 0; _crewSig = ''; _mapAt = 0; _mapBusy = false;
}
