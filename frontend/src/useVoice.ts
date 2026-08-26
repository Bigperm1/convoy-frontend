import React, { useEffect, useRef, useState, useCallback } from "react";
import { Audio } from "expo-av";
import * as Haptics from "expo-haptics";
import * as SecureStore from "expo-secure-store";
import { Alert, Platform, Vibration } from "react-native";
import * as Location from "expo-location";
import { api, formatErr } from "./api";
import { voiceBus } from "./voiceBus";
import { getPttRecordingOptions, type ProximityTier } from "./proximityAudio";
import { setIdleAudioMode, setRecordingAudioMode } from "./audioMode";
import { acquireMic, type MicLease } from "./micArbiter";
import { announce } from "./nav";
import { setListeningGlow } from "./components/ListeningEdgeGlow";

export type VoiceResult = { text: string; intent: string | null; query?: string };

// Hard cap on a single Nova utterance. Deliberately BELOW the 30s mic lease so the
// recording ends through the normal stop() path — writing the file, flipping the
// session back, dissolving the glow — rather than being cut by the lease deadline,
// which frees the mic but knows nothing about the Recording still running on it.
const MAX_UTTERANCE_MS = 25000;

// Optional `tier` arg lets callers (PTT screen, search-bar mic) pick a
// recording quality that scales with how close the convoy is. Default 'far'
// preserves the lightweight 32k mono behavior for non-comms voice (e.g. the
// search-bar transcription FAB, where bitrate is moot — only voice clarity
// matters and Whisper handles low-bitrate input fine).
export function useVoice(tier: ProximityTier = "far") {
  const recRef = useRef<Audio.Recording | null>(null);
  const leaseRef = useRef<MicLease | null>(null);
  // Latest stop(), callable from the cap timer without a forward-ref cycle.
  const stopRef = useRef<null | (() => Promise<string | null>)>(null);
  const maxTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [recording, setRecording] = useState(false);
  const [busy, setBusy] = useState(false);

  const ensurePerm = useCallback(async (): Promise<"granted" | "prompted" | "denied"> => {
    const perm = await Audio.getPermissionsAsync();
    if (perm.status === "granted") {
      // Was a DIRECT setAudioModeAsync, which bypassed audioMode entirely — so its
      // _desiredMode still read "idle" while this mic was hot, and every other path
      // believed nothing was recording. Route it through the module like the other three.
      await setRecordingAudioMode();
      return "granted";
    }
    if (perm.canAskAgain) {
      try { await Audio.requestPermissionsAsync(); } catch {}
      return "prompted";
    }
    Alert.alert("Microphone permission required");
    return "denied";
  }, []);

  const start = useCallback(async () => {
    if (recording || recRef.current) return;
    // A start() already in flight holds the lease; a second acquireMic would be denied
    // and the assignment below would overwrite the live lease with null, orphaning it.
    if (leaseRef.current?.active) return;
    // Acquire BEFORE ensurePerm: its granted branch applies setRecordingAudioMode(),
    // and a denial after that flip would have mutated the real owner's session with
    // nothing to restore it. (carComms.ts is the reference ordering.)
    leaseRef.current = acquireMic("voice", 30000);
    if (!leaseRef.current) return;
    const dropLease = () => { leaseRef.current?.release(); leaseRef.current = null; };
    const perm = await ensurePerm();
    // Don't start a recording in the same gesture that showed the OS prompt —
    // doing so while the iOS audio session is re-activating crashes the app.
    // Permission is granted now, so the next press records normally. Only the
    // granted branch flips the session, so there is nothing to restore here.
    if (perm !== "granted") { dropLease(); return; }
    try {
      const rec = new Audio.Recording();
      // Adaptive quality based on convoy proximity tier (see proximityAudio.ts).
      await rec.prepareToRecordAsync(getPttRecordingOptions(tier));
      await rec.startAsync();
      recRef.current = rec;
      setRecording(true);
      // Belt-and-suspenders cap — a tap-and-forget (the CarPlay mic button in
      // particular, which has no key-up) can otherwise leave a native Recording
      // running forever once its lease has quietly expired.
      if (maxTimerRef.current) clearTimeout(maxTimerRef.current);
      maxTimerRef.current = setTimeout(() => { void stopRef.current?.(); }, MAX_UTTERANCE_MS);
      // Siri-style green edge glow while Scout listens (GlobalListeningGlow in
      // the (app) layout). Flipped here — not per-caller — so the Comms
      // hold-to-talk AND the CarPlay mic button both light the phone edges.
      setListeningGlow("listening");
      // Tactile confirmation that the mic is live. Lives in the hook so every
      // Gemini voice button (tab-bar mic + search-bar mic) gets it for free.
      // iOS gets the Taptic engine; Android's impactAsync is faint and often
      // gated by system settings, so we ALSO fire a short Vibration there so
      // the press is unmistakable.
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Heavy).catch(() => {});
      if (Platform.OS === "android") { try { Vibration.vibrate(35); } catch {} }
    } catch (e) {
      console.warn("record start", e);
      // Release BEFORE the idle flip — a held lease would DEFER it, re-creating
      // the mono-HFP/quiet-routing bug this flip exists to prevent.
      dropLease();
      // ensurePerm already flipped the iOS session into .playAndRecord, but the
      // recording never actually started — flip it back so a failed start can't
      // leave Bluetooth stuck on mono HFP / quiet earpiece routing.
      void setIdleAudioMode();
      setListeningGlow("off");
    }
  }, [recording, ensurePerm, tier]);

  const stop = useCallback(async (): Promise<string | null> => {
    if (maxTimerRef.current) { clearTimeout(maxTimerRef.current); maxTimerRef.current = null; }
    const rec = recRef.current;
    try {
      if (!rec) return null;
      try {
        await rec.stopAndUnloadAsync();
        const uri = rec.getURI();
        recRef.current = null;
        setRecording(false);
        return uri;
      } catch (e) {
        console.warn("record stop", e);
        setRecording(false);
        return null;
      }
    } finally {
      // CRITICAL: the Nova voice mic flipped the iOS session into .playAndRecord
      // (ensurePerm, allowsRecordingIOS:true). That category collapses the car's
      // Bluetooth to mono hands-free (HFP) at low volume for the WHOLE phone —
      // music included. Flip back to .playback the instant the mic stops, exactly
      // like the PTT key-up path does (setIdleAudioMode → allowsRecordingIOS:false).
      // In `finally` so it runs on success, stop-error, or early no-recording — a
      // downstream transcription error can never leave the session stuck.
      //
      // Release the mic AFTER stopAndUnloadAsync above — releasing first left a window
      // where the mic was natively hot with no lease guarding it, so a ding could flip
      // the category out from under it — and BEFORE this flip, or the flip defers
      // against our own lease and the music stays ducked.
      leaseRef.current?.release(); leaseRef.current = null;
      void setIdleAudioMode();
      // Same guarantee for the edge glow — key-up always dissolves it.
      setListeningGlow("off");
    }
  }, []);

  const transcribe = useCallback(async (uri: string): Promise<VoiceResult | null> => {
    try {
      setBusy(true);
      // Amber "thinking" edge glow while the clip uploads + the agent works.
      setListeningGlow("thinking");
      const res = await fetch(uri);
      const blob = await res.blob();
      const b64: string = await new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onloadend = () => {
          const r = (reader.result as string) || "";
          resolve(r.split(",")[1] || "");
        };
        reader.onerror = reject;
        reader.readAsDataURL(blob);
      });
      // ----- Agentic Scout first: /voice/agent lets Claude chain lookups
      // (convoy status, hazards) and queue multiple actions, replying with
      // spoken text. Falls back to the legacy /voice/transcribe classifier on
      // ANY failure (including 404 from a backend that predates the agent), so
      // the mic can never regress.
      let lat: number | undefined, lng: number | undefined;
      try {
        // Last-known fix is instant and never prompts (permission was granted
        // when the map started). Best-effort — tools degrade without it.
        const p = await Location.getLastKnownPositionAsync();
        if (p) { lat = p.coords.latitude; lng = p.coords.longitude; }
      } catch {}
      try {
        const { data } = await api.post("/voice/agent", { audio_b64: b64, mime: "audio/m4a", lat, lng });
        const actions: { intent: string | null; query?: string }[] = Array.isArray(data?.actions) ? data.actions : [];
        if (data?.speech) announce(String(data.speech));
        if (actions.length > 0) {
          // Execute via the existing voiceBus handlers. When Scout already
          // SPOKE a reply, emit with empty text so map.tsx's in-drive Q&A
          // regexes can't double-answer the same utterance; when silent, let
          // the first action carry the transcript for the VoiceController banner.
          actions.forEach((a, i) =>
            voiceBus.emit({ text: data?.speech ? "" : (i === 0 ? data?.text || "" : ""), intent: a.intent ?? null, query: a.query, ts: Date.now() }),
          );
        } else if (!data?.speech) {
          // Nothing actionable and nothing spoken — legacy banner behavior.
          voiceBus.emit({ text: data?.text || "", intent: null, ts: Date.now() });
        }
        Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => {});
        return { text: data?.text || "", intent: actions[0]?.intent ?? null, query: actions[0]?.query };
      } catch {
        // fall through to the legacy classifier below
      }
      const { data } = await api.post("/voice/transcribe", { audio_b64: b64, mime: "audio/m4a" });
      const result = data as VoiceResult;
      // Broadcast to any subscribed screens
      voiceBus.emit({ text: result.text || "", intent: result.intent ?? null, query: result.query, ts: Date.now() });
      // Success buzz when the command comes back understood.
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => {});
      return result;
    } catch (e) {
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning).catch(() => {});
      Alert.alert("Voice", formatErr(e));
      return null;
    } finally {
      setBusy(false);
      // Always dissolve the amber "thinking" glow, success or failure.
      setListeningGlow("off");
    }
  }, []);

  // Keep the ref pointing at the latest stop() for the cap timer.
  stopRef.current = stop;

  // Unmount mid-utterance (navigating off the screen, a CarPlay template teardown)
  // must not leave a hot mic or a held lease behind: without this the arbiter refuses
  // every other recorder until the lease's own deadline, and every setIdleAudioMode()
  // defers against an owner that no longer exists. pttChannel has had this cleanup
  // for the Recording; the lease needs the same guarantee.
  useEffect(() => () => {
    if (maxTimerRef.current) clearTimeout(maxTimerRef.current);
    const rec = recRef.current;
    recRef.current = null;
    if (rec) { rec.stopAndUnloadAsync().catch(() => {}); }
    const hadLease = !!leaseRef.current;
    leaseRef.current?.release(); leaseRef.current = null;
    if (rec || hadLease) { void setIdleAudioMode(); setListeningGlow("off"); }
  }, []);

  return { recording, busy, start, stop, transcribe };
}
