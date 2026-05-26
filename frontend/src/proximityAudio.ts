// Adaptive audio quality per convoy proximity.
//
// The single source of truth: the user's distance to the CLOSEST peer in
// their active community. The map screen already maintains the peer list
// (via Supabase Realtime presence) and the user's GPS coordinates, so it
// computes the tier and publishes it through `setLatestTier()` below. Talk
// (PTT) and Music screens subscribe via `useLatestTier()` — no duplicate
// presence subscriptions, no extra GPS reads.
//
//   close (< 500 m)  → "HD"        → 128k AAC stereo 44.1kHz / lossless music
//   mid   (< 2 km)   → "Clear"     →  64k AAC mono  22kHz   / high music
//   far   (≥ 2 km)   → "Standard"  →  32k AAC mono  16kHz   / normal music
//
// The thresholds are deliberately generous: car-to-car LTE/5G drops as the
// convoy stretches across kilometres, and a stereo 128k payload over weak
// signal will choke. Walkie-talkie-grade 32k mono streams cleanly even on
// 3G.
import { Audio } from "expo-av";
import { useEffect, useState } from "react";
import type { ConvoyPresencePeer } from "./convoyPresence";

// ----- Distance thresholds (metres) -----
export const PROXIMITY_CLOSE_M = 500;
export const PROXIMITY_MID_M = 2000;

export type ProximityTier = "close" | "mid" | "far";

/** Great-circle distance between two lat/lng points (Haversine, metres). */
export function haversineM(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const R = 6371000;
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLng = ((lng2 - lng1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((lat1 * Math.PI) / 180) *
      Math.cos((lat2 * Math.PI) / 180) *
      Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

/**
 * Closest-peer tier. Returns "far" with zero peers so a solo driver doesn't
 * burn bandwidth on HD when nobody is listening.
 */
export function getProximityTier(
  userLat: number,
  userLng: number,
  peers: { lat: number; lng: number }[]
): ProximityTier {
  if (!peers || peers.length === 0) return "far";
  let minDist = Infinity;
  for (const p of peers) {
    const d = haversineM(userLat, userLng, p.lat, p.lng);
    if (d < minDist) minDist = d;
  }
  if (minDist <= PROXIMITY_CLOSE_M) return "close";
  if (minDist <= PROXIMITY_MID_M) return "mid";
  return "far";
}

// ============================================================
// PTT recording presets per tier
// ============================================================
export function getPttRecordingOptions(tier: ProximityTier): Audio.RecordingOptions {
  switch (tier) {
    case "close":
      // High quality: 128 kbps AAC, 44.1 kHz stereo. Sounds great on local
      // WiFi / strong LTE when the convoy is in the same parking lot.
      return {
        isMeteringEnabled: true,
        android: {
          extension: ".m4a",
          outputFormat: Audio.AndroidOutputFormat.MPEG_4,
          audioEncoder: Audio.AndroidAudioEncoder.AAC,
          sampleRate: 44100,
          numberOfChannels: 2,
          bitRate: 128000,
        },
        ios: {
          extension: ".m4a",
          outputFormat: Audio.IOSOutputFormat.MPEG4AAC,
          audioQuality: Audio.IOSAudioQuality.MAX,
          sampleRate: 44100,
          numberOfChannels: 2,
          bitRate: 128000,
          linearPCMBitDepth: 16,
          linearPCMIsBigEndian: false,
          linearPCMIsFloat: false,
        },
        web: { mimeType: "audio/webm;codecs=opus", bitsPerSecond: 128000 },
      };
    case "mid":
      // Medium: 64 kbps AAC mono — clear voice at half the bandwidth.
      return {
        isMeteringEnabled: true,
        android: {
          extension: ".m4a",
          outputFormat: Audio.AndroidOutputFormat.MPEG_4,
          audioEncoder: Audio.AndroidAudioEncoder.AAC,
          sampleRate: 22050,
          numberOfChannels: 1,
          bitRate: 64000,
        },
        ios: {
          extension: ".m4a",
          outputFormat: Audio.IOSOutputFormat.MPEG4AAC,
          audioQuality: Audio.IOSAudioQuality.MEDIUM,
          sampleRate: 22050,
          numberOfChannels: 1,
          bitRate: 64000,
          linearPCMBitDepth: 16,
          linearPCMIsBigEndian: false,
          linearPCMIsFloat: false,
        },
        web: { mimeType: "audio/webm;codecs=opus", bitsPerSecond: 64000 },
      };
    case "far":
    default:
      // Efficient: 32 kbps AAC mono — walkie-talkie quality, minimal data
      // usage on a stretched highway convoy where every byte counts.
      return {
        isMeteringEnabled: true,
        android: {
          extension: ".m4a",
          outputFormat: Audio.AndroidOutputFormat.MPEG_4,
          audioEncoder: Audio.AndroidAudioEncoder.AAC,
          sampleRate: 16000,
          numberOfChannels: 1,
          bitRate: 32000,
        },
        ios: {
          extension: ".m4a",
          outputFormat: Audio.IOSOutputFormat.MPEG4AAC,
          audioQuality: Audio.IOSAudioQuality.LOW,
          sampleRate: 16000,
          numberOfChannels: 1,
          bitRate: 32000,
          linearPCMBitDepth: 16,
          linearPCMIsBigEndian: false,
          linearPCMIsFloat: false,
        },
        web: { mimeType: "audio/webm;codecs=opus", bitsPerSecond: 32000 },
      };
  }
}

// ============================================================
// Music broadcast quality per tier
// ============================================================
export type MusicBroadcastQuality = "lossless" | "high" | "normal";

export function getMusicBroadcastQuality(tier: ProximityTier): MusicBroadcastQuality {
  switch (tier) {
    case "close":
      return "lossless"; // Spotify "Very High" / Apple Lossless
    case "mid":
      return "high"; // Spotify "High" / Apple "High"
    case "far":
    default:
      return "normal"; // Spotify "Normal" / Apple "High Efficiency"
  }
}

// ============================================================
// Shared tier store — single source of truth
// ============================================================
// The map screen computes the tier every time the peer list or its own GPS
// changes and pushes it here. Other screens (talk/music) subscribe via the
// `useLatestTier()` hook. Module-level state so it survives across screens
// without needing a React context.
type Listener = (tier: ProximityTier, peerCount: number) => void;
let _latestTier: ProximityTier = "far";
let _peerCount = 0;
const _listeners = new Set<Listener>();

/** Publish from map.tsx whenever peers or self-coords change. */
export function setLatestTier(tier: ProximityTier, peerCount: number): void {
  if (tier === _latestTier && peerCount === _peerCount) return;
  _latestTier = tier;
  _peerCount = peerCount;
  _listeners.forEach((fn) => {
    try { fn(tier, peerCount); } catch {}
  });
}

/** Synchronous read. Useful inside event handlers where a hook would be overkill. */
export function getLatestTier(): { tier: ProximityTier; peerCount: number } {
  return { tier: _latestTier, peerCount: _peerCount };
}

/** Reactive read for screens that need to re-render on tier changes. */
export function useLatestTier(): { tier: ProximityTier; peerCount: number } {
  const [state, setState] = useState<{ tier: ProximityTier; peerCount: number }>(() => ({
    tier: _latestTier,
    peerCount: _peerCount,
  }));
  useEffect(() => {
    const fn: Listener = (tier, peerCount) => setState({ tier, peerCount });
    _listeners.add(fn);
    return () => {
      _listeners.delete(fn);
    };
  }, []);
  return state;
}

// Re-export presence peer type for convenience.
export type { ConvoyPresencePeer };
