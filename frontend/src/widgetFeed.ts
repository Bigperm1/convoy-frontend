// widgetFeed.ts — write side of the Hairpin home-screen widget (build 65+).
//
// Serializes the user's NEXT upcoming attending event/cruise into the shared
// App Group defaults; the WidgetKit extension (targets/widget) renders it with
// a live countdown and WidgetCenter redraws on every write. No-op on Android,
// web, and builds without the hairpin-system native module.

import { Platform } from 'react-native';
import { HairpinSystem } from '../modules/hairpin-system';
import { myEvents, type HubEvent } from './eventsApi';

const SUITE = 'group.com.sw0rdfisch.convoy';
const KEY = 'nextEvent';

// Pick the soonest event that hasn't meaningfully passed (grace for in-progress).
function nextUp(events: HubEvent[]): HubEvent | null {
  const cutoff = Date.now() - 3 * 3600_000;
  const upcoming = events
    .filter((e) => new Date(e.start_at).getTime() > cutoff)
    .sort((a, b) => new Date(a.start_at).getTime() - new Date(b.start_at).getTime());
  return upcoming[0] ?? null;
}

// Write from an already-loaded list (the Hub calls this with fresh data)…
export function updateWidgetFeed(events: HubEvent[]): void {
  if (Platform.OS !== 'ios' || !HairpinSystem) return;
  try {
    const e = nextUp(events);
    const payload = e
      ? { title: e.title, startAt: new Date(e.start_at).getTime(), kind: e.kind, venueLabel: e.venue?.label || '' }
      : {};
    HairpinSystem.setSharedDefaults(SUITE, KEY, JSON.stringify(payload));
  } catch {}
}

// …or self-fetch (app boot — keeps the widget fresh without opening the Hub).
export async function refreshWidgetFeed(): Promise<void> {
  if (Platform.OS !== 'ios' || !HairpinSystem) return;
  try {
    updateWidgetFeed(await myEvents());
  } catch {}
}
