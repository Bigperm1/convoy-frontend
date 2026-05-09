import React, { useEffect, useRef, useState, useCallback } from "react";
import { Audio } from "expo-av";
import * as SecureStore from "expo-secure-store";
import { Alert } from "react-native";
import { api, formatErr } from "./api";
import { voiceBus } from "./voiceBus";

export type VoiceResult = { text: string; intent: string | null; query?: string };

export function useVoice() {
  const recRef = useRef<Audio.Recording | null>(null);
  const [recording, setRecording] = useState(false);
  const [busy, setBusy] = useState(false);

  const ensurePerm = useCallback(async () => {
    const { status } = await Audio.requestPermissionsAsync();
    if (status !== "granted") {
      Alert.alert("Microphone permission required");
      return false;
    }
    await Audio.setAudioModeAsync({ allowsRecordingIOS: true, playsInSilentModeIOS: true });
    return true;
  }, []);

  const start = useCallback(async () => {
    if (recording) return;
    if (!(await ensurePerm())) return;
    try {
      const rec = new Audio.Recording();
      await rec.prepareToRecordAsync(Audio.RecordingOptionsPresets.HIGH_QUALITY);
      await rec.startAsync();
      recRef.current = rec;
      setRecording(true);
    } catch (e) {
      console.warn("record start", e);
    }
  }, [recording, ensurePerm]);

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
      return result;
    } catch (e) {
      Alert.alert("Voice", formatErr(e));
      return null;
    } finally {
      setBusy(false);
    }
  }, []);

  return { recording, busy, start, stop, transcribe };
}
