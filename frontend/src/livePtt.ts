// Global live walkie-talkie listener.
//
// Opens a single persistent WebSocket to /api/ws for the lifetime of the
// authenticated session and auto-plays every `ptt` transmission the user
// receives for the currently-active community channel. Mounted once at the
// (app) layout level so the user can be on the Map / Music / Hub screen and
// still hear crew comms without staring at the Comms tab.
//
// Audio playback is serialized via a single in-process queue — back-to-back
// keyups never overlap, the most-recent transmission is always reachable, and
// a failed clip can't permanently jam the line.
//
// Other screens (e.g. the Comms screen which maintains its own history list)
// can subscribe to `livePttBus` to react to incoming traffic without owning
// the socket themselves.

import { useEffect, useRef } from "react";
import { Platform } from "react-native";
import { Audio } from "expo-av";
import * as FileSystem from "expo-file-system/legacy";
import { api, getToken, wsUrl } from "./api";
import { getSettings } from "./settings";
import { hailBus } from "./hailBus";
import { shareBus } from "./shareBus";
import { setIdleAudioMode, setPlaybackAudioMode } from "./audioMode";
import { showTransmitNotification } from "./pttNotification";
import { AppState } from "react-native";

export type PTTMessage = {
  id: string;
  channel: string;
  user_id: string;
  handle: string;
  audio_b64: string;
  duration_ms: number;
  created_at: string;
};

type Listener = (m: PTTMessage) => void;

// Tiny pub/sub so other components (Comms history, in-map "X is talking"
// banner, etc.) can react to incoming PTT without owning the socket.
const listeners = new Set<Listener>();
export const livePttBus = {
  on(fn: Listener) { listeners.add(fn); return () => listeners.delete(fn); },
  emit(m: PTTMessage) { listeners.forEach((fn) => { try { fn(m); } catch {} }); },
};

// When the Comms screen is focused it shows its OWN "X is talking" indicator
// right above the mic, so the global top banner stands down there to avoid
// double-display. The Comms screen toggles this on focus / blur.
let commsScreenFocused = false;
export function setCommsScreenFocused(v: boolean) { commsScreenFocused = v; }
export function isCommsScreenFocused(): boolean { return commsScreenFocused; }

// ----- Walkie floor control (one-talker-at-a-time) -----
// The single app WS (opened below) carries floor_acquire / floor_release to
// the server and floor state back. We expose tiny send helpers + a bus so the
// Comms screen can lock the mic when someone else holds the floor. Fail-open:
// if the socket isn't up, sends are no-ops and the caller transmits anyway.
type FloorFrame = { channel: string; state: "held" | "free"; holder_id?: string; holder_handle?: string };
const floorListeners = new Set<(f: FloorFrame) => void>();
export const floorBus = {
  on(fn: (f: FloorFrame) => void) { floorListeners.add(fn); return () => floorListeners.delete(fn); },
  emit(f: FloorFrame) { floorListeners.forEach((fn) => { try { fn(f); } catch {} }); },
};

// ----- Thread lifecycle (delete fan-out) -----
// When any participant deletes a private conversation, the backend fans out a
// `thread_deleted` frame to every participant so each inbox drops it live.
type ThreadEvent = { type: "deleted"; id: string };
const threadListeners = new Set<(e: ThreadEvent) => void>();
export const threadBus = {
  on(fn: (e: ThreadEvent) => void) { threadListeners.add(fn); return () => threadListeners.delete(fn); },
  emit(e: ThreadEvent) { threadListeners.forEach((fn) => { try { fn(e); } catch {} }); },
};

let activeWs: WebSocket | null = null;
const floorState: Record<string, { holder_id: string; holder_handle: string; ts: number }> = {};

function wsSend(obj: any): boolean {
  try {
    if (activeWs && activeWs.readyState === 1) { activeWs.send(JSON.stringify(obj)); return true; }
  } catch {}
  return false;
}

export function acquireFloor(channel: string) { if (channel) wsSend({ type: "floor_acquire", channel }); }
export function releaseFloor(channel: string) { if (channel) wsSend({ type: "floor_release", channel }); }

// Current holder of a channel's floor, or null. Client-side TTL mirrors the
// server's so a missed "free" frame can never lock the mic forever.
export function getFloorHolder(channel: string): { id: string; handle: string } | null {
  const f = floorState[channel];
  if (!f) return null;
  if (Date.now() - f.ts > 65000) { delete floorState[channel]; return null; }
  return { id: f.holder_id, handle: f.holder_handle };
}

// Module-scoped playback queue + lock so a second mount doesn't double-play
// (defensive — we only mount once in the layout, but hot reload happens).
const queue: PTTMessage[] = [];
let playing = false;
let activeSound: Audio.Sound | null = null;

// Dedup guard shared by BOTH delivery transports (the WebSocket below AND the
// polling fallback). First transport to see a given clip id wins; the other
// skips it, so a clip delivered by both never plays or emits twice.
const handledIds = new Set<string>();

