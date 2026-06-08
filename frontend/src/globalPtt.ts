// Global push-to-talk recorder (singleton).
//
// Lets the bottom Comms TAB BUTTON transmit to the user's active channel via
// press-and-hold, without opening the Comms screen. The Comms screen keeps its
// own recorder (usePttChannel); the tab button gates hold-to-talk to when Comms
// is NOT the focused tab, so the two recorders never run at the same time.
//
// This mirrors pttChannel's proven send path: permission gate (never start a
// recording in the same gesture as the OS prompt), runaway-mic guard, a 60s
// hard cap, proximity-aware quality, and the same POST /ptt fan-out. Floor
// control + the WebSocket are already global (livePtt), so this only owns the
// recorder.

import { Audio } from "expo-av";
import { api } from "./api";
import { getSettings } from "./settings";
import { getLatestTier, getPttRecordingOptions } from "./proximityAudio";
import { acquireFloor, releaseFloor, getFloorHolder } from "./livePtt";
import { setRecordingAudioMode, setIdleAudioMode } from "./audioMode";

let rec: Audio.Recording | null = null;
let startedAt = 0;
// True between press-down and release. Lets an async start detect a release
// that arrived BEFORE recording actually began (the runaway-mic fix).
let want = false;
let activeChannel: string | null = null;
let maxTimer: ReturnType<typeof setTimeout> | null = null;

// Tiny pub/sub so the tab button can reflect a "transmitting" state visually.
type TxListener = (txing: boolean) => void;
const txListeners = new Set<TxListener>();
export const globalPttBus = {
  on(fn: TxListener) { txListeners.add(fn); return () => { txListeners.delete(fn); }; },
  emit(v: boolean) { txListeners.forEach((fn) => { try { fn(v); } catch {} }); },
};

export function isGlobalRecording(): boolean { return !!rec; }

// The active channel = the selected private thread, else the active community
// (whole-crew). Matches talk.tsx's channelId resolution.
function currentChannel(): string | null {
  const s = getSettings();
  return (s.activeThreadId || s.activeCommunityId) || null;
}

async function uriToBase64(uri: string): Promise<string> {
  const res = await fetch(uri);
  const blob = await res.blob();
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onloadend = () => resolve(((reader.result as string) || "").split(",")[1] || "");
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });
}

export type PttDownResult = "recording" | "no-channel" | "blocked" | "prompted";

/**
 * Begin transmitting to the active channel. Returns a status so the caller can
 * give appropriate feedback (open Comms if there's no channel, warn if someone
 * else holds the floor, etc.). `selfId` lets us respect another driver who
 * currently holds the floor.
 */
export async function pttDown(selfId?: string | null): Promise<PttDownResult> {
  if (rec) return "recording"; // already transmitting — ignore re-entry
  const ch = currentChannel();
  if (!ch) return "no-channel";
  // Respect the walkie floor: if someone else holds it, don't cut in.
  const holder = getFloorHolder(ch);
  if (holder && (!selfId || holder.id !== selfId)) return "blocked";

  want = true;
  // Permission gate (mirrors pttChannel.ensurePerm): if we must show the OS
  // prompt, do NOT start a recording in this gesture — starting one while the
  // iOS audio session is re-activating right after the prompt crashes the app.
  // Permission is then granted, so the user's NEXT hold records cleanly.
  const perm = await Audio.getPermissionsAsync();
  if (perm.status !== "granted") {
    if (perm.canAskAgain) { try { await Audio.requestPermissionsAsync(); } catch {} }
    want = false;
    return "prompted";
  }
  await setRecordingAudioMode();
  if (!want) return "prompted"; // released during the permission/mode await
  try {
    const r = new Audio.Recording();
    await r.prepareToRecordAsync(getPttRecordingOptions(getLatestTier().tier));
    await r.startAsync();
    // Runaway-mic guard: if the user already released while we were preparing,
    // stop+discard now instead of leaving a hot mic running.
    if (!want) {
      try { await r.stopAndUnloadAsync(); } catch {}
      return "prompted";
    }
    rec = r;
    activeChannel = ch;
    startedAt = Date.now();
    acquireFloor(ch);
    globalPttBus.emit(true);
    // Hard-cap a single transmission at 60s so a missed release can't record
    // indefinitely.
    if (maxTimer) clearTimeout(maxTimer);
    maxTimer = setTimeout(() => { pttUp().catch(() => {}); }, 60000);
    return "recording";
  } catch {
    rec = null;
    want = false;
    globalPttBus.emit(false);
    return "prompted";
  }
}

/** Stop transmitting and broadcast the clip to the channel. Safe when idle. */
export async function pttUp(): Promise<boolean> {
  want = false;
  if (maxTimer) { clearTimeout(maxTimer); maxTimer = null; }
  const r = rec;
  rec = null;
  const ch = activeChannel;
  activeChannel = null;
  globalPttBus.emit(false);
  if (ch) releaseFloor(ch);
  if (!r) return false;

  let uri: string | null = null;
  let durationMs = Date.now() - startedAt;
  try {
    try { const st: any = await r.getStatusAsync(); if (st?.durationMillis) durationMs = st.durationMillis; } catch {}
    await r.stopAndUnloadAsync();
    uri = r.getURI();
  } catch {
    uri = r.getURI?.() ?? null;
  }
  // Restore loud playback/idle mode so incoming clips aren't stuck on the iOS
  // earpiece after a recording flipped us into .playAndRecord.
  setIdleAudioMode();

  if (!uri || !ch) return false;
  if (durationMs < 300) return false; // ignore accidental sub-300ms taps
  try {
    const audio_b64 = await uriToBase64(uri);
    if (!audio_b64) return false;
    await api.post("/ptt", { channel: ch, audio_b64, duration_ms: Math.round(durationMs) });
    // Backend echoes the clip to channel members (incl. us) over the WS, which
    // the live bus appends to history — so we don't optimistically add it here.
    return true;
  } catch {
    return false;
  }
}
