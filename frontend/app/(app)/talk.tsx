import React, { useEffect, useRef, useState } from "react";
import { View, Text, StyleSheet, TouchableOpacity, Pressable, ScrollView, Animated, Easing, Alert } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { SafeAreaView } from "react-native-safe-area-context";
import { Audio } from "expo-av";
import { COLORS } from "../../src/theme";
import { api, formatErr } from "../../src/api";
import { useAuth } from "../../src/auth";

type Channel = { id: string; name: string; desc: string };
type PTT = { id: string; channel: string; user_id: string; handle: string; audio_b64: string; duration_ms: number; created_at: string };

export default function TalkScreen() {
  const { user } = useAuth();
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
      try {
        const { data } = await api.get("/channels");
        setChannels(data);
      } catch (e) {}
      await Audio.requestPermissionsAsync();
      await Audio.setAudioModeAsync({ allowsRecordingIOS: true, playsInSilentModeIOS: true });
    })();
  }, []);

  useEffect(() => { loadHistory(); }, [active]);

  useEffect(() => {
    if (recording) {
      Animated.loop(
        Animated.sequence([
          Animated.timing(pulse, { toValue: 1.15, duration: 600, useNativeDriver: true, easing: Easing.inOut(Easing.ease) }),
          Animated.timing(pulse, { toValue: 1, duration: 600, useNativeDriver: true, easing: Easing.inOut(Easing.ease) }),
        ])
      ).start();
    } else {
      pulse.stopAnimation();
      pulse.setValue(1);
    }
  }, [recording]);

  const loadHistory = async () => {
    try {
      const { data } = await api.get(`/ptt/${active}`);
      setHistory(data);
    } catch {}
  };

  const startRec = async () => {
    if (recording || busy) return;
    try {
      const rec = new Audio.Recording();
      await rec.prepareToRecordAsync(Audio.RecordingOptionsPresets.HIGH_QUALITY);
      await rec.startAsync();
      recRef.current = rec;
      setRecording(true);
    } catch (e) {
      Alert.alert("Mic error", String(e));
    }
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
        const reader = new FileReader();
        reader.onloadend = () => resolve(((reader.result as string) || "").split(",")[1] || "");
        reader.onerror = reject;
        reader.readAsDataURL(blob);
      });
      await api.post("/ptt", { channel: active, audio_b64: b64, duration_ms: (status as any)?.durationMillis || 0 });
      await loadHistory();
    } catch (e) {
      Alert.alert("Send failed", formatErr(e));
    } finally {
      setBusy(false);
    }
  };

  const playMessage = async (m: PTT) => {
    try {
      if (soundRef.current) { await soundRef.current.unloadAsync(); soundRef.current = null; }
      const uri = `data:audio/m4a;base64,${m.audio_b64}`;
      const { sound } = await Audio.Sound.createAsync({ uri }, { shouldPlay: true });
      soundRef.current = sound;
    } catch (e) {
      Alert.alert("Playback failed", String(e));
    }
  };

  return (
    <SafeAreaView style={styles.c} edges={["top"]}>
      <Text style={styles.title}>WALKIE</Text>
      <Text style={styles.sub}>Tap & hold to transmit · Channel: {channels.find((c) => c.id === active)?.name}</Text>

      <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.chRow}>
        {channels.map((c) => (
          <TouchableOpacity
            key={c.id}
            testID={`channel-${c.id}`}
            onPress={() => setActive(c.id)}
            style={[styles.chip, active === c.id && styles.chipActive]}
          >
            <Text style={[styles.chipText, active === c.id && styles.chipTextActive]}>{c.name}</Text>
          </TouchableOpacity>
        ))}
      </ScrollView>

      <View style={styles.center}>
        <Animated.View style={{ transform: [{ scale: pulse }] }}>
          <Pressable
            testID="ptt-button"
            onPressIn={startRec}
            onPressOut={stopRec}
            style={[styles.ptt, recording && styles.pttActive]}
          >
            <Ionicons name={recording ? "radio" : "mic"} size={72} color={recording ? "#000" : COLORS.primary} />
            <Text style={[styles.pttLabel, recording && { color: "#000" }]}>{recording ? "TRANSMITTING" : "PUSH TO TALK"}</Text>
          </Pressable>
        </Animated.View>
        <Text style={styles.hint}>{busy ? "Sending…" : "Hold the button while speaking"}</Text>
      </View>

      <Text style={styles.histTitle}>RECENT TRANSMISSIONS</Text>
      <ScrollView style={{ flex: 1 }} contentContainerStyle={{ paddingHorizontal: 18, paddingBottom: 30 }} testID="ptt-history">
        {history.length === 0 && <Text style={{ color: COLORS.textDim, fontStyle: "italic" }}>No transmissions yet on this channel.</Text>}
        {history.slice().reverse().map((m) => (
          <TouchableOpacity key={m.id} testID={`play-${m.id}`} style={styles.msg} onPress={() => playMessage(m)}>
            <View style={styles.playIcon}><Ionicons name="play" size={18} color={COLORS.primary} /></View>
            <View style={{ flex: 1 }}>
              <Text style={styles.msgUser}>{m.handle || "driver"}</Text>
              <Text style={styles.msgMeta}>{Math.round((m.duration_ms || 0) / 1000)}s · {new Date(m.created_at).toLocaleTimeString()}</Text>
            </View>
          </TouchableOpacity>
        ))}
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  c: { flex: 1, backgroundColor: COLORS.bg },
  title: { color: COLORS.text, fontSize: 28, fontWeight: "900", letterSpacing: 4, padding: 18, paddingBottom: 0 },
  sub: { color: COLORS.textDim, paddingHorizontal: 18, marginTop: 2, fontSize: 12 },
  chRow: { paddingHorizontal: 12, paddingVertical: 12, gap: 8 },
  chip: { paddingHorizontal: 16, paddingVertical: 10, borderRadius: 999, backgroundColor: COLORS.surface, borderWidth: 1, borderColor: COLORS.border, marginRight: 8 },
  chipActive: { backgroundColor: COLORS.primary, borderColor: COLORS.primary },
  chipText: { color: COLORS.text, fontWeight: "700", fontSize: 12, letterSpacing: 1.5 },
  chipTextActive: { color: "#000" },
  center: { alignItems: "center", paddingVertical: 14 },
  ptt: {
    width: 220, height: 220, borderRadius: 110, backgroundColor: COLORS.surface,
    alignItems: "center", justifyContent: "center", borderWidth: 4, borderColor: COLORS.primary + "55",
  },
  pttActive: { backgroundColor: COLORS.primary, borderColor: COLORS.primary },
  pttLabel: { marginTop: 6, color: COLORS.primary, fontWeight: "900", letterSpacing: 2, fontSize: 12 },
  hint: { color: COLORS.textDim, marginTop: 10, fontSize: 12 },
  histTitle: { color: COLORS.textDim, paddingHorizontal: 18, marginTop: 10, marginBottom: 6, letterSpacing: 2, fontSize: 11 },
  msg: { flexDirection: "row", alignItems: "center", backgroundColor: COLORS.surface, padding: 12, borderRadius: 14, marginBottom: 8, borderWidth: 1, borderColor: COLORS.border },
  playIcon: { width: 36, height: 36, borderRadius: 18, backgroundColor: COLORS.primary + "22", alignItems: "center", justifyContent: "center", marginRight: 12 },
  msgUser: { color: COLORS.text, fontWeight: "800" },
  msgMeta: { color: COLORS.textDim, fontSize: 11, marginTop: 2 },
});
