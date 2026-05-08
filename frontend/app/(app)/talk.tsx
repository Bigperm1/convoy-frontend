import React, { useEffect, useRef, useState } from "react";
import { View, Text, StyleSheet, TouchableOpacity, Pressable, ScrollView, Animated, Easing, Alert } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { SafeAreaView } from "react-native-safe-area-context";
import { Audio } from "expo-av";
import { LinearGradient } from "expo-linear-gradient";
import { COLORS } from "../../src/theme";
import { api, formatErr } from "../../src/api";
import Glass from "../../src/Glass";

type Channel = { id: string; name: string; desc: string };
type PTT = { id: string; channel: string; user_id: string; handle: string; audio_b64: string; duration_ms: number; created_at: string };

export default function TalkScreen() {
  const [channels, setChannels] = useState<Channel[]>([]);
  const [active, setActive] = useState<string>("general");
  const [recording, setRecording] = useState(false);
  const [busy, setBusy] = useState(false);
  const [history, setHistory] = useState<PTT[]>([]);
  const recRef = useRef<Audio.Recording | null>(null);
  const soundRef = useRef<Audio.Sound | null>(null);
  const pulse = useRef(new Animated.Value(1)).current;

  useEffect(() => {
    (async () => {
      try { const { data } = await api.get("/channels"); setChannels(data); } catch {}
      try {
        await Audio.requestPermissionsAsync();
        await Audio.setAudioModeAsync({ allowsRecordingIOS: true, playsInSilentModeIOS: true });
      } catch {}
    })();
  }, []);

  useEffect(() => { loadHistory(); }, [active]);

  useEffect(() => {
    if (recording) {
      Animated.loop(Animated.sequence([
        Animated.timing(pulse, { toValue: 1.1, duration: 600, useNativeDriver: true, easing: Easing.inOut(Easing.ease) }),
        Animated.timing(pulse, { toValue: 1, duration: 600, useNativeDriver: true, easing: Easing.inOut(Easing.ease) }),
      ])).start();
    } else {
      pulse.stopAnimation();
      pulse.setValue(1);
    }
  }, [recording]);

  const loadHistory = async () => {
    try { const { data } = await api.get(`/ptt/${active}`); setHistory(data); } catch {}
  };

  const startRec = async () => {
    if (recording || busy) return;
    try {
      const rec = new Audio.Recording();
      await rec.prepareToRecordAsync(Audio.RecordingOptionsPresets.HIGH_QUALITY);
      await rec.startAsync();
      recRef.current = rec;
      setRecording(true);
    } catch (e) { Alert.alert("Mic error", String(e)); }
  };

  const stopRec = async () => {
    const rec = recRef.current;
    if (!rec) return;
    setRecording(false);
    setBusy(true);
    try {
      await rec.stopAndUnloadAsync();
      const status = await rec.getStatusAsync();
      const uri = rec.getURI();
      recRef.current = null;
      if (!uri) return;
      const res = await fetch(uri);
      const blob = await res.blob();
      const b64: string = await new Promise((resolve, reject) => {
        const r = new FileReader();
        r.onloadend = () => resolve(((r.result as string) || "").split(",")[1] || "");
        r.onerror = reject;
        r.readAsDataURL(blob);
      });
      await api.post("/ptt", { channel: active, audio_b64: b64, duration_ms: (status as any)?.durationMillis || 0 });
      await loadHistory();
    } catch (e) { Alert.alert("Send failed", formatErr(e)); }
    finally { setBusy(false); }
  };

  const playMessage = async (m: PTT) => {
    try {
      if (soundRef.current) { await soundRef.current.unloadAsync(); soundRef.current = null; }
      const { sound } = await Audio.Sound.createAsync({ uri: `data:audio/m4a;base64,${m.audio_b64}` }, { shouldPlay: true });
      soundRef.current = sound;
    } catch (e) { Alert.alert("Playback failed", String(e)); }
  };

  return (
    <SafeAreaView style={styles.c} edges={["top"]}>
      <View style={styles.header}>
        <Text style={styles.title}>Talk</Text>
        <Text style={styles.sub}>Push-to-talk · {channels.find((c) => c.id === active)?.name}</Text>
      </View>

      <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.chRow}>
        {channels.map((c) => (
          <TouchableOpacity key={c.id} testID={`channel-${c.id}`} onPress={() => setActive(c.id)} style={[styles.chip, active === c.id && styles.chipActive]}>
            <Text style={[styles.chipText, active === c.id && styles.chipTextActive]}>{c.name}</Text>
          </TouchableOpacity>
        ))}
      </ScrollView>

      <View style={styles.center}>
        <Animated.View style={{ transform: [{ scale: pulse }] }}>
          <Pressable testID="ptt-button" onPressIn={startRec} onPressOut={stopRec} style={[styles.ptt, recording && styles.pttActive]}>
            <LinearGradient
              colors={recording ? [COLORS.primary, COLORS.primaryDim] : ["rgba(118,118,128,0.24)", "rgba(118,118,128,0.12)"]}
              style={StyleSheet.absoluteFill}
            />
            <Ionicons name={recording ? "radio" : "mic"} size={64} color={recording ? "#fff" : COLORS.text} />
            <Text style={[styles.pttLabel, recording && { color: "#fff" }]}>{recording ? "Transmitting" : "Hold to talk"}</Text>
          </Pressable>
        </Animated.View>
        <Text style={styles.hint}>{busy ? "Sending…" : "Hold the button while speaking"}</Text>
      </View>

      <Text style={styles.histTitle}>Recent transmissions</Text>
      <ScrollView style={{ flex: 1 }} contentContainerStyle={{ paddingHorizontal: 18, paddingBottom: 100 }} testID="ptt-history">
        {history.length === 0 && <Text style={{ color: COLORS.textMute, fontSize: 13 }}>No transmissions yet on this channel.</Text>}
        {history.slice().reverse().map((m) => (
          <Glass key={m.id} radius={14} style={{ marginBottom: 8 }}>
            <TouchableOpacity testID={`play-${m.id}`} style={styles.msg} onPress={() => playMessage(m)}>
              <View style={styles.playIcon}><Ionicons name="play" size={16} color={COLORS.primary} /></View>
              <View style={{ flex: 1 }}>
                <Text style={styles.msgUser}>{m.handle || "driver"}</Text>
                <Text style={styles.msgMeta}>{Math.round((m.duration_ms || 0) / 1000)}s · {new Date(m.created_at).toLocaleTimeString()}</Text>
              </View>
            </TouchableOpacity>
          </Glass>
        ))}
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  c: { flex: 1, backgroundColor: COLORS.bg },
  header: { paddingHorizontal: 18, paddingTop: 8, paddingBottom: 6 },
  title: { color: COLORS.text, fontSize: 34, fontWeight: "700", letterSpacing: -1 },
  sub: { color: COLORS.textDim, fontSize: 13, marginTop: 2 },
  chRow: { paddingHorizontal: 12, paddingVertical: 12, gap: 8 },
  chip: { paddingHorizontal: 16, paddingVertical: 10, borderRadius: 999, backgroundColor: "rgba(118,118,128,0.18)", marginRight: 8 },
  chipActive: { backgroundColor: COLORS.primary },
  chipText: { color: COLORS.text, fontWeight: "500", fontSize: 13 },
  chipTextActive: { color: "#fff", fontWeight: "600" },
  center: { alignItems: "center", paddingVertical: 16 },
  ptt: { width: 220, height: 220, borderRadius: 110, alignItems: "center", justifyContent: "center", overflow: "hidden", borderWidth: 1, borderColor: COLORS.hairlineStrong },
  pttActive: { borderColor: COLORS.primary },
  pttLabel: { marginTop: 8, color: COLORS.text, fontWeight: "600", fontSize: 14 },
  hint: { color: COLORS.textDim, marginTop: 14, fontSize: 13 },
  histTitle: { color: COLORS.textDim, paddingHorizontal: 18, marginTop: 10, marginBottom: 6, fontSize: 13, fontWeight: "500" },
  msg: { flexDirection: "row", alignItems: "center", padding: 12 },
  playIcon: { width: 36, height: 36, borderRadius: 18, backgroundColor: COLORS.primary + "22", alignItems: "center", justifyContent: "center", marginRight: 12 },
  msgUser: { color: COLORS.text, fontWeight: "600" },
  msgMeta: { color: COLORS.textDim, fontSize: 12, marginTop: 2 },
});
