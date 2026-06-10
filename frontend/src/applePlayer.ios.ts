// applePlayer.ios.ts — iOS implementation.
//
// Wraps the native Apple MusicKit framework via @lomray/react-native-apple-music.
// Auth + the user's LIBRARY (playlists, library songs, recently played) need
// only the user's authorization — no developer token. CATALOG access (search +
// catalog playback) additionally needs the app's MusicKit developer-token
// entitlement provisioned into the build; if that's missing the native call
// rejects, which is why catalog search can come back empty even when auth
// succeeds. searchSongsDiagnostic() surfaces that real error to the UI.
//
// Metro resolves this *.ios.ts variant on iOS; every other platform gets the
// no-op stub in applePlayer.ts, so the native module is never bundled off-iOS.

import { NativeModules } from "react-native";
import {
  Auth,
  Player,
  MusicKit,
  useCurrentSong,
  useIsPlaying,
} from "@lomray/react-native-apple-music";

export const isMusicSupported = true;

export type AppleSong = {
  id: string;
  title?: string;
  artistName?: string;
  albumName?: string;
  artworkUrl?: string;
  duration?: number; // ms
};

export type ApplePlaylist = {
  id: string;
  name: string;
  artworkUrl?: string;
  trackCount?: number;
  description?: string;
};

export type RecentItem = {
  id: string;
  title: string;
  subtitle?: string;
  artworkUrl?: string;
  type?: string; // "song" | "album" | "playlist" | "station"
};

// ---- Authorization -------------------------------------------------------

/** Request Apple Music authorization. Resolves true when the user grants it. */
export async function authorize(): Promise<boolean> {
  try {
    const status = await Auth.authorize();
    return status === "authorized" || (status as unknown) === true;
  } catch (e) {
    console.warn("[applePlayer] authorize failed", e);
    return false;
  }
}

/** Check the user's Apple Music subscription capabilities. */
export async function checkSubscription(): Promise<{
  canPlay: boolean;
  canSubscribe: boolean;
}> {
  try {
    const sub: any = await Auth.checkSubscription();
    return {
      canPlay: !!sub?.canPlayCatalogContent,
      canSubscribe: !!sub?.canBecomeSubscriber,
    };
  } catch (e) {
    console.warn("[applePlayer] checkSubscription failed", e);
    return { canPlay: false, canSubscribe: true };
  }
}

// ---- Shared mappers ------------------------------------------------------

/** Raw Apple artwork URL/template (sizing is applied at the UI layer). */
function rawArt(s: any): string | undefined {
  const raw =
    s?.artworkUrl ??
    s?.artwork?.url ??
    s?.attributes?.artwork?.url ??
    undefined;
  return typeof raw === "string" && raw ? raw : undefined;
}

function mapSong(s: any): AppleSong {
  return {
    id: String(s?.id ?? s?.songId ?? s?.playParams?.id ?? ""),
    title: s?.title ?? s?.name ?? s?.attributes?.name,
    artistName: s?.artistName ?? s?.artist ?? s?.attributes?.artistName,
    albumName: s?.albumName ?? s?.attributes?.albumName,
    artworkUrl: rawArt(s),
    duration: Number(s?.duration ?? s?.attributes?.durationInMillis ?? 0),
  };
}

function errText(e: any): string {
  return String(e?.message ?? e?.code ?? (typeof e === "string" ? e : JSON.stringify(e)) ?? "unknown error");
}

// ---- Catalog search ------------------------------------------------------

/** Search the Apple Music catalog for songs. Always resolves to an array. */
export async function searchSongs(query: string): Promise<AppleSong[]> {
  return (await searchSongsDiagnostic(query)).songs;
}

/**
 * Catalog search that DOES NOT swallow the native error.
 *
 * MusicKit.catalogSearch() internally try/catches and returns
 * `{songs:[],albums:[]}` on failure, hiding why it failed. Here we call the
 * native MusicModule.catalogSearch directly so a token/storefront/entitlement
 * rejection bubbles up and we can display it. Falls back to the library wrapper
 * if the native module isn't reachable for some reason.
 */
export async function searchSongsDiagnostic(
  query: string
): Promise<{ songs: AppleSong[]; error?: string }> {
  const q = query.trim();
  if (!q) return { songs: [] };
  const Native: any = (NativeModules as any).MusicModule;
  try {
    let res: any;
    if (Native?.catalogSearch) {
      res = await Native.catalogSearch(q, ["songs"], {});
    } else {
      res = await (MusicKit as any).catalogSearch(q, ["songs"]);
    }
    const list: any[] =
      res?.songs ?? res?.results?.songs ?? (Array.isArray(res) ? res : []);
    return { songs: (Array.isArray(list) ? list : []).map(mapSong) };
  } catch (e: any) {
    console.warn("[applePlayer] catalogSearch native error", e);
    return { songs: [], error: errText(e) };
  }
}

// ---- Library (needs only user authorization) -----------------------------

export async function getUserPlaylists(
  limit = 50
): Promise<{ playlists: ApplePlaylist[]; error?: string }> {
  try {
    const res: any = await (MusicKit as any).getUserPlaylists({ limit });
    const list: any[] = res?.playlists ?? [];
    return {
      playlists: (Array.isArray(list) ? list : []).map((p: any) => ({
        id: String(p?.id ?? ""),
        name: p?.name ?? "Playlist",
        artworkUrl: rawArt(p),
        trackCount: Number(p?.trackCount ?? 0),
        description: p?.description,
      })),
    };
  } catch (e: any) {
    console.warn("[applePlayer] getUserPlaylists failed", e);
    return { playlists: [], error: errText(e) };
  }
}

