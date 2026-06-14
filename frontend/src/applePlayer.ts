// applePlayer.ts — non-iOS stub (web + Android).
//
// Apple MusicKit is iOS-only. Metro resolves applePlayer.ios.ts on iOS and this
// file everywhere else, so the native module is never bundled off-iOS. Every
// export mirrors the iOS variant's shape with safe no-ops/defaults, letting the
// shared music screen render its deep-link fallback without crashing.

export const isMusicSupported = false;

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
  type?: string;
};

export async function authorize(): Promise<boolean> {
  return false;
}

export async function checkSubscription(): Promise<{
  canPlay: boolean;
  canSubscribe: boolean;
}> {
  return { canPlay: false, canSubscribe: false };
}

export async function searchSongs(_query: string): Promise<AppleSong[]> {
  return [];
}

export async function searchSongsDiagnostic(
  _query: string
): Promise<{ songs: AppleSong[]; error?: string }> {
  return { songs: [] };
}

export async function getUserPlaylists(
  _limit?: number
): Promise<{ playlists: ApplePlaylist[]; error?: string }> {
  return { playlists: [] };
}

export async function getLibrarySongs(
  _limit?: number
): Promise<{ songs: AppleSong[]; error?: string }> {
  return { songs: [] };
}

export async function getRecentlyPlayed(): Promise<{ items: RecentItem[]; error?: string }> {
  return { items: [] };
}

export async function getPlaylistSongs(_playlistId: string): Promise<AppleSong[]> {
  return [];
}

export async function playLibrarySong(_songId: string): Promise<void> {
  /* no-op off iOS */
}

export async function playLibraryPlaylist(_playlistId: string, _startingAt?: number): Promise<void> {
  /* no-op off iOS */
}

export async function playRecentItem(_item: RecentItem): Promise<void> {
  /* no-op off iOS */
}

export async function playSong(_songId: string): Promise<void> {
  /* no-op off iOS */
}

export const play = (): void => {};
export const pause = (): void => {};
export const toggle = (): void => {};
export const skipNext = (): void => {};
export const skipPrev = (): void => {};
export const setShuffle = (_enabled: boolean): void => {};

export async function duckForSpeech(): Promise<void> {
  /* no-op off iOS — external apps duck via the audio session */
}

export async function unduckForSpeech(): Promise<void> {
  /* no-op off iOS */
}

export const useCurrentSong = (): { song: AppleSong | null } => ({ song: null });
export const useIsPlaying = (): { isPlaying: boolean } => ({ isPlaying: false });
