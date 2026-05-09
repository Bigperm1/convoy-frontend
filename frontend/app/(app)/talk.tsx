import React, { useEffect, useRef, useState } from "react";
import { View, Text, StyleSheet, TouchableOpacity, Pressable, ScrollView, Animated, Easing, Alert, Platform } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { SafeAreaView } from "react-native-safe-area-context";
import { Audio } from "expo-av";
import { LinearGradient } from "expo-linear-gradient";
import { useRouter } from "expo-router";
import { COLORS } from "../../src/theme";
import { api, formatErr } from "../../src/api";
import Glass from "../../src/Glass";

type Community = { id: string; name: string; description: string; member_count: number; is_admin: boolean };
type PTT = { id: string; channel: string; user_id: string; handle: string; audio_b64: string; duration_ms: number; created_at: string };

export default function ComsScreen() {
  const router = useRouter();
  const [communities, setCommunities] = useState<Community[]>([]);
  const [active, setActive] = useState<string | null>(null);
  const [recording, setRecording] = useState(false);
  const [busy, setBusy] = useState(false);
  const [history, setHistory] = useState<PTT[]>([]);
  const [loading, setLoading] = useState(true);
  const recRef = useRef<Audio.Recording | null>(null);
  const soundRef = useRef<Audio.Sound | null>(null);

  // Layered animations for a richer PTT button
  const pulse = useRef(new Animated.Value(1)).current;       // scale of inner core
  const ring1 = useRef(new Animated.Value(0)).current;       // outer expanding ring 1
  const ring2 = useRef(new Animated.Value(0)).current;       // outer expanding ring 2
  const press = useRef(new Animated.Value(1)).current;       // tactile press feedback

  useEffect(() => {
    (async () => {
      try {
        const { data } = await api.get("/communities/mine");
        setCommunities(data);
        if (data.length > 0) setActive(data[0].id);
      } catch {}
      setLoading(false);
      try {
        await Audio.requestPermissionsAsync();
        await Audio.setAudioModeAsync({ allowsRecordingIOS: true, playsInSilentModeIOS: true });
      } catch {}
    })();
  }, []);

  useEffect(() => { if (active) loadHistory(); }, [active]);

  useEffect(() => {
    let loops: Animated.CompositeAnimation[] = [];
    if (recording) {
      loops.push(
        Animated.loop(
          Animated.sequence([
            Animated.timing(pulse, { toValue: 1.06, duration: 600, useNativeDriver: true, easing: Easing.inOut(Easing.quad) }),
            Animated.timing(pulse, { toValue: 1.0, duration: 600, useNativeDriver: true, easing: Easing.inOut(Easing.quad) }),
          ])
        )
      );
      // Two staggered ripples (radio-wave feel)
      const ripple = (v: Animated.Value, delay: number) => Animated.loop(
        Animated.sequence([
          Animated.delay(delay),
          Animated.timing(v, { toValue: 1, duration: 1600, useNativeDriver: true, easing: Easing.out(Easing.cubic) }),
          Animated.timing(v, { toValue: 0, duration: 0, useNativeDriver: true }),
        ])
      );
      loops.push(ripple(ring1, 0));
      loops.push(ripple(ring2, 800));
      loops.forEach((l) => l.start());
    } else {
      pulse.setValue(1);
      ring1.setValue(0);
      ring2.setValue(0);
    }
    return () => loops.forEach((l) => l.stop());
  }, [recording, pulse, ring1, ring2]);

  const loadHistory = async () => {
    if (!active) return;
    try { const { data } = await api.get(`/ptt/${active}`); setHistory(data); } catch { setHistory([]); }
  };

  const startRec = async () => {
    if (recording || busy || !active) return;
    Animated.spring(press, { toValue: 0.96, useNativeDriver: true, speed: 30, bounciness: 8 }).start();
    try {
      const rec = new Audio.Recording();
      await rec.prepareToRecordAsync(Audio.RecordingOptionsPresets.HIGH_QUALITY);
      await rec.startAsync();
      recRef.current = rec;
      setRecording(true);
    } catch (e) { Alert.alert("Mic error", String(e)); }
  };

  const stopRec = async () => {
    Animated.spring(press, { toValue: 1, useNativeDriver: true, speed: 18, bounciness: 8 }).start();
    const rec = recRef.current;
    if (!rec || !active) return;
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

  const activeCommunity = communities.find((c) => c.id === active);

  // ----- Empty state -----
  if (!loading && communities.length === 0) {
    return (
      <SafeAreaView style={styles.c} edges={["top"]}>
        <View style={styles.header}><Text style={styles.title}>Coms</Text><Text style={styles.sub}>No communities yet</Text></View>
        <View style={styles.empty}>
          <Glass radius={24} style={{ width: "100%", maxWidth: 360 }}>
            <View style={{ padding: 24, alignItems: "center" }}>
              <View style={styles.emptyIcon}>
                <Ionicons name="people" size={36} color={COLORS.primary} />
              </View>
              <Text style={styles.emptyTitle}>Join a community</Text>
              <Text style={styles.emptyText}>Walkie-talkie channels are powered by your communities. Create or find one in the Hub tab to start talking.</Text>
              <TouchableOpacity testID="go-hub" onPress={() => router.push("/(app)/hub")} style={styles.cta} activeOpacity={0.85}>
                <LinearGradient colors={[COLORS.primary, COLORS.primaryDim]} style={styles.ctaGrad}>
                  <Text style={styles.ctaText}>Open Hub</Text>
                </LinearGradient>
              </TouchableOpacity>
            </View>
          </Glass>
        </View>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={styles.c} edges={["top"]}>
      <ScrollView contentContainerStyle={{ paddingBottom: 110 }} showsVerticalScrollIndicator={false}>
        <View style={styles.header}>
          <Text style={styles.title}>Coms</Text>
          <Text style={styles.sub}>{activeCommunity ? `Broadcasting on ${activeCommunity.name}` : "Select a channel"}</Text>
        </View>

        {/* ===== Big PTT button ===== */}
        <View style={styles.pttWrap}>
          {/* Outer expanding ripples (only while recording) */}
          <Animated.View
            pointerEvents="none"
            style={[
              styles.ripple,
              {
                opacity: ring1.interpolate({ inputRange: [0, 1], outputRange: [0.55, 0] }),
                transform: [{ scale: ring1.interpolate({ inputRange: [0, 1], outputRange: [0.85, 1.55] }) }],
              },
            ]}
          />
          <Animated.View
            pointerEvents="none"
            style={[
              styles.ripple,
              {
                opacity: ring2.interpolate({ inputRange: [0, 1], outputRange: [0.55, 0] }),
                transform: [{ scale: ring2.interpolate({ inputRange: [0, 1], outputRange: [0.85, 1.55] }) }],
              },
            ]}
          />

          {/* Decorative tick marks around the dial */}
          <DialTicks active={recording} />

          <Animated.View style={{ transform: [{ scale: pulse }, { scale: press }] }}>
            <Pressable
              testID="ptt-button"
              onPressIn={startRec}
              onPressOut={stopRec}
              style={styles.ptt}
            >
              {/* Soft outer halo */}
              <View style={[styles.haloRing, recording && { borderColor: COLORS.primary + "55" }]} />
              {/* Main core with gradient */}
              <View style={styles.coreShadow}>
                <View style={styles.core}>
                  <LinearGradient
                    colors={recording ? ["#FF6B6B", "#E0271E"] : ["#7C7AED", "#5E5CE6", "#3D3BC2"]}
                    start={{ x: 0, y: 0 }}
                    end={{ x: 1, y: 1 }}
                    style={StyleSheet.absoluteFill}
                  />
                  {/* glassy highlight */}
                  <View style={styles.coreGloss} />
                  <Ionicons name={recording ? "radio" : "mic"} size={86} color="#fff" />
                  <Text style={styles.pttLabel}>{recording ? "TRANSMITTING" : "HOLD TO TALK"}</Text>
                  {recording && <View style={styles.recDot} />}
                </View>
              </View>
            </Pressable>
          </Animated.View>

          <Text style={styles.hint}>
            {busy ? "Sending…" : recording ? "Release to broadcast" : `Press & hold to broadcast to ${activeCommunity?.name || "channel"}`}
          </Text>
        </View>

        {/* ===== Channels (Hub-style cards) ===== */}
        <Text style={styles.section}>Channels</Text>
        {communities.map((c) => (
          <ChannelCard
            key={c.id}
            c={c}
            isActive={active === c.id}
            onPress={() => setActive(c.id)}
          />
        ))}

        {/* ===== Recent transmissions ===== */}
        {history.length > 0 && (
          <>
            <Text style={styles.section}>Recent transmissions</Text>
            {history.slice().reverse().map((m) => (
              <Glass key={m.id} radius={16} style={{ marginBottom: 8, marginHorizontal: 18 }}>
                <TouchableOpacity testID={`play-${m.id}`} style={styles.msg} onPress={() => playMessage(m)}>
                  <View style={styles.playIcon}><Ionicons name="play" size={16} color={COLORS.primary} /></View>
                  <View style={{ flex: 1 }}>
                    <Text style={styles.msgUser}>{m.handle || "driver"}</Text>
                    <Text style={styles.msgMeta}>{Math.round((m.duration_ms || 0) / 1000)}s · {new Date(m.created_at).toLocaleTimeString()}</Text>
                  </View>
                  <Ionicons name="chevron-forward" size={18} color={COLORS.textDim} />
                </TouchableOpacity>
              </Glass>
            ))}
          </>
        )}
      </ScrollView>
    </SafeAreaView>
  );
}

// Hub-style card for channel selection (matches CommunityCard styling)
function ChannelCard({ c, isActive, onPress }: { c: Community; isActive: boolean; onPress: () => void }) {
  return (
    <TouchableOpacity testID={`channel-${c.id}`} onPress={onPress} activeOpacity={0.85} style={{ marginHorizontal: 18, marginBottom: 8 }}>
      <Glass radius={18} style={isActive ? { borderColor: COLORS.primary, borderWidth: 1.5 } : undefined}>
        <View style={styles.channelCard}>
          <View style={[styles.channelIcon, isActive && { backgroundColor: COLORS.primary + "55" }]}>
            <Ionicons name={isActive ? "radio" : "people"} size={22} color={COLORS.primary} />
          </View>
          <View style={{ flex: 1 }}>
            <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
              <Text style={styles.channelName}>{c.name}</Text>
              {c.is_admin && <View style={styles.adminBadge}><Text style={styles.adminBadgeText}>ADMIN</Text></View>}
              {isActive && <View style={styles.liveBadge}><View style={styles.liveDot} /><Text style={styles.liveBadgeText}>LIVE</Text></View>}
            </View>
            <Text style={styles.channelMeta}>{c.member_count} {c.member_count === 1 ? "member" : "members"}</Text>
          </View>
          {isActive ? (
            <View style={styles.checkPill}><Ionicons name="checkmark" size={16} color="#fff" /></View>
          ) : (
            <Ionicons name="chevron-forward" size={20} color={COLORS.textDim} />
          )}
        </View>
      </Glass>
    </TouchableOpacity>
  );
}

// Tick marks ring around the PTT button — purely decorative, animates color while recording
function DialTicks({ active }: { active: boolean }) {
  const ticks = 36;
  const radius = 154;
  return (
    <View pointerEvents="none" style={[styles.ticksRing, { width: radius * 2, height: radius * 2 }]}>
      {Array.from({ length: ticks }).map((_, i) => {
        const angle = (i / ticks) * 360;
        const isMajor = i % 3 === 0;
        return (
          <View
            key={i}
            style={[
              styles.tick,
              isMajor && styles.tickMajor,
              {
                transform: [
                  { rotate: `${angle}deg` },
                  { translateY: -radius + 4 },
                ],
                backgroundColor: active ? COLORS.primary + (isMajor ? "" : "88") : isMajor ? "rgba(255,255,255,0.35)" : "rgba(255,255,255,0.15)",
              },
            ]}
          />
        );
      })}
    </View>
  );
}

const PTT_SIZE = 240;
const HALO_SIZE = 270;
const RIPPLE_SIZE = 290;

const styles = StyleSheet.create({
  c: { flex: 1, backgroundColor: COLORS.bg },
  header: { paddingHorizontal: 18, paddingTop: 8, paddingBottom: 6 },
  title: { color: COLORS.text, fontSize: 34, fontWeight: "700", letterSpacing: -1 },
  sub: { color: COLORS.textDim, fontSize: 13, marginTop: 2 },

  // Empty state
  empty: { flex: 1, alignItems: "center", justifyContent: "center", padding: 24 },
  emptyIcon: { width: 76, height: 76, borderRadius: 38, backgroundColor: COLORS.primary + "22", alignItems: "center", justifyContent: "center", marginBottom: 14 },
  emptyTitle: { color: COLORS.text, fontSize: 22, fontWeight: "700", letterSpacing: -0.4 },
  emptyText: { color: COLORS.textDim, textAlign: "center", marginTop: 8, fontSize: 14, lineHeight: 20 },
  cta: { marginTop: 18, borderRadius: 14, overflow: "hidden", alignSelf: "stretch" },
  ctaGrad: { paddingVertical: 14, alignItems: "center" },
  ctaText: { color: "#fff", fontWeight: "600", fontSize: 16 },

  // PTT
  pttWrap: { alignItems: "center", justifyContent: "center", paddingVertical: 28, marginTop: 8 },
  ticksRing: { position: "absolute", alignItems: "center", justifyContent: "center" },
  tick: { position: "absolute", width: 2, height: 8, borderRadius: 1, backgroundColor: "rgba(255,255,255,0.15)" },
  tickMajor: { width: 3, height: 12 },
  ripple: {
    position: "absolute", width: RIPPLE_SIZE, height: RIPPLE_SIZE, borderRadius: RIPPLE_SIZE / 2,
    borderWidth: 2, borderColor: COLORS.primary,
  },
  ptt: {
    width: HALO_SIZE, height: HALO_SIZE, borderRadius: HALO_SIZE / 2,
    alignItems: "center", justifyContent: "center",
  },
  haloRing: {
    position: "absolute", width: HALO_SIZE, height: HALO_SIZE, borderRadius: HALO_SIZE / 2,
    borderWidth: 1.5, borderColor: "rgba(255,255,255,0.10)",
  },
  coreShadow: {
    width: PTT_SIZE, height: PTT_SIZE, borderRadius: PTT_SIZE / 2,
    ...Platform.select({
      ios: { shadowColor: "#5E5CE6", shadowOpacity: 0.55, shadowRadius: 22, shadowOffset: { width: 0, height: 10 } },
      android: { elevation: 18 },
      web: { boxShadow: "0 12px 40px rgba(94,92,230,0.55)" } as any,
    }),
  },
  core: {
    flex: 1, borderRadius: PTT_SIZE / 2, overflow: "hidden",
    alignItems: "center", justifyContent: "center",
    borderWidth: 3, borderColor: "rgba(255,255,255,0.18)",
  },
  coreGloss: {
    position: "absolute", top: 8, left: 8, right: 8, height: PTT_SIZE * 0.42,
    borderRadius: PTT_SIZE / 2, backgroundColor: "rgba(255,255,255,0.10)",
  },
  pttLabel: {
    marginTop: 10, color: "#fff", fontWeight: "800", fontSize: 14,
    letterSpacing: 2.2,
    ...Platform.select({ ios: { textShadowColor: "rgba(0,0,0,0.35)", textShadowOffset: { width: 0, height: 1 }, textShadowRadius: 4 }, default: {} }),
  },
  recDot: {
    position: "absolute", top: 24, width: 10, height: 10, borderRadius: 5, backgroundColor: "#fff",
    ...Platform.select({ ios: { shadowColor: "#fff", shadowOpacity: 0.9, shadowRadius: 6 }, default: {} }),
  },
  hint: { color: COLORS.textDim, marginTop: 22, fontSize: 13, textAlign: "center", paddingHorizontal: 24 },

  // Hub-style channel cards
  section: { color: COLORS.textDim, marginHorizontal: 18, marginTop: 22, marginBottom: 10, fontSize: 13, fontWeight: "600", letterSpacing: 0.3 },
  channelCard: { flexDirection: "row", alignItems: "center", padding: 12, gap: 12 },
  channelIcon: { width: 44, height: 44, borderRadius: 14, backgroundColor: COLORS.primary + "22", alignItems: "center", justifyContent: "center" },
  channelName: { color: COLORS.text, fontWeight: "600", fontSize: 16 },
  channelMeta: { color: COLORS.textDim, fontSize: 12, marginTop: 2 },
  adminBadge: { backgroundColor: COLORS.warning + "33", paddingHorizontal: 6, paddingVertical: 2, borderRadius: 6 },
  adminBadgeText: { color: COLORS.warning, fontSize: 9, fontWeight: "700", letterSpacing: 0.5 },
  liveBadge: { flexDirection: "row", alignItems: "center", gap: 4, backgroundColor: COLORS.success + "33", paddingHorizontal: 6, paddingVertical: 2, borderRadius: 6 },
  liveBadgeText: { color: COLORS.success, fontSize: 9, fontWeight: "700", letterSpacing: 0.5 },
  liveDot: { width: 6, height: 6, borderRadius: 3, backgroundColor: COLORS.success },
  checkPill: { width: 28, height: 28, borderRadius: 14, backgroundColor: COLORS.primary, alignItems: "center", justifyContent: "center" },

  // Transmissions
  msg: { flexDirection: "row", alignItems: "center", padding: 12, gap: 12 },
  playIcon: { width: 36, height: 36, borderRadius: 18, backgroundColor: COLORS.primary + "22", alignItems: "center", justifyContent: "center" },
  msgUser: { color: COLORS.text, fontWeight: "600" },
  msgMeta: { color: COLORS.textDim, fontSize: 12, marginTop: 2 },
});
