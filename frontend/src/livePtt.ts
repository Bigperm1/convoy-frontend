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
import { getToken, wsUrl } from "./api";
import { getSettings } from "./settings";

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

// Module-scoped playback queue + lock so a second mount doesn't double-play
// (defensive — we only mount once in the layout, but hot reload happens).
const queue: PTTMessage[] = [];
let playing = false;
let activeSound: Audio.Sound | null = null;

async function playOne(m: PTTMessage) {
  try {
    // Unload anything still hanging around from a prior clip.
    if (activeSound) {
      try { await activeSound.unloadAsync(); } catch {}
      activeSound = null;
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
      { shouldPlay: true },
      (status: any) => {
        if (status?.didJustFinish) {
          sound.unloadAsync().catch(() => {});
          activeSound = null;
          playing = false;
          drain();
        }
      }
    );
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
export function useLiveWalkieListener(getActiveChannelId: () => string | null | undefined) {
  // Stash the getter in a ref so the WS handler always sees the latest.
  const getterRef = useRef(getActiveChannelId);
  useEffect(() => { getterRef.current = getActiveChannelId; }, [getActiveChannelId]);

  useEffect(() => {
    let alive = true;
    let backoff = 1000;
    let timer: any = null;
    let ws: WebSocket | null = null;

    // One-time audio session prep — needed on iOS so playback works while
    // ringer is muted (drivers' phones are usually on silent in a mount).
    (async () => {
      try {
        await Audio.setAudioModeAsync({
          allowsRecordingIOS: true,
          playsInSilentModeIOS: true,
          shouldDuckAndroid: true,
          playThroughEarpieceAndroid: false,
        });
      } catch {}
    })();

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

      ws.onopen = () => { backoff = 1000; };
      ws.onmessage = (ev: any) => {
        try {
          const data = JSON.parse(typeof ev.data === "string" ? ev.data : "");
          if (data?.type !== "ptt" || !data?.message) return;
          const m: PTTMessage = data.message;
          const ch = getterRef.current?.();
          // Always emit on the bus so screens that listen for the history list
          // still update. Audio playback is gated by the Comms Live privacy
          // toggle — when off the user wants total radio silence.
          livePttBus.emit(m);
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
    return () => {
      alive = false;
      if (timer) clearTimeout(timer);
      try { ws?.close(); } catch {}
      ws = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
}
