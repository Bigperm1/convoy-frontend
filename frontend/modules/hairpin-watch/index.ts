// modules/hairpin-watch/index.ts — typed accessor for the iOS-only local module.
// requireOptionalNativeModule ⇒ null on Android, web, and binaries cut before build 77.
import { requireOptionalNativeModule } from 'expo-modules-core';

export type WatchLinkState = { supported: boolean; paired: boolean; appInstalled: boolean; reachable: boolean; activation: number };
export type WatchFileEvent = { path: string; kind: string; ms: number };

type HairpinWatchModule = {
  getState(): WatchLinkState;
  updateContext(json: string): boolean;
  sendMessage(json: string): boolean;
  addListener(eventName: 'onWatchState', listener: (s: WatchLinkState) => void): { remove: () => void };
  addListener(eventName: 'onWatchFile', listener: (f: WatchFileEvent) => void): { remove: () => void };
  addListener(eventName: 'onWatchMessage', listener: (m: { json: string }) => void): { remove: () => void };
};

let mod: HairpinWatchModule | null = null;
try { mod = requireOptionalNativeModule<HairpinWatchModule>('HairpinWatch'); } catch { mod = null; }
export const HairpinWatch = mod;