export async function getLibrarySongs(
  limit = 60
): Promise<{ songs: AppleSong[]; error?: string }> {
  try {
    const res: any = await (MusicKit as any).getLibrarySongs({ limit });
    const list: any[] = res?.songs ?? [];
    return { songs: (Array.isArray(list) ? list : []).map(mapSong) };
  } catch (e: any) {
    console.warn("[applePlayer] getLibrarySongs failed", e);
    return { songs: [], error: errText(e) };
  }
}

export async function getRecentlyPlayed(): Promise<{ items: RecentItem[]; error?: string }> {
  try {
    const res: any = await (MusicKit as any).getTracksFromLibrary();
    const list: any[] = res?.recentlyPlayedItems ?? [];
    return {
      items: (Array.isArray(list) ? list : []).map((t: any) => ({
        id: String(t?.id ?? ""),
        title: t?.title ?? "",
        subtitle: t?.subtitle ?? "",
        artworkUrl: rawArt(t),
        type: t?.type,
      })),
    };
  } catch (e: any) {
    console.warn("[applePlayer] getRecentlyPlayed failed", e);
    return { items: [], error: errText(e) };
  }
}

export async function getPlaylistSongs(playlistId: string): Promise<AppleSong[]> {
  if (!playlistId) return [];
  try {
    const res: any = await (MusicKit as any).getPlaylistSongs(playlistId, {});
    const list: any[] = res?.songs ?? [];
    return (Array.isArray(list) ? list : []).map(mapSong);
  } catch (e) {
    console.warn("[applePlayer] getPlaylistSongs failed", e);
    return [];
  }
}

// ---- Library playback ----------------------------------------------------

export async function playLibrarySong(songId: string): Promise<void> {
  if (!songId) return;
  try {
    await (MusicKit as any).playLibrarySong(songId);
    await Player.play();
  } catch (e) {
    console.warn("[applePlayer] playLibrarySong failed", e);
  }
}

export async function playLibraryPlaylist(playlistId: string, startingAt = -1): Promise<void> {
  if (!playlistId) return;
  try {
    await (MusicKit as any).playLibraryPlaylist(playlistId, startingAt);
    await Player.play();
  } catch (e) {
    console.warn("[applePlayer] playLibraryPlaylist failed", e);
  }
}

/** Best-effort play for a recently-played library item (song/playlist/album). */
export async function playRecentItem(item: RecentItem): Promise<void> {
  if (!item?.id) return;
  try {
    if (item.type === "playlist") {
      await (MusicKit as any).playLibraryPlaylist(item.id, -1);
    } else if (item.type === "song") {
      await (MusicKit as any).playLibrarySong(item.id);
    } else {
      await (MusicKit as any).setPlaybackQueue(item.id, item.type || "album");
    }
    await Player.play();
  } catch (e) {
    console.warn("[applePlayer] playRecentItem failed", e);
  }
}

// ---- Catalog playback ----------------------------------------------------

/** Queue a single catalog song by ID and start playback. */
export async function playSong(songId: string): Promise<void> {
  if (!songId) return;
  try {
    await (MusicKit as any).setPlaybackQueue(songId, "song");
    await Player.play();
  } catch (e) {
    console.warn("[applePlayer] playSong failed", e);
  }
}

export const play = (): void => {
  try { Player.play(); } catch (e) { console.warn("[applePlayer] play failed", e); }
};

export const pause = (): void => {
  try { Player.pause(); } catch (e) { console.warn("[applePlayer] pause failed", e); }
};

export const toggle = (): void => {
  try { Player.togglePlayerState(); } catch (e) { console.warn("[applePlayer] toggle failed", e); }
};

export const skipNext = (): void => {
  try { Player.skipToNextEntry(); } catch (e) { console.warn("[applePlayer] skipNext failed", e); }
};

export const skipPrev = (): void => {
  try { Player.skipToPreviousEntry(); } catch (e) { console.warn("[applePlayer] skipPrev failed", e); }
};

// ---- Nova voice ducking --------------------------------------------------
// The in-app Apple Music player (MusicKit) is an out-of-process system player,
// so it is NOT ducked by Convoy's expo-av `.duckOthers` session — that only
// ducks OTHER apps (e.g. Spotify), never same-app audio. So while Nova speaks
// we explicitly pause Apple Music and resume it afterwards. We only pause when
// it's actually playing, and only resume if WE paused it, so we never start
// playback the user had paused themselves.
let _duckedByNova = false;

export async function duckForSpeech(): Promise<void> {
  try {
    const st = await Player.getCurrentState();
    if (String(st?.playbackStatus) === "playing") {
      _duckedByNova = true;
      Player.pause();
    }
  } catch {
    // getCurrentState unsupported / nothing loaded — leave music untouched.
  }
}

export async function unduckForSpeech(): Promise<void> {
  if (!_duckedByNova) return;
  _duckedByNova = false;
  try { Player.play(); } catch {}
}

// ---- Reactive hooks (re-exported straight from the native module) --------

export { useCurrentSong, useIsPlaying };
