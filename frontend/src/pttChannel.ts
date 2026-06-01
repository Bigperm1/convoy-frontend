// PTT channel hook — record + send a push-to-talk transmission to a community
// channel, and keep a live history list for that channel.
//
// SEND:    start() begins recording at a proximity-aware quality (close = HD,
//          far = walkie-grade). stopAndSend() stops, reads the clip as base64,
//          and POSTs to /api/ptt { channel, audio_b64, duration_ms }. The
//          backend fans it out over the WebSocket to every channel member —
//          the global useLiveWalkieListener (mounted in the app layout) plays
//          incoming clips and emits them on livePttBus.
//
// HISTORY: on mount (and when the channel changes) we GET /api/ptt/{channel}
//          for the recent backlog, then subscribe to livePttBus so live
//          transmissions (ours + crew) prepend to the list in real time.
//
// The channel id IS the active community id — that's what the listener matches
// against (see livePtt.ts: `m.channel === ch`).

import { useEffect, useRef, useState, useCallback } from "react";
import { Audio } from "expo-av";
import { api } from "./api";
import { getPttRecordingOptions, type ProximityTier } from "./proximityAudio";
import { livePttBus, type PTTMessage } from "./livePtt";

export type { PTTMessage };

async function uriToBase64(uri: string): Promise<string> {
  // Web: fetch + FileReader. Native: expo-file-system reads base64 directly,
  // but fetch()+FileReader also works for file:// URIs on RN and keeps this
  // single-path. Mirrors the proven approach in useVoice.ts.
  const res = await fetch(uri);
  const blob = await res.blob();
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onloadend = () => {
      const r = (reader.result as string) || "";
      resolve(r.split(",")[1] || "");
    };
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });
}

export function usePttChannel(channel: string | null | undefined, tier: ProximityTier = "far") {
  const recRef = useRef<Audio.Recording | null>(null);
  const startedAtRef = useRef<number>(0);
  const [recording, setRecording] = useState(false);
  const [sending, setSending] = useState(false);
  const [history, setHistory] = useState<PTTMessage[]>([]);

  // ----- History: initial backlog for the active channel -----
  useEffect(() => {
    if (!channel) { setHistory([]); return; }
    let cancelled = false;
    (async () => {
      try {
        const { data } = await api.get(`/ptt/${channel}`);
        if (!cancelled && Array.isArray(data)) {
          // Newest first for the list.
          const sorted = [...data].sort(
            (a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime()
          );
          setHistory(sorted);
        }
      } catch { /* keep empty; live bus will still populate */ }
    })();
    return () => { cancelled = true; };
  }, [channel]);

  // ----- History: live merge from the global PTT bus -----
  // The app-level listener (useLiveWalkieListener) emits EVERY incoming ptt on
  // livePttBus regardless of channel, so we filter to the active channel here.
  useEffect(() => {
    if (!channel) return;
    const off = livePttBus.on((m) => {
      if (m.channel !== channel) return;
      setHistory((cur) => (cur.some((x) => x.id === m.id) ? cur : [m, ...cur]));
    });
    // Wrap so the cleanup returns void (livePttBus.on's unsubscribe returns the
    // Set.delete boolean, which doesn't satisfy React's EffectCallback type).
    return () => { off(); };
  }, [channel]);

  const ensurePerm = useCallback(async () => {
    const { status } = await Audio.requestPermissionsAsync();
    if (status !== "granted") return false;
    await Audio.setAudioModeAsync({ allowsRecordingIOS: true, playsInSilentModeIOS: true });
    return true;
  }, []);

  const start = useCallback(async () => {
    if (recording || !channel) return;
    if (!(await ensurePerm())) return;
    try {
      const rec = new Audio.Recording();
      await rec.prepareToRecordAsync(getPttRecordingOptions(tier));
      await rec.startAsync();
      recRef.current = rec;
      startedAtRef.current = Date.now();
      setRecording(true);
    } catch {
      recRef.current = null;
      setRecording(false);
    }
  }, [recording, channel, ensurePerm, tier]);

  // Stop recording and broadcast to the channel. Returns true on a sent clip.
  const stopAndSend = useCallback(async (): Promise<boolean> => {
    const rec = recRef.current;
    recRef.current = null;
    if (!rec) { setRecording(false); return false; }
    let uri: string | null = null;
    let durationMs = Date.now() - startedAtRef.current;
    try {
      // Read duration from the live recording BEFORE unloading (status on an
      // unloaded recording is unreliable on expo-av). Fall back to wall-clock.
      try {
        const status: any = await rec.getStatusAsync();
        if (status?.durationMillis) durationMs = status.durationMillis;
      } catch {}
      await rec.stopAndUnloadAsync();
      uri = rec.getURI();
    } catch {
      uri = rec.getURI?.() ?? null;
    } finally {
      setRecording(false);
    }
    if (!uri) return false;
    // Ignore accidental sub-300ms taps — nothing meaningful was said.
    if (durationMs < 300) return false;
    if (!channel) return false;
    try {
      setSending(true);
      const audio_b64 = await uriToBase64(uri);
      if (!audio_b64) return false;
      await api.post("/ptt", { channel, audio_b64, duration_ms: Math.round(durationMs) });
      // The backend echoes our own clip back over the WS to channel members,
      // which the live bus appends to history — so we don't optimistically add
      // it here (avoids a duplicate when the echo arrives).
      return true;
    } catch {
      return false;
    } finally {
      setSending(false);
    }
  }, [channel]);

  // Abandon an in-progress recording without sending (e.g. user has no active
  // channel, or a cancel gesture). Safe to call even if not recording.
  const cancel = useCallback(async () => {
    const rec = recRef.current;
    recRef.current = null;
    setRecording(false);
    if (!rec) return;
    try { await rec.stopAndUnloadAsync(); } catch {}
  }, []);

  return { recording, sending, history, start, stopAndSend, cancel };
}
