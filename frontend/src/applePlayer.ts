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

export async function playSong(_songId: string): Promise<void> {
  /* no-op off iOS */
}

export const play = (): void => {};
export const pause = (): void => {};
export const toggle = (): void => {};
export const skipNext = (): void => {};
export const skipPrev = (): void => {};

export const useCurrentSong = (): { song: AppleSong | null } => ({ song: null });
export const useIsPlaying = (): { isPlaying: boolean } => ({ isPlaying: false });