async function playOne(m: PTTMessage) {
  try {
    // Unload anything still hanging around from a prior clip.
    if (activeSound) {
      try { await activeSound.unloadAsync(); } catch {}
      activeSound = null;
    }
    // Force playback audio category (loudspeaker / Bluetooth, NOT earpiece).
    // Important even if we already set it at boot — recording may have flipped
    // us back into .playAndRecord which mutes incoming clips to earpiece-only.
    await setPlaybackAudioMode();

    // Background notification — fire a local notification ONLY when the app
    // is backgrounded so the driver knows someone is transmitting even when
    // the screen is off / they're on another app. Foreground users see the
    // talk-screen UI directly so no notification needed.
    if (AppState.currentState !== "active") {
      showTransmitNotification(m.handle || "Driver").catch(() => {});
    }

    let uri: string;
    if (Platform.OS === "web") {
      uri = `data:audio/mp4;base64,${m.audio_b64}`;
    } else {
      const dir = FileSystem.cacheDirectory + "convoy-ptt/";
      try { await FileSystem.makeDirectoryAsync(dir, { intermediates: true }); } catch {}
      const path = `${dir}${m.id}.m4a`;
      const info = await FileSystem.getInfoAsync(path);
      if (!info.exists) {
        await FileSystem.writeAsStringAsync(path, m.audio_b64, { encoding: FileSystem.EncodingType.Base64 });
      }
      uri = path;
    }
    const { sound } = await Audio.Sound.createAsync(
      { uri },
      // volume: 1.0 = max. Without this, expo-av defaults to ~0.5 which
      // sounded like "the earpiece is half-busted" on real devices.
      { shouldPlay: true, volume: 1.0 },
      (status: any) => {
        if (status?.didJustFinish) {
          sound.unloadAsync().catch(() => {});
          activeSound = null;
          playing = false;
          drain();
        }
      }
    );
    // Defensive — set volume after load too in case the constructor ignored it
    // on a particular platform (web Safari has been seen to clamp this).
    try { await sound.setVolumeAsync(1.0); } catch {}
    activeSound = sound;
  } catch {
    // Swallow playback errors so a single bad clip doesn't permanently jam the
    // queue for the rest of the drive.
    playing = false;
    drain();
  }
}

function drain() {
  if (playing) return;
  const next = queue.shift();
  if (!next) return;
  playing = true;
  playOne(next);
}

export function enqueueLivePtt(m: PTTMessage) {
  queue.push(m);
  drain();
}

/**
 * Mount this once at the (app) layout level. It will:
 *   1. Open a WS to /api/ws (reconnect with backoff on drop).
 *   2. Listen for `{type: "ptt", message: {...}}` events.
 *   3. For messages on `getActiveChannelId()`, auto-play + emit on the bus.
 *
 * `getActiveChannelId` is a getter (not a value) so the listener always reads
 * the latest selection without needing to reopen the socket on every change.
 */
