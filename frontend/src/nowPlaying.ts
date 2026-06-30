// Unified now-playing source for the map banner (and anywhere else that wants a
// single "what's playing right now" hook regardless of music provider).
//
// Apple Music exposes native REACTIVE hooks (useCurrentSong/useIsPlaying from
// @lomray/react-native-apple-music, re-exported by applePlayer) that update on
// their own. Spotify has NO such hook — SpotifyMusic.tsx polls the Web API every
// 3s into component-local state that dies when the Music tab unmounts. So the
// map banner could never see Spotify.
//
// This module closes that gap with a small module-level Spotify now-playing
// store (the same Set<Listener> pub/sub the rest of the app uses) driven by ONE
// shared 3s poller that only runs while a Spotify consumer is actually active.
// `useNowPlaying()` then branches on settings.musicSource and returns a single
// { song, isPlaying, toggle } shape. Apple users pay nothing — the Spotify
// poller never starts for them.
//
// NOTE: the Spotify path is UNTESTED on a Premium account (read of /me/player
// needs an active device; play/pause needs Premium). It is gated strictly behind
// musicSource === 'spotify', so it cannot affect Apple users.
import { useEffect, useState } from "react";
import { useSettings } from "./settings";
import { spotify } from "./spotify";
import { useCurrentSong, useIsPlaying, toggle as appleToggle } from "./applePlayer";

// A song shape that is a superset of what Apple and Spotify return, so the
// banner's existing `song.title ?? song.name` / `song.artistName ?? song.artist`
// / `song.artworkUrl ?? song.artwork?.url` reads work for either provider.
export type NowSong = {
  title?: string;
  name?: string;
  artistName?: string;
  artist?: string;
  artworkUrl?: string;
  artwork?: { url?: string };
} | null;

export type NowPlaying = {
  song: NowSong;
  isPlaying: boolean;
  toggle: () => void;
};

// ─── Spotify now-playing store (module-level pub/sub + single poller) ─────────
type SpotState = { song: NowSong; isPlaying: boolean };
let spotState: SpotState = { song: null, isPlaying: false };
const spotListeners = new Set<(s: SpotState) => void>();
let pollTimer: ReturnType<typeof setInterval> | null = null;
let activeCount = 0;

function emitSpot() {
  for (const l of spotListeners) l(spotState);
}

function mapSpotifyItem(item: any): NowSong {
  if (!item) return null;
  return {
    title: item.name,
    artistName: (item.artists ?? []).map((a: any) => a?.name).filter(Boolean).join(", "),
    // Spotify art is a plain URL (no {w}/{h} template), which passes untouched
    // through the banner's artURL string-replace.
    artworkUrl: item.album?.images?.[0]?.url,
  };
}

async function pollSpotifyOnce() {
  // callSafe (inside spotify.*) returns null with NO network call when there's
  // no token, and null on 204/empty — so an idle/logged-out Spotify just clears
  // the banner instead of throwing.
  const st = await spotify.playbackState();
  if (st) {
    spotState = { song: mapSpotifyItem(st.item), isPlaying: !!st.is_playing };
    emitSpot();
    return;
  }
  const cur = await spotify.currentlyPlaying();
  spotState = { song: mapSpotifyItem(cur?.item), isPlaying: !!cur?.is_playing };
  emitSpot();
}

function startSpotPoller() {
  if (pollTimer) return;
  pollSpotifyOnce();
  pollTimer = setInterval(pollSpotifyOnce, 3000);
}
function stopSpotPoller() {
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
}

async function toggleSpotifyPlayback() {
  const wasPlaying = spotState.isPlaying;
  // Optimistic flip so the banner button responds instantly.
  spotState = { ...spotState, isPlaying: !wasPlaying };
  emitSpot();
  try {
    // 403 (no Premium) / 404 (no active device) are swallowed — the map banner
    // is glanceable; full transport + the "open Spotify"/"Premium needed" hints
    // live in the Music tab. A failed toggle is reconciled by the next poll.
    await (wasPlaying ? spotify.pause() : spotify.resume());
  } catch {}
  setTimeout(() => { pollSpotifyOnce(); }, 600);
}

function useSpotifyNowPlaying(active: boolean): NowPlaying {
  const [s, setS] = useState<SpotState>(spotState);
  useEffect(() => {
    if (!active) return;
    const listener = (next: SpotState) => setS(next);
    spotListeners.add(listener);
    setS(spotState); // sync to current store value immediately
    activeCount++;
    if (activeCount === 1) startSpotPoller();
    return () => {
      spotListeners.delete(listener);
      activeCount = Math.max(0, activeCount - 1);
      if (activeCount === 0) stopSpotPoller();
    };
  }, [active]);
  return {
    song: active ? s.song : null,
    isPlaying: active ? s.isPlaying : false,
    toggle: () => { toggleSpotifyPlayback(); },
  };
}

function useAppleNowPlaying(): NowPlaying {
  const { song } = useCurrentSong() as { song: any };
  const { isPlaying } = useIsPlaying();
  return { song: (song ?? null) as NowSong, isPlaying: !!isPlaying, toggle: () => appleToggle() };
}

/**
 * Reactive now-playing for whatever provider the user picked. Both provider
 * hooks are ALWAYS called (rules of hooks); the Spotify poller stays dormant
 * unless musicSource === 'spotify'.
 */
export function useNowPlaying(): NowPlaying {
  const [settings] = useSettings();
  const source = settings?.musicSource ?? null;
  const apple = useAppleNowPlaying();
  const spot = useSpotifyNowPlaying(source === "spotify");
  return source === "spotify" ? spot : apple;
}
