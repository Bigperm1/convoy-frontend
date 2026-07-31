// visitMonitor.ts — OS-level arrival detection (build 65+, iOS).
//
// CLVisit is iOS's own ultra-low-power "Visited Places" engine (the same
// machinery behind Apple Maps' visit history): the OS detects that the phone
// has ARRIVED somewhere and wakes us briefly — even when Hairpin is
// backgrounded or was suspended, with Always location authorization (which
// the app already requests). We forward arrivals to POST /location, which
// refreshes the user doc's lat/lng/last_seen — and that is exactly what the
// backend's cruise ARRIVAL TRIGGER sweeps. Net effect: pull into the meet
// with your phone in a pocket, and the crew still gets "the crew is arriving"
// within a minute. (Before this, arrival detection relied on the app being
// open enough to post its foreground GPS.)
//
// PRIVACY (rewritten 2026-07-31 — the old note here was WRONG).
// It used to claim visits "honor the SAME gate as presence". They did not: presence
// has three gates (ghost, head-unit connected, driving-recently) and this had exactly
// one (ghost). A CLVisit arrival is BY DEFINITION the phone stopping somewhere and
// dwelling — walking into your home, office or gym is the canonical trigger — so for
// every partial/full user this published precisely the location the parked contract
// exists to hide, straight to /users/nearby and the WebSocket fan-out, with the app
// never opened.
// Now it asks src/locationPrivacy for the decision like every other transport. A visit
// arrival resolves to the CAR's spot, or to nothing at all. The async form is required
// here: this can run in a cold context where the settings cache is still DEFAULT_SETTINGS
// (which is `partial`, not ghost), so without awaiting the load a ghost user would share.
//
// No-op everywhere the native module is absent: Android, web, and any build
// older than 65 (requireOptionalNativeModule returns null — see
// modules/hairpin-system).

import { Platform } from 'react-native';
import { HairpinSystem, type HairpinVisit } from '../modules/hairpin-system';
import { api } from './api';
import { shareablePositionAsync } from './locationPrivacy';

let _started = false;
let _lastPostTs = 0;

export function initVisitMonitor(): void {
  if (_started || Platform.OS !== 'ios' || !HairpinSystem) return;
  _started = true;
  try {
    HairpinSystem.addListener('onVisit', (v: HairpinVisit) => { void onVisit(v); });
    HairpinSystem.startVisitMonitoring();
  } catch {
    _started = false;
  }
}

async function onVisit(v: HairpinVisit): Promise<void> {
  try {
    if (typeof v?.lat !== 'number' || typeof v?.lng !== 'number') return;
    // Only ARRIVALS matter (departureTs unset) — a departure visit describes a
    // place we already left, and posting it would teleport our pin backwards.
    if (v.departureTs && v.departureTs > 0) return;
    // CLVisit can occasionally re-deliver; one post per 60s is plenty.
    const now = Date.now();
    if (now - _lastPostTs < 60_000) return;
    // The visit's OWN coordinates are deliberately NOT passed as `live`. An arrival is a
    // dwell, so the honest answer is always the parked one: the car's spot, or nothing.
    // Passing v.lat/v.lng here would re-open the exact hole this closes.
    const share = await shareablePositionAsync(null);
    if (!share.share) return;
    _lastPostTs = now;
    await api.post('/location', { lat: share.lat, lng: share.lng, speed: 0, heading: 0 });
  } catch {}
}
