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
import { setRecordingAudioMode, setIdleAudioMode } from "./audioMode";

export type { PTTMessage };

// Transmissions auto-expire after 5 hours everywhere — the backend stops
// returning (and deletes) older clips, and the client filters too so a long
// continuous session never keeps stale audio in memory.
const FIVE_HOURS_MS = 5 * 60 * 60 * 1000;

// ----- Hands-free VOX (voice-activated transmit) tuning -----
// VOX_DB_THRESHOLD is in metering dBFS (0 = max, -160 = silence). Input above
// it counts as speech; after VOX_SILENCE_MS of continuous quiet a turn auto-
// ends. These may need tuning against real device mics / road noise.
const VOX_SILENCE_MS = 1000;
const VOX_DB_THRESHOLD = -40;
const VOX_POLL_MS = 250;

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
  // True while the user is holding the button. Lets the async start() detect a
  // release that arrived BEFORE recording actually began (runaway-mic fix).
  const wantRef = useRef(false);
  // Hard-cap timer so a single clip can never exceed 60s.
  const maxTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Latest stopAndSend, callable from the cap timer without a forward-ref cycle.
  const stopAndSendRef = useRef<null | (() => Promise<boolean>)>(null);
  const [recording, setRecording] = useState(false);
  const [sending, setSending] = useState(false);
  const [history, setHistory] = useState<PTTMessage[]>([]);

  // ----- Hands-free VOX state -----
  const voxTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const voxLastVoiceRef = useRef(0);
  const voxHeardRef = useRef(false);
  const voxClosingRef = useRef(false);
  const onVoxCloseRef = useRef<null | ((sent: boolean) => void)>(null);
  const [voxActive, setVoxActive] = useState(false);

  // ----- History: initial backlog for the active channel -----
  useEffect(() => {
    if (!channel) { setHistory([]); return; }
    let cancelled = false;
    (async () => {
      try {
        const { data } = await api.get(`/ptt/${channel}`);
        if (!cancelled && Array.isArray(data)) {
          // Drop anything older than 5h (auto-expire), then newest-first.
          const sorted = [...data]
            .filter((m) => {
              const t = new Date(m?.created_at).getTime();
              return Number.isFinite(t) ? (Date.now() - t < FIVE_HOURS_MS) : true;
            })
            .sort(
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
      setHistory((cur) => {
        if (cur.some((x) => x.id === m.id)) return cur;
        // Prepend the new clip and prune anything past the 5h expiry window.
        return [m, ...cur].filter((x) => {
          const t = new Date(x.created_at).getTime();
          return Number.isFinite(t) ? (Date.now() - t < FIVE_HOURS_MS) : true;
        });
      });
    });
    // Wrap so the cleanup returns void (livePttBus.on's unsubscribe returns the
    // Set.delete boolean, which doesn't satisfy React's EffectCallback type).
    return () => { off(); };
  }, [channel]);

  // Resolve mic permission WITHOUT crashing the audio session. On iOS, calling
  // requestPermissionsAsync() shows the system prompt, and starting a recording
  // in the SAME gesture the prompt resolves crashes the audio session (it's
  // still re-activating from the interruption). So: if already granted, set the
  // audio mode and report "granted" (safe to record now). If we must PROMPT,
  // report "prompted" and let the caller bail out of recording for this press;
  // the next press records cleanly once the session has settled.
  const ensurePerm = useCallback(async (): Promise<"granted" | "prompted" | "denied"> => {
    const perm = await Audio.getPermissionsAsync();
    if (perm.status === "granted") {
      // Full recording session config (ducks music rather than hard-stopping it).
      await setRecordingAudioMode();
      return "granted";
    }
    if (perm.canAskAgain) {
      try { await Audio.requestPermissionsAsync(); } catch {}
      return "prompted";
    }
    return "denied";
  }, []);

  const start = useCallback(async () => {
    if (!channel) return;
    // Mark intent immediately so a release that beats the async start sequence
    // is observed in the post-start check below.
    wantRef.current = true;
    if (recRef.current) return;            // already recording
    const perm = await ensurePerm();
    // If we just showed the OS mic prompt (or it's denied), do NOT start a
    // recording in this gesture — starting one while the iOS audio session is
    // re-activating right after the prompt crashes the app. Permission is now
    // granted, so the user's NEXT press records normally.
    if (perm !== "granted") { wantRef.current = false; return; }
    if (!wantRef.current) return;          // released during the permission check
    try {
      const rec = new Audio.Recording();
      await rec.prepareToRecordAsync(getPttRecordingOptions(tier));
      await rec.startAsync();
      // RUNAWAY-MIC FIX: if the user already released while we were preparing
      // (onPressOut -> stopAndSend ran while recRef.current was still null, so
      // it had nothing to stop), do NOT leave a hot mic running. Stop+discard
      // now. This was the cause of the 13-minute recording.
      if (!wantRef.current) {
        try { await rec.stopAndUnloadAsync(); } catch {}
        setRecording(false);
        return;
      }
      recRef.current = rec;
      startedAtRef.current = Date.now();
      setRecording(true);
      // Belt-and-suspenders: hard-cap a single transmission at 60s so a missed
      // release can never record indefinitely again.
      if (maxTimerRef.current) clearTimeout(maxTimerRef.current);
      maxTimerRef.current = setTimeout(() => { stopAndSendRef.current?.(); }, 60000);
    } catch {
      recRef.current = null;
      setRecording(false);
    }
  }, [channel, ensurePerm, tier]);

  // Stop recording and broadcast to the channel. Returns true on a sent clip.
  const stopAndSend = useCallback(async (): Promise<boolean> => {
    wantRef.current = false;
    if (maxTimerRef.current) { clearTimeout(maxTimerRef.current); maxTimerRef.current = null; }
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
      // Recording is done — drop the ducking session back to non-ducking idle so
      // external music (Spotify, podcasts) returns to full volume right away
      // instead of staying quiet until the next clip / app restart.
      void setIdleAudioMode();
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
    wantRef.current = false;
    if (maxTimerRef.current) { clearTimeout(maxTimerRef.current); maxTimerRef.current = null; }
    const rec = recRef.current;
    recRef.current = null;
    setRecording(false);
    if (!rec) return;
    try { await rec.stopAndUnloadAsync(); } catch {}
    // Cancelled recording — release the ducking session so external music
    // returns to full volume immediately.
    void setIdleAudioMode();
  }, []);

  // ===== Hands-free VOX (voice-activated transmit) =====
  // Used by private threads: open the mic with a single tap and talk
  // hands-free. A metering loop samples the input level; after VOX_SILENCE_MS
  // of continuous quiet it auto-sends the turn and closes (tap again for the
  // next turn). A turn with NO detected speech is discarded rather than sent.
  const finishVox = useCallback(async (): Promise<boolean> => {
    if (voxClosingRef.current) return false;     // guard against re-entry
    voxClosingRef.current = true;
    if (voxTimerRef.current) { clearInterval(voxTimerRef.current); voxTimerRef.current = null; }
    setVoxActive(false);
    let sent = false;
    try {
      if (voxHeardRef.current && recRef.current) sent = await stopAndSend();
      else await cancel();                       // discard a silent turn
    } finally {
      const cb = onVoxCloseRef.current;
      onVoxCloseRef.current = null;
      voxClosingRef.current = false;
      try { cb?.(sent); } catch {}
    }
    return sent;
  }, [stopAndSend, cancel]);

  const startVox = useCallback(async (onClose?: (sent: boolean) => void) => {
    if (!channel || voxActive || recRef.current) return;
    onVoxCloseRef.current = onClose ?? null;
    voxHeardRef.current = false;
    await start();   // reuse the proven start path (perm gate, runaway guard, 60s cap)
    if (!recRef.current) {                        // perm prompt / failed start — nothing opened
      const cb = onVoxCloseRef.current; onVoxCloseRef.current = null;
      try { cb?.(false); } catch {}
      return;
    }
    setVoxActive(true);
    voxLastVoiceRef.current = Date.now();          // full silence window to start talking
    voxTimerRef.current = setInterval(async () => {
      const rec = recRef.current;
      if (!rec) {
        // Recording stopped outside VOX (e.g. the 60s hard cap already sent it).
        if (voxTimerRef.current) { clearInterval(voxTimerRef.current); voxTimerRef.current = null; }
        setVoxActive(false);
        const cb = onVoxCloseRef.current; onVoxCloseRef.current = null;
        try { cb?.(true); } catch {}
        return;
      }
      try {
        const st: any = await rec.getStatusAsync();
        const level = typeof st?.metering === "number" ? st.metering : -160;
        if (level > VOX_DB_THRESHOLD) { voxLastVoiceRef.current = Date.now(); voxHeardRef.current = true; }
        else if (Date.now() - voxLastVoiceRef.current > VOX_SILENCE_MS) { await finishVox(); }
      } catch {}
    }, VOX_POLL_MS);
  }, [channel, voxActive, start, finishVox]);

  const stopVox = useCallback(() => finishVox(), [finishVox]);

  // Keep the ref pointing at the latest stopAndSend for the 60s cap timer.
  stopAndSendRef.current = stopAndSend;

  // Delete a transmission from this channel (author or community admin). Removes
  // it locally immediately for snappy UX, then tells the backend to delete it.
  const remove = useCallback(async (id: string) => {
    setHistory((cur) => cur.filter((x) => x.id !== id));
    try { await api.delete(`/ptt/${id}`); } catch {}
  }, []);

  // Clear timers + kill any hot mic if the hook unmounts mid-transmit (hold OR
  // VOX) so navigating away can never leave a runaway recording open.
  useEffect(() => () => {
    if (maxTimerRef.current) clearTimeout(maxTimerRef.current);
    if (voxTimerRef.current) clearInterval(voxTimerRef.current);
    const rec = recRef.current;
    recRef.current = null;
    if (rec) { rec.stopAndUnloadAsync().catch(() => {}); }
  }, []);

  return { recording, sending, history, start, stopAndSend, cancel, remove, voxActive, startVox, stopVox };
}
