// commsRead.ts — per-channel read/unread tracking for the Comms screen.
//
// Two independent notions of "new":
//   1. Channel-level: a thread (or the Crew channel) has activity newer than
//      the last time the user opened it → dot on its conversation chip.
//   2. Clip-level: an individual received clip in the Recent list hasn't been
//      played yet → dot on that row.
//
// Persistence: lastReadAt (per channel) survives restarts via AsyncStorage so a
// channel you'd already caught up on doesn't re-light on cold start. latestAt is
// in-memory only — rebuilt each launch from history (thread.last_at) + the live
// bus. playedIds is in-memory + capped: it only suppresses the dot on clips you
// tapped this run; on restart, still-unplayed clips simply re-evaluate against
// lastReadAt, so nothing is incorrectly marked read.
//
// Fully additive: importing/using this never touches the PTT transmit, receive,
// floor-control, or thread plumbing — it only reads timestamps that already flow
// through the app and renders dots.

import AsyncStorage from "@react-native-async-storage/async-storage";

const READ_KEY = "convoy:commsRead:v1";
const PLAYED_CAP = 300;

type Listener = () => void;

// channelId -> epoch ms of the newest activity the user has "seen" (opened it).
let lastReadAt: Record<string, number> = {};
// channelId -> epoch ms of the newest activity we know about (live + last_at).
let latestAt: Record<string, number> = {};
// Clip ids already played this run (capped, insertion-ordered for cheap evict).
const playedIds = new Set<string>();

let hydrated = false;
const listeners = new Set<Listener>();

function emit() { listeners.forEach((l) => { try { l(); } catch {} }); }

async function hydrate() {
  if (hydrated) return;
  hydrated = true;
  try {
    const raw = await AsyncStorage.getItem(READ_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === "object") lastReadAt = parsed as Record<string, number>;
    }
  } catch {}
  emit();
}
void hydrate();

async function persist() {
  try { await AsyncStorage.setItem(READ_KEY, JSON.stringify(lastReadAt)); } catch {}
}

export const commsRead = {
  subscribe(l: Listener): () => void { listeners.add(l); return () => { listeners.delete(l); }; },

  // Record that `channel` has activity at `ts` (a live clip's arrival time, or a
  // thread's last_at on load). Bumps latestAt + notifies only if genuinely newer.
  noteActivity(channel: string, ts?: number) {
    if (!channel) return;
    const t = typeof ts === "number" && ts > 0 ? ts : Date.now();
    if (t > (latestAt[channel] || 0)) {
      latestAt[channel] = t;
      emit();
    }
  },

  // User opened/viewed `channel` → mark everything up to now as read.
  markChannelRead(channel: string) {
    if (!channel) return;
    const t = Math.max(latestAt[channel] || 0, Date.now());
    if (t > (lastReadAt[channel] || 0)) {
      lastReadAt[channel] = t;
      void persist();
      emit();
    }
  },

  // True when a channel has activity newer than the last time it was opened.
  channelHasUnread(channel: string): boolean {
    if (!channel) return false;
    return (latestAt[channel] || 0) > (lastReadAt[channel] || 0);
  },

  // Clip-level: mark one received clip as played (suppresses its row dot).
  markClipPlayed(id: string) {
    if (!id || playedIds.has(id)) return;
    playedIds.add(id);
    if (playedIds.size > PLAYED_CAP) {
      const excess = playedIds.size - PLAYED_CAP;
      let i = 0;
      for (const k of playedIds) { if (i++ >= excess) break; playedIds.delete(k); }
    }
    emit();
  },

  clipPlayed(id: string): boolean { return !!id && playedIds.has(id); },
};