export function useLiveWalkieListener(
  getActiveChannelId: () => string | null | undefined,
  getSelfId?: () => string | null | undefined,
) {
  // Stash the getters in refs so the WS handler always sees the latest.
  const getterRef = useRef(getActiveChannelId);
  useEffect(() => { getterRef.current = getActiveChannelId; }, [getActiveChannelId]);
  const selfRef = useRef(getSelfId);
  useEffect(() => { selfRef.current = getSelfId; }, [getSelfId]);

  useEffect(() => {
    let alive = true;
    let backoff = 1000;
    let timer: any = null;
    let ws: WebSocket | null = null;

    // One-time audio session prep — needed on iOS so playback works while
    // ringer is muted (drivers' phones are usually on silent in a mount).
    //
    // CRITICAL: `setIdleAudioMode()` flips `allowsRecordingIOS: false` which
    // forces the iOS audio category to `.playback` instead of `.playAndRecord`.
    // Without this, incoming PTT clips come out of the tiny earpiece speaker
    // at ~10% volume. This was the "Comms volume too low" bug.
    // Same call also enables full loudspeaker + Bluetooth A2DP routing on
    // Android via `playThroughEarpieceAndroid: false`.
    setIdleAudioMode();

    const connect = async () => {
      if (!alive) return;
      const token = await getToken();
      if (!token) {
        timer = setTimeout(connect, 2000);
        return;
      }
      try {
        ws = new WebSocket(wsUrl(token));
      } catch {
        timer = setTimeout(connect, backoff);
        backoff = Math.min(backoff * 2, 30000);
        return;
      }

      ws.onopen = () => { backoff = 1000; activeWs = ws; };
      ws.onmessage = (ev: any) => {
        try {
          const data = JSON.parse(typeof ev.data === "string" ? ev.data : "");

          // ===== Hail frame (peer summon) =====
          // Backend's `_send_hail_via_ws` fan-out — always honored regardless
          // of channel scope since hails are 1:1 directed. We just re-emit
          // onto `hailBus` so the foregrounded map can toast it. (When the
          // app is BACKGROUNDED, the user instead sees a real OS push from
          // the Emergent push relay — both paths share the same toast UI.)
          if (data?.type === "hail") {
            hailBus.emit({
              fromHandle: String(data.from_handle || "Driver"),
              fromId: String(data.from_id || ""),
            });
            return;
          }

          // ===== Share frame (a member sent you a song / route / clip) =====
          // 1:1 directed like hails, so honored regardless of channel scope.
          // Re-emit onto shareBus for the global <ShareToast> to render.
          if (data?.type === "share") {
            shareBus.emit({
              kind: (data.kind as any) || "music",
              fromHandle: String(data.from_handle || "Driver"),
              fromId: String(data.from_id || ""),
              payload: data.payload || {},
            });
            return;
          }

          // ===== Thread deleted (a participant removed the conversation) =====
          // 1:1/group directed like hails — honored regardless of the active
          // channel so the Comms inbox drops it even while viewing another.
          if (data?.type === "thread_deleted" && data?.id) {
            threadBus.emit({ type: "deleted", id: String(data.id) });
            return;
          }

          // ===== Floor control frame (who holds the mic) =====
          if (data?.type === "floor" && data?.channel) {
            const f: FloorFrame = {
              channel: String(data.channel),
              state: data.state === "free" ? "free" : "held",
              holder_id: data.holder_id ? String(data.holder_id) : undefined,
              holder_handle: data.holder_handle ? String(data.holder_handle) : undefined,
            };
            if (f.state === "held" && f.holder_id) {
              floorState[f.channel] = { holder_id: f.holder_id, holder_handle: f.holder_handle || "Driver", ts: Date.now() };
            } else {
              delete floorState[f.channel];
            }
            floorBus.emit(f);
            return;
          }

          if (data?.type !== "ptt" || !data?.message) return;
          const m: PTTMessage = data.message;
          // Dedup across WS + poll fallback — first transport to see this id wins.
          if (m?.id) { if (handledIds.has(m.id)) return; handledIds.add(m.id); }
          const ch = getterRef.current?.();
          // Always emit on the bus so screens that listen for the history list
          // still update. Audio playback is gated by the Comms Live privacy
          // toggle — when off the user wants total radio silence.
          livePttBus.emit(m);
          // Don't auto-play our OWN transmission back to us (the backend echoes
          // every clip to all channel members, including the sender). The clip
          // still lands in the history list via the bus above, so the sender
          // can replay it on demand — they just won't hear themselves live.
          const selfId = selfRef.current?.();
          if (selfId && m.user_id === selfId) return;
          const commsLive = getSettings().commsLive !== false;
          if (commsLive && m.channel === ch) {
            enqueueLivePtt(m);
          }
        } catch {}
      };
      ws.onerror = () => {};
      ws.onclose = () => {
        if (!alive) return;
        ws = null;
        timer = setTimeout(connect, backoff);
        backoff = Math.min(backoff * 2, 30000);
      };
    };
    connect();

    // ---- Polling fallback (belt-and-suspenders) ----
    // The WS above is the primary, low-latency transport. But on flaky mobile
    // networks, app backgrounding, or Render free-tier socket idling, frames
    // get dropped and a transmission is "sent but never received". So we ALSO
    // poll GET /api/ptt/{channel} every 5s and deliver anything the socket
    // missed (deduped via handledIds so nothing double-plays). Mirrors the
    // hazards screen's Realtime-plus-poll defense. The FIRST poll for a given
    // channel only SEEDS the seen-set (so we never replay the stored backlog);
    // after that, genuinely new + recent clips are auto-played.
    let pollTimer: any = null;
    let seededChannel: string | null | undefined = null;
    const poll = async () => {
      try {
        const ch = getterRef.current?.();
        // Only poll while foregrounded: iOS suspends background JS timers anyway,
        // and we don't want to burn cellular re-downloading the clip list while
        // the phone's in a pocket. Background reception leans on the WS (kept
        // alive by the background-audio mode) plus push notifications.
        if (ch && AppState.currentState === "active") {
          const { data } = await api.get(`/ptt/${ch}`);
          if (Array.isArray(data)) {
            const isSeedPass = seededChannel !== ch;
            // Oldest first so playback order matches the order things were said.
            const sorted = [...data].sort(
              (a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime()
            );
            for (const m of sorted) {
              if (!m || !m.id || handledIds.has(m.id)) continue;
              handledIds.add(m.id);
              livePttBus.emit(m);                              // history updates everywhere
              if (isSeedPass) continue;                        // don't replay backlog on first sight
              const selfId = selfRef.current?.();
              if (selfId && m.user_id === selfId) continue;    // never play our own clip
              const createdMs = new Date(m.created_at).getTime();
              const recent = Number.isFinite(createdMs) ? (Date.now() - createdMs < 30000) : false;
              if (recent && getSettings().commsLive !== false && m.channel === ch) {
                enqueueLivePtt(m);
              }
            }
            seededChannel = ch;
          }
        }
      } catch { /* offline / transient — retry next tick */ }
      if (alive) pollTimer = setTimeout(poll, 6000);
    };
    poll();

    return () => {
      alive = false;
      if (timer) clearTimeout(timer);
      if (pollTimer) clearTimeout(pollTimer);
      try { ws?.close(); } catch {}
      ws = null;
      activeWs = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
}
