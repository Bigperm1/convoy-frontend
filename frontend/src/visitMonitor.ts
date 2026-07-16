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
// PRIVACY: POST /location feeds the same last-known-position peers can see
// (/users/nearby), so visits honor the SAME gate as presence — ghost mode
// forwards nothing. No visit history is stored anywhere by us; each arrival
// is a single position update, identical in shape to what the app already
// posts continuously while it's open.
//
// No-op everywhere the native module is absent: Android, web, and any build
// older than 65 (requireOptionalNativeModule returns null — see
// modules/hairpin-system).

import { Platform } from 'react-native';
import { HairpinSystem, type HairpinVisit } from '../modules/hairpin-system';
import { api } from './api';
import { getSettings, getAvatarMode } from './settings';

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
    // Same privacy gate as presence: ghosts broadcast nothing, ever.
    if (getAvatarMode(getSettings()) === 'ghost') return;
    // CLVisit can occasionally re-deliver; one post per 60s is plenty.
    const now = Date.now();
    if (now - _lastPostTs < 60_000) return;
    _lastPostTs = now;
    await api.post('/location', { lat: v.lat, lng: v.lng, speed: 0, heading: 0 });
  } catch {}
}
