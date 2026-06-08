import React, { useEffect, useRef, useState, useCallback } from "react";
import { Audio } from "expo-av";
import * as Haptics from "expo-haptics";
import * as SecureStore from "expo-secure-store";
import { Alert, Platform, Vibration } from "react-native";
import { api, formatErr } from "./api";
import { voiceBus } from "./voiceBus";
import { getPttRecordingOptions, type ProximityTier } from "./proximityAudio";

export type VoiceResult = { text: string; intent: string | null; query?: string };

// Optional `tier` arg lets callers (PTT screen, search-bar mic) pick a
// recording quality that scales with how close the convoy is. Default 'far'
// preserves the lightweight 32k mono behavior for non-comms voice (e.g. the
// search-bar transcription FAB, where bitrate is moot — only voice clarity
// matters and Whisper handles low-bitrate input fine).
export function useVoice(tier: ProximityTier = "far") {
  const recRef = useRef<Audio.Recording | null>(null);
  const [recording, setRecording] = useState(false);
  const [busy, setBusy] = useState(false);

  const ensurePerm = useCallback(async (): Promise<"granted" | "prompted" | "denied"> => {
    const perm = await Audio.getPermissionsAsync();
    if (perm.status === "granted") {
      await Audio.setAudioModeAsync({ allowsRecordingIOS: true, playsInSilentModeIOS: true });
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
    if (recording) return;
    const perm = await ensurePerm();
    // Don't start a recording in the same gesture that showed the OS prompt —
    // doing so while the iOS audio session is re-activating crashes the app.
    // Permission is granted now, so the next press records normally.
    if (perm !== "granted") return;
    try {
      const rec = new Audio.Recording();
      // Adaptive quality based on convoy proximity tier (see proximityAudio.ts).
      await rec.prepareToRecordAsync(getPttRecordingOptions(tier));
      await rec.startAsync();
      recRef.current = rec;
      setRecording(true);
      // Tactile confirmation that the mic is live. Lives in the hook so every
      // Gemini voice button (tab-bar mic + search-bar mic) gets it for free.
      // iOS gets the Taptic engine; Android's impactAsync is faint and often
      // gated by system settings, so we ALSO fire a short Vibration there so
      // the press is unmistakable.
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Heavy).catch(() => {});
      if (Platform.OS === "android") { try { Vibration.vibrate(35); } catch {} }
    } catch (e) {
      console.warn("record start", e);
    }
  }, [recording, ensurePerm, tier]);

  const stop = useCallback(async (): Promise<string | null> => {
    const rec = recRef.current;
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
  }, []);

  const transcribe = useCallback(async (uri: string): Promise<VoiceResult | null> => {
    try {
      setBusy(true);
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
    }
  }, []);

  return { recording, busy, start, stop, transcribe };
}
