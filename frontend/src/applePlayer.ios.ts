// applePlayer.ios.ts — iOS implementation.
//
// Wraps the native Apple MusicKit framework via @lomray/react-native-apple-music.
// The native framework auto-generates the developer token using the app's
// MusicKit App-Service capability (enabled on the App ID com.sw0rdfisch.convoy),
// so there is NO server-signed token to pass in here. The convoy-backend
// /api/apple-music/developer-token endpoint is only for the REST-API path
// (server-side search, future "listening rooms") and is not used by this file.
//
// Metro resolves this *.ios.ts variant on iOS; every other platform gets the
// no-op stub in applePlayer.ts, so the native module is never bundled off-iOS.

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
    // Assume they could subscribe so we still surface the offer UI.
    return { canPlay: false, canSubscribe: true };
  }
}

// ---- Catalog search ------------------------------------------------------

/** Pull a usable artwork URL out of whatever shape the native result uses. */
function pickArtwork(s: any): string | undefined {
  const raw =
    s?.artworkUrl ??
    s?.artwork?.url ??
    s?.attributes?.artwork?.url ??
    undefined;
  if (!raw || typeof raw !== "string") return undefined;
  // Apple artwork URLs are templates with {w}/{h}/{f} placeholders.
  return raw
    .replace("{w}", "300")
    .replace("{h}", "300")
    .replace("{f}", "jpg");
}

/** Search the Apple Music catalog for songs. Always resolves to an array. */
export async function searchSongs(query: string): Promise<AppleSong[]> {
  const q = query.trim();
  if (!q) return [];
  try {
    const res: any = await (MusicKit as any).catalogSearch(q, ["songs"]);
    const list: any[] =
      res?.songs ?? res?.results?.songs ?? (Array.isArray(res) ? res : []);
    return (Array.isArray(list) ? list : []).map((s: any) => ({
      id: String(s?.id ?? s?.songId ?? s?.playParams?.id ?? ""),
      title: s?.title ?? s?.name ?? s?.attributes?.name,
      artistName: s?.artistName ?? s?.artist ?? s?.attributes?.artistName,
      albumName: s?.albumName ?? s?.attributes?.albumName,
      artworkUrl: pickArtwork(s),
      duration: Number(s?.duration ?? s?.attributes?.durationInMillis ?? 0),
    }));
  } catch (e) {
    console.warn("[applePlayer] searchSongs failed", e);
    return [];
  }
}

// ---- Playback ------------------------------------------------------------

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
  try {
    Player.play();
  } catch (e) {
    console.warn("[applePlayer] play failed", e);
  }
};

export const pause = (): void => {
  try {
    Player.pause();
  } catch (e) {
    console.warn("[applePlayer] pause failed", e);
  }
};

export const toggle = (): void => {
  try {
    Player.togglePlayerState();
  } catch (e) {
    console.warn("[applePlayer] toggle failed", e);
  }
};

export const skipNext = (): void => {
  try {
    Player.skipToNextEntry();
  } catch (e) {
    console.warn("[applePlayer] skipNext failed", e);
  }
};

export const skipPrev = (): void => {
  try {
    Player.skipToPreviousEntry();
  } catch (e) {
    console.warn("[applePlayer] skipPrev failed", e);
  }
};

// ---- Reactive hooks (re-exported straight from the native module) --------

export { useCurrentSong, useIsPlaying };
