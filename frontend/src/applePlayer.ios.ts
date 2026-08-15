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

// TRUE only when MusicKit's native module is actually present in this JS context.
// It was hardcoded `true`, so if the module was missing the UI still offered Apple
// Music controls that could never work — and every call went to `MusicModule.x()` on
// an undefined object. The package's own module-scope emitter used to make that case
// fatal at import; now that it degrades (see the patch), this is what stops the app
// pretending the feature is available.
export const isMusicSupported = !!(NativeModules as any)?.MusicModule;

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

/**
 * Search the Apple Music CATALOG for playlists by name.
 *
 * Exists so a shared PERSONAL playlist can be resolved on the recipient's device.
 * A library playlist id ("p....") is private to the sender's account and resolves
 * to nothing for anyone else, so the name is the only shareable handle there is.
 *
 * ⚠ NEEDS BUILD 71. The stock native module only accepts "songs" and "albums" as
 * search types and drops anything else on the floor (CatalogService.search's
 * `default: return nil`), so on build 70 and earlier this returns [] — which is
 * exactly the behaviour we have today. Safe to ship OTA ahead of the build; it
 * simply starts working once the patched binary is installed. The patch adds
 * `case "playlists": return Playlist.self` plus the result plumbing.
 */
export async function searchPlaylists(query: string): Promise<ApplePlaylist[]> {
  const q = query.trim();
  if (!q) return [];
  const Native: any = (NativeModules as any).MusicModule;
  try {
    const res: any = Native?.catalogSearch
      ? await Native.catalogSearch(q, ["playlists"], {})
      : await (MusicKit as any).catalogSearch(q, ["playlists"]);
    const list: any[] = res?.playlists ?? res?.results?.playlists ?? [];
    if (!Array.isArray(list)) return [];
    return list.map((p: any) => ({
      id: String(p?.id ?? ""),
      name: p?.name ?? p?.title ?? "",
      artworkUrl: rawArt(p),
      trackCount: p?.trackCount,
    })) as ApplePlaylist[];
  } catch (e) {
    console.warn("[applePlayer] searchPlaylists failed", e);
    return [];
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

// Does this MusicKit id belong to the user's LIBRARY, or to the Apple Music CATALOG?
// Mirrors QueueService.isLibraryId in the native module — library ids are prefixed
// "l.", "i." or "p.", and everything else is catalog.
// ⚠ Note "pl." (an Apple-curated playlist) does NOT match "p." — the dot matters, and
// that distinction is the whole of the bug fixed below.
export function isAppleLibraryId(id: string): boolean {
  return /^(l\.|i\.|p\.)/.test(id || "");
}

/**
 * Play a recently-played item — library OR catalog.
 *
 * ── THE BUG (Jeff, 2026-07-30) ────────────────────────────────────────────────
 * "The 2 recently played playlists with the album art are Apple Music's curated
 * playlists, not mine, but they're not clickable/playable."
 *
 * Recently Played mixes the user's own library items with Apple's CATALOG ones —
 * that is where "100 All-Time Summer Songs" and "Afrobeats Hits" come from, and you
 * can tell them apart by the little Apple Music badge on the artwork. This function
 * hard-coded the LIBRARY path for every playlist (playLibraryPlaylist -> a library
 * fetch by id). A curated playlist's id is a catalog id (pl....), so that lookup
 * found nothing, threw itemNotFound("Playlist", inLibrary: true), and the catch below
 * turned it into a console.warn — a tap that silently did nothing.
 *
 * setPlaybackQueue already routes by id prefix in the native module and handles song,
 * album, playlist and station on BOTH sides. So stop second-guessing it: hand it the
 * id and the type and let it choose. Library items behave exactly as before.
 */
export async function playRecentItem(item: RecentItem): Promise<void> {
  if (!item?.id) return;
  try {
    await (MusicKit as any).setPlaybackQueue(item.id, item.type || "album");
    await Player.play();
  } catch (e) {
    console.warn("[applePlayer] playRecentItem failed", e);
  }
}

/**
 * Play a playlist by id, from the library or the catalog. Used by the playlist
 * cards and by an incoming shared playlist.
 */
export async function playPlaylist(playlistId: string): Promise<boolean> {
  if (!playlistId) return false;
  try {
    await (MusicKit as any).setPlaybackQueue(playlistId, "playlist");
    await Player.play();
    return true;
  } catch (e) {
    console.warn("[applePlayer] playPlaylist failed", e);
    return false;
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

export const toggle = (): void => {
  try { Player.togglePlayerState(); } catch (e) { console.warn("[applePlayer] toggle failed", e); }
};

export const skipNext = (): void => {
  try { Player.skipToNextEntry(); } catch (e) { console.warn("[applePlayer] skipNext failed", e); }
};

export const skipPrev = (): void => {
  try { Player.skipToPreviousEntry(); } catch (e) { console.warn("[applePlayer] skipPrev failed", e); }
};

// Shuffle on/off (iOS 16+). Added to @lomray/react-native-apple-music via
// patch-package (it ships no shuffle control) — see patches/.
export const setShuffle = (enabled: boolean): void => {
  try { (Player as any).setShuffleMode(enabled); } catch (e) { console.warn("[applePlayer] setShuffle failed", e); }
};

// ---- In-app Apple Music ducking (Nova voice + walkie comms) ---------------
// The in-app Apple Music player (MusicKit) is an out-of-process system player,
// so it is NOT ducked by Convoy's expo-av `.duckOthers` session — that only
// ducks OTHER apps (e.g. Spotify), never same-app audio. And MusicKit's system
// player exposes NO app-settable volume — we can only play()/pause() it, there's
// no "play at 25%". So to keep it out of the way of speech/comms we pause it and
// resume afterwards.
//
// Multiple things want it paused at once (a Nova callout can land while a crew
// transmission is coming in, or while you're holding the mic). A single boolean
// flag would let whichever finishes FIRST resume the music while the other still
// needs it silent. So we track a SET of active duck reasons: the music pauses when
// the first reason arrives and only resumes when the LAST reason clears. Each
// reason is idempotent (a queue of 3 incoming clips all pass "comms" → one entry),
// and we only resume if WE actually paused it (never start playback the user had
// paused themselves).
const _duckReasons = new Set<string>();
let _weReallyPaused = false;

export async function duckMusicFor(reason: string): Promise<void> {
  const wasIdle = _duckReasons.size === 0;
  _duckReasons.add(reason);
  if (!wasIdle) return; // already paused by another reason
  try {
    const st = await Player.getCurrentState();
    if (String(st?.playbackStatus) === "playing") {
      _weReallyPaused = true;
      Player.pause();
    }
  } catch {
    // getCurrentState unsupported / nothing loaded — leave music untouched.
  }
}

export async function unduckMusicFor(reason: string): Promise<void> {
  if (!_duckReasons.delete(reason)) return; // wasn't holding this reason
  if (_duckReasons.size > 0) return;         // someone else still needs silence
  if (!_weReallyPaused) return;              // we never paused it — don't start it
  _weReallyPaused = false;
  try { Player.play(); } catch {}
}

// Nova/nav TTS ducking — thin wrappers over the reason-set (reason "nova").
export const duckForSpeech = (): Promise<void> => duckMusicFor("nova");
export const unduckForSpeech = (): Promise<void> => unduckMusicFor("nova");

// ---- Reactive hooks (re-exported straight from the native module) --------

export { useCurrentSong, useIsPlaying };
