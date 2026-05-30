import React, { useEffect, useRef, useState } from "react";
import { View, Text, StyleSheet, TouchableOpacity, Pressable, ScrollView, Animated, Easing, Alert, Platform } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { SafeAreaView } from "react-native-safe-area-context";
import { Audio } from "expo-av";
import * as FileSystem from "expo-file-system/legacy";
import { LinearGradient } from "expo-linear-gradient";
import { BlurView } from "expo-blur";
import { useRouter } from "expo-router";
import { COLORS } from "../../src/theme";
import { api, formatErr } from "../../src/api";
import Glass from "../../src/Glass";
import { useSettings } from "../../src/settings";
import { livePttBus } from "../../src/livePtt";
import { useLatestTier, getPttRecordingOptions } from "../../src/proximityAudio";
import { setRecordingAudioMode, setIdleAudioMode } from "../../src/audioMode";

type Community = {
  id: string; name: string; description: string; member_count: number; is_admin: boolean;
  walkie_enabled?: boolean;
};
type PTT = { id: string; channel: string; user_id: string; handle: string; audio_b64: string; duration_ms: number; created_at: string };

// Visual constants ÃÂÃÂ¢ÃÂÃÂÃÂÃÂ keep PTT cleanly centered. Stage = ripple/tick area; button sits in middle.
const BTN_SIZE = 232;        // main glass core
const RING_GAP = 22;         // gap between core and tick ring
const STAGE = BTN_SIZE + RING_GAP * 2 + 28;  // total layered-stage size (ripples extend a bit further)

export default function ComsScreen() {
  const router = useRouter();
  const [communities, setCommunities] = useState<Community[]>([]);
  const [active, setActive] = useState<string | null>(null);
  const [settings, setSettings] = useSettings();
  // Persist active community to settings ÃÂÃÂ¢ÃÂÃÂÃÂÃÂ map.tsx reads this to scope the presence channel.
  const setActiveAndPersist = (id: string) => { setActive(id); setSettings({ activeCommunityId: id }); };
  const [recording, setRecording] = useState(false);
  const [busy, setBusy] = useState(false);
  const [history, setHistory] = useState<PTT[]>([]);
  const [loading, setLoading] = useState(true);
  const [playingId, setPlayingId] = useState<string | null>(null);
  // Recording start timestamp (epoch ms). Used to compute duration_ms ourselves
  // because expo-av's `Recording.getStatusAsync().durationMillis` is unreliable
  // ÃÂÃÂ¢ÃÂÃÂÃÂÃÂ it sometimes returns 0 or a stale cached value AFTER `stopAndUnloadAsync`,
  // which is why every clip in the comms history was showing "0s". By capturing
  // the wall-clock time at recordStart() and recordStop() we always have a
  // ground-truth duration regardless of what expo-av reports.
  const recRef = useRef<Audio.Recording | null>(null);
  const recordStartTsRef = useRef<number>(0);
  const soundRef = useRef<Audio.Sound | null>(null);
  // Track the active channel id in a ref so the live PTT bus subscription
  // always sees the latest selection without needing to resubscribe per change.
  const activeRef = useRef<string | null>(null);
  // Adaptive audio quality ÃÂÃÂ¢ÃÂÃÂÃÂÃÂ pulls the latest proximity tier from the shared
  // store (published by map.tsx every time peers/coords change). Drives the
  // PTT recording preset AND the "HD/Clear/Standard Audio" badge under the
  // mic button so the driver knows which preset is currently in effect.
  const { tier: proximityTier, peerCount: proximityPeers } = useLatestTier();
  // Roster of members in the currently-active community. Refreshed whenever
  // the active channel changes so the user always sees the right crew.
  const [members, setMembers] = useState<any[]>([]);

  // Animations
  const pulse = useRef(new Animated.Value(1)).current;
  const ring1 = useRef(new Animated.Value(0)).current;
  const ring2 = useRef(new Animated.Value(0)).current;
  const press = useRef(new Animated.Value(1)).current;

  useEffect(() => {
    (async () => {
      try {
        const { data } = await api.get("/communities/mine");
        setCommunities(data);
        if (data.length > 0) setActiveAndPersist(data[0].id);
      } catch {}
      setLoading(false);
      try {
        await Audio.requestPermissionsAsync();
        // Boot in PLAYBACK mode so the first incoming PTT comes out of the
        // loudspeaker / Bluetooth (not the earpiece). We re-enter recording
        // mode just-in-time inside `startRec` and flip back after stop.
        await setIdleAudioMode();
      } catch {}
    })();
    return () => { if (soundRef.current) { soundRef.current.unloadAsync().catch(() => {}); soundRef.current = null; } };
  }, []);

  useEffect(() => { if (active) loadHistory(); activeRef.current = active; }, [active]);

  // Load the member roster for the active community so we can show "who's
  // in this channel" right under the channel picker. The presence channel
  // shows who's *live* on the map ÃÂÃÂ¢ÃÂÃÂÃÂÃÂ the member list shows the full crew.
  useEffect(() => {
    if (!active) { setMembers([]); return; }
    (async () => {
      try {
        const { data } = await api.get(`/communities/${active}`);
        setMembers(Array.isArray(data?.members_users) ? data.members_users : []);
      } catch { setMembers([]); }
    })();
  }, [active]);

  // ===== Live walkie-talkie subscription =====
  // The actual WebSocket + audio playback lives in the global hook mounted in
  // /(app)/_layout.tsx ÃÂÃÂ¢ÃÂÃÂÃÂÃÂ so PTT plays on every tab (map, music, hub, etc).
  // Here we just listen to the in-process bus so the Comms screen's history
  // list updates in real time when a peer keys up on the active channel.
  useEffect(() => {
    const off = livePttBus.on((m) => {
      if (m.channel !== activeRef.current) return;
      setHistory((prev) => {
        if (prev.find((x) => x.id === m.id)) return prev;
        return [...prev, m].slice(-50);
      });
    });
    return off;
  }, []);

  useEffect(() => {
    let loops: Animated.CompositeAnimation[] = [];
    if (recording) {
      loops.push(
        Animated.loop(
          Animated.sequence([
            Animated.timing(pulse, { toValue: 1.05, duration: 700, useNativeDriver: true, easing: Easing.inOut(Easing.quad) }),
            Animated.timing(pulse, { toValue: 1.0, duration: 700, useNativeDriver: true, easing: Easing.inOut(Easing.quad) }),
          ])
        )
      );
      const ripple = (v: Animated.Value, delay: number) => Animated.loop(
        Animated.sequence([
          Animated.delay(delay),
          Animated.timing(v, { toValue: 1, duration: 1800, useNativeDriver: true, easing: Easing.out(Easing.cubic) }),
          Animated.timing(v, { toValue: 0, duration: 0, useNativeDriver: true }),
        ])
      );
      loops.push(ripple(ring1, 0));
      loops.push(ripple(ring2, 900));
      loops.forEach((l) => l.start());
    } else {
      pulse.setValue(1); ring1.setValue(0); ring2.setValue(0);
    }
    return () => loops.forEach((l) => l.stop());
  }, [recording, pulse, ring1, ring2]);

  const loadHistory = async () => {
    if (!active) return;
    try { const { data } = await api.get(`/ptt/${active}`); setHistory(data); } catch { setHistory([]); }
  };

  const startRec = async () => {
    if (recording || busy || !active) return;
    // Comms Live OFF ÃÂÃÂ¢ÃÂÃÂÃÂÃÂ radio silence, refuse to broadcast.
    if (settings.commsLive === false) {
      Alert.alert("Comms is OFF", "Turn Comms Live back on in Settings to broadcast.");
      return;
    }
    Animated.spring(press, { toValue: 0.96, useNativeDriver: true, speed: 30, bounciness: 6 }).start();
    try {
      // Switch to RECORDING audio category ÃÂÃÂ¢ÃÂÃÂÃÂÃÂ this enables `.playAndRecord`
      // on iOS so the mic is hot. We flip back to PLAYBACK in stopRec so the
      // OUTGOING-then-INCOMING transition uses the loudspeaker, not earpiece.
      await setRecordingAudioMode();
      const rec = new Audio.Recording();
      await rec.prepareToRecordAsync(getPttRecordingOptions(proximityTier));
      await rec.startAsync();
      // Capture our own start timestamp ÃÂÃÂ¢ÃÂÃÂÃÂÃÂ expo-av's status.durationMillis is
      // unreliable post-stop and was the root cause of "0s duration" in the
      // history list. Wall-clock diff is always accurate.
      recordStartTsRef.current = Date.now();
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
      // Compute duration BEFORE we touch expo-av. This is the ground truth.
      // Floor at 200ms ÃÂÃÂ¢ÃÂÃÂÃÂÃÂ anything shorter is almost certainly an accidental
      // tap and the user shouldn't see "0s" in their own history feed.
      const measuredDurationMs = recordStartTsRef.current > 0
        ? Math.max(200, Date.now() - recordStartTsRef.current)
        : 0;
      recordStartTsRef.current = 0;

      await rec.stopAndUnloadAsync();
      const uri = rec.getURI();
      recRef.current = null;
      // Switch back to PLAYBACK mode so any incoming PTT clip (or our own
      // playback if the user replays from history) hits the loudspeaker.
      setIdleAudioMode().catch(() => {});
      if (!uri) return;
      const res = await fetch(uri);
      const blob = await res.blob();
      const b64: string = await new Promise((resolve, reject) => {
        const r = new FileReader();
        r.onloadend = () => resolve(((r.result as string) || "").split(",")[1] || "");
        r.onerror = reject;
        r.readAsDataURL(blob);
      });
      await api.post("/ptt", { channel: active, audio_b64: b64, duration_ms: measuredDurationMs });
      await loadHistory();
    } catch (e) { Alert.alert("Send failed", formatErr(e)); }
    finally { setBusy(false); }
  };

  // Reliable playback: write the base64 audio to a cache file (.m4a) and play from file://.
  // Direct base64 data URIs trip AVFoundation error 11828 ("This media format is not supported")
  // on iOS for AAC-in-MP4 streams; a real file path resolves it.
  const playMessage = async (m: PTT) => {
    try {
      // Stop any currently playing sound
      if (soundRef.current) {
        try { await soundRef.current.unloadAsync(); } catch {}
        soundRef.current = null;
      }

      let uri: string;
      if (Platform.OS === "web") {
        // Web's HTML5 audio handles base64 data URIs fine; mp4 mime is the safest container alias.
        uri = `data:audio/mp4;base64,${m.audio_b64}`;
      } else {
        // Native: write to cache and play from file path
        const dir = FileSystem.cacheDirectory + "convoy-ptt/";
        try { await FileSystem.makeDirectoryAsync(dir, { intermediates: true }); } catch {}
        const path = `${dir}${m.id}.m4a`;
        const info = await FileSystem.getInfoAsync(path);
        if (!info.exists) {
          await FileSystem.writeAsStringAsync(path, m.audio_b64, { encoding: FileSystem.EncodingType.Base64 });
        }
        uri = path;
      }

      // Force loud-speaker output before any history replay too. Without
      // this, replaying a clip immediately after recording one comes out of
      // the iPhone earpiece at ~10% volume.
      await setIdleAudioMode();

      const { sound } = await Audio.Sound.createAsync(
        { uri },
        { shouldPlay: true, volume: 1.0 },
        (status: any) => {
          if (status?.didJustFinish) {
            setPlayingId(null);
            sound.unloadAsync().catch(() => {});
          }
        }
      );
      try { await sound.setVolumeAsync(1.0); } catch {}
      soundRef.current = sound;
      setPlayingId(m.id);
    } catch (e: any) {
      setPlayingId(null);
      Alert.alert("Playback failed", e?.message || String(e));
    }
  };

  const activeCommunity = communities.find((c) => c.id === active);

  // ----- Empty state -----
  if (!loading && communities.length === 0) {
    return (
      <SafeAreaView style={styles.c} edges={["top"]}>
        <View style={styles.header}><Text style={styles.title}>Comms</Text><Text style={styles.sub}>No communities yet</Text></View>
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
          <Text style={styles.title}>Comms</Text>
          <Text style={styles.sub}>{activeCommunity ? `Broadcasting on ${activeCommunity.name}` : "Select a channel"}</Text>
        </View>

        {/* ===== PTT button ÃÂÃÂ¢ÃÂÃÂÃÂÃÂ Apple liquid-glass design, perfectly centered ===== */}
        <View style={styles.pttSection}>
          {/* Adaptive audio quality badge ÃÂÃÂ¢ÃÂÃÂÃÂÃÂ dot color + label scale with how
              close the convoy is. Green/HD when a peer is within 500m,
              orange/Clear within 2km, grey/Standard beyond. */}
          <View style={styles.tierBadge}>
            <View style={[
              styles.tierDot,
              { backgroundColor: proximityTier === "close" ? "#34C759" : proximityTier === "mid" ? "#FF9500" : "#8E8E93" },
            ]} />
            <Text style={styles.tierLabel}>
              {proximityTier === "close" ? "HD Audio" : proximityTier === "mid" ? "Clear Audio" : "Standard Audio"}
              {proximityPeers > 0 ? ` ÃÂÃÂÃÂÃÂ· ${proximityPeers}` : ""}
            </Text>
          </View>
          <View style={styles.stage}>
            {/* Layer 1: expanding ripples (only while recording) */}
            <Animated.View
              pointerEvents="none"
              style={[
                styles.ripple,
                {
                  opacity: ring1.interpolate({ inputRange: [0, 1], outputRange: [0.45, 0] }),
                  transform: [{ scale: ring1.interpolate({ inputRange: [0, 1], outputRange: [0.9, 1.55] }) }],
                },
              ]}
            />
            <Animated.View
              pointerEvents="none"
              style={[
                styles.ripple,
                {
                  opacity: ring2.interpolate({ inputRange: [0, 1], outputRange: [0.45, 0] }),
                  transform: [{ scale: ring2.interpolate({ inputRange: [0, 1], outputRange: [0.9, 1.55] }) }],
                },
              ]}
            />

            {/* Layer 2: subtle outer ring */}
            <View style={styles.outerRing} pointerEvents="none" />

            {/* Layer 3: tick dial ÃÂÃÂ¢ÃÂÃÂÃÂÃÂ minimal, evenly spaced, very subtle */}
            <DialTicks active={recording} />

            {/* Layer 4: the button itself */}
            <Animated.View style={[styles.btnAnim, { transform: [{ scale: pulse }, { scale: press }] }]}>
              <Pressable
                testID="ptt-button"
                onPressIn={startRec}
                onPressOut={stopRec}
                style={styles.pressZone}
              >
                {/* Apple liquid-glass core */}
                <View style={styles.coreShadow}>
                  <View style={styles.coreClip}>
                    {/* Soft blurred backdrop */}
                    {Platform.OS !== "web" ? (
                      <BlurView intensity={80} tint="dark" style={StyleSheet.absoluteFill} />
                    ) : (
                      <View style={[StyleSheet.absoluteFill, { backgroundColor: "rgba(28,28,32,0.78)" }]} />
                    )}
                    {/* Bright orange tint underlay (red while transmitting for emphasis) */}
                    <LinearGradient
                      colors={
                        recording
                          ? ["rgba(255,69,58,0.65)", "rgba(170,30,28,0.30)"]
                          : ["rgba(255,122,0,0.78)", "rgba(255,87,0,0.30)"]
                      }
                      start={{ x: 0, y: 0 }}
                      end={{ x: 1, y: 1 }}
                      style={StyleSheet.absoluteFill}
                    />
                    {/* Glassy top highlight */}
                    <LinearGradient
                      colors={["rgba(255,255,255,0.32)", "rgba(255,255,255,0.0)"]}
                      style={styles.coreGloss}
                    />
                    {/* Hairline inner border */}
                    <View style={styles.innerHairline} pointerEvents="none" />

                    {/* Centered content */}
                    <View style={styles.coreContent}>
                      <Ionicons
                        name={recording ? "flash" : "flash"}
                        size={78}
                        color="#fff"
                        style={Platform.OS === "ios" ? { textShadowColor: "rgba(0,0,0,0.30)", textShadowOffset: { width: 0, height: 1 }, textShadowRadius: 5 } : undefined}
                      />
                      <Text style={styles.pttLabel}>{recording ? "TRANSMITTING" : "HOLD TO TALK"}</Text>
                    </View>

                    {/* Tiny REC indicator */}
                    {recording && (
                      <View style={styles.recIndicator}>
                        <View style={styles.recDot} />
                        <Text style={styles.recText}>REC</Text>
                      </View>
                    )}
                  </View>
                </View>
              </Pressable>
            </Animated.View>
          </View>

          <Text style={styles.hint}>
            {busy ? "SendingÃÂÃÂ¢ÃÂÃÂÃÂÃÂ¦" : recording ? "Release to broadcast" : `Press & hold to broadcast to ${activeCommunity?.name || "channel"}`}
          </Text>
        </View>

        {/* ===== Channels (Hub-style cards) =====
            Communities with `walkie_enabled === false` are hidden ÃÂÃÂ¢ÃÂÃÂÃÂÃÂ admins use that
            toggle to opt their crew out of PTT entirely. Membership is unchanged. */}
        <Text style={styles.section}>Channels</Text>
        {communities
          .filter((c) => c.walkie_enabled !== false)
          .map((c) => (
            <ChannelCard
              key={c.id}
              c={c}
              isActive={active === c.id}
              onPress={() => setActiveAndPersist(c.id)}
            />
          ))}
        {communities.length > 0 && communities.every((c) => c.walkie_enabled === false) && (
          <Glass radius={16} style={{ marginHorizontal: 18, marginTop: 6 }}>
            <View style={{ padding: 16, alignItems: "center" }}>
              <Ionicons name="flash-off" size={22} color={COLORS.textDim} />
              <Text style={[styles.emptyTitle, { marginTop: 8 }]}>Walkie disabled</Text>
              <Text style={styles.emptyText}>
                None of your communities have Walkie-Talkie Connect enabled. An admin can turn it on from Hub ÃÂÃÂ¢ÃÂÃÂÃÂÃÂ community ÃÂÃÂ¢ÃÂÃÂÃÂÃÂ settings.
              </Text>
            </View>
          </Glass>
        )}

        {/* ===== Crew roster =====
            Lists every member of the currently-active community. Helps drivers
            quickly see who is on this channel before keying up. The admin gets
            a small yellow "ADMIN" pill so it's clear who runs the crew. */}
        {active && members.length > 0 && (
          <>
            <Text style={styles.section}>{activeCommunity?.name || "Crew"} ÃÂÃÂÃÂÃÂ· {members.length} member{members.length === 1 ? "" : "s"}</Text>
            <Glass radius={16} style={{ marginHorizontal: 18 }}>
              <View style={{ paddingVertical: 4 }}>
                {members.map((m: any, idx: number) => (
                  <View key={m.id} style={[styles.memberRow, idx < members.length - 1 && styles.memberRowDivider]}>
                    <View style={styles.memberAvatar}><Ionicons name="person" size={14} color="#fff" /></View>
                    <View style={{ flex: 1 }}>
                      <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
                        <Text style={styles.memberName}>{m.handle || "anon"}</Text>
                        {m.is_admin && (
                          <View style={styles.adminPill}><Text style={styles.adminPillText}>ADMIN</Text></View>
                        )}
                      </View>
                      {(m.car_make || m.car_model || m.car_color) ? (
                        <Text style={styles.memberMeta} numberOfLines={1}>
                          {[m.car_color, m.car_make, m.car_model].filter(Boolean).join(" ")}
                        </Text>
                      ) : null}
                    </View>
                  </View>
                ))}
              </View>
            </Glass>
          </>
        )}

        {/* ===== Recent transmissions ===== */}
        {history.length > 0 && (
          <>
            <Text style={styles.section}>Recent transmissions</Text>
            {history.slice().reverse().map((m) => {
              const isPlaying = playingId === m.id;
              return (
                <Glass key={m.id} radius={16} style={{ marginBottom: 8, marginHorizontal: 18 }}>
                  <TouchableOpacity testID={`play-${m.id}`} style={styles.msg} onPress={() => playMessage(m)}>
                    <View style={[styles.playIcon, isPlaying && { backgroundColor: COLORS.primary }]}>
                      <Ionicons name={isPlaying ? "volume-high" : "play"} size={16} color={isPlaying ? "#fff" : COLORS.primary} />
                    </View>
                    <View style={{ flex: 1 }}>
                      <Text style={styles.msgUser}>{m.handle || "driver"}</Text>
                      <Text style={styles.msgMeta}>{Math.round((m.duration_ms || 0) / 1000)}s ÃÂÃÂÃÂÃÂ· {new Date(m.created_at).toLocaleTimeString()}</Text>
                    </View>
                    <Ionicons name="chevron-forward" size={18} color={COLORS.textDim} />
                  </TouchableOpacity>
                </Glass>
              );
            })}
          </>
        )}
      </ScrollView>
    </SafeAreaView>
  );
}

function ChannelCard({ c, isActive, onPress }: { c: Community; isActive: boolean; onPress: () => void }) {
  return (
    <TouchableOpacity testID={`channel-${c.id}`} onPress={onPress} activeOpacity={0.85} style={{ marginHorizontal: 18, marginBottom: 8 }}>
      <Glass radius={18} style={isActive ? { borderColor: COLORS.primary, borderWidth: 1.5 } : undefined}>
        <View style={styles.channelCard}>
          <View style={[styles.channelIcon, isActive && { backgroundColor: COLORS.primary + "55" }]}>
            <Ionicons name={isActive ? "flash" : "people"} size={22} color={COLORS.primary} />
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

// Minimal Apple-style tick dial ÃÂÃÂ¢ÃÂÃÂÃÂÃÂ 24 evenly spaced ticks. Centered via parent stage.
function DialTicks({ active }: { active: boolean }) {
  const ticks = 24;
  const ringRadius = (BTN_SIZE / 2) + RING_GAP - 2;
  return (
    <View pointerEvents="none" style={styles.tickContainer}>
      {Array.from({ length: ticks }).map((_, i) => {
        const angle = (i / ticks) * 360;
        const isMajor = i % 6 === 0;
        return (
          <View
            key={i}
            style={[
              styles.tick,
              {
                transform: [
                  { rotate: `${angle}deg` },
                  { translateY: -ringRadius },
                ],
                backgroundColor: active
                  ? (isMajor ? "rgba(255,255,255,0.9)" : COLORS.primary + "AA")
                  : (isMajor ? "rgba(255,255,255,0.45)" : "rgba(255,255,255,0.16)"),
                width: isMajor ? 2 : 1.2,
                height: isMajor ? 9 : 5,
              },
            ]}
          />
        );
      })}
    </View>
  );
}

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

  // ----- PTT stage (everything centered using a fixed-size stage) -----
  pttSection: { alignItems: "center", justifyContent: "center", paddingTop: 24, paddingBottom: 12 },
  // ===== Adaptive-audio tier badge =====
  // Tiny pill above the PTT button that mirrors the live `proximityTier`
  // computed from peer distances. Purely informational ÃÂÃÂ¢ÃÂÃÂÃÂÃÂ no tap target.
  tierBadge: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    alignSelf: "center",
    marginBottom: 14,
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: 999,
    backgroundColor: "rgba(255,255,255,0.06)",
  },
  tierDot: { width: 8, height: 8, borderRadius: 4 },
  tierLabel: { color: "rgba(255,255,255,0.7)", fontSize: 12, fontWeight: "600", letterSpacing: 0.3 },
  stage: {
    width: STAGE, height: STAGE,
    alignItems: "center", justifyContent: "center",
    position: "relative",
  },
  ripple: {
    position: "absolute", top: 0, left: 0, right: 0, bottom: 0,
    width: STAGE, height: STAGE,
    borderRadius: STAGE / 2,
    borderWidth: 1.5,
    borderColor: "rgba(255,255,255,0.55)",
  },
  outerRing: {
    position: "absolute",
    width: BTN_SIZE + RING_GAP * 2, height: BTN_SIZE + RING_GAP * 2,
    borderRadius: (BTN_SIZE + RING_GAP * 2) / 2,
    borderWidth: StyleSheet.hairlineWidth, borderColor: "rgba(255,255,255,0.18)",
  },
  tickContainer: {
    position: "absolute",
    width: BTN_SIZE + RING_GAP * 2, height: BTN_SIZE + RING_GAP * 2,
    alignItems: "center", justifyContent: "center",
  },
  tick: { position: "absolute", borderRadius: 1 },

  btnAnim: {
    width: BTN_SIZE, height: BTN_SIZE, borderRadius: BTN_SIZE / 2,
    alignItems: "center", justifyContent: "center",
  },
  pressZone: { width: BTN_SIZE, height: BTN_SIZE, borderRadius: BTN_SIZE / 2 },
  coreShadow: {
    width: BTN_SIZE, height: BTN_SIZE, borderRadius: BTN_SIZE / 2,
    ...Platform.select({
      ios: { shadowColor: "#FF6A00", shadowOpacity: 0.65, shadowRadius: 28, shadowOffset: { width: 0, height: 12 } },
      android: { elevation: 16 },
      web: { boxShadow: "0 16px 44px rgba(255,106,0,0.6), 0 4px 12px rgba(0,0,0,0.4)" } as any,
    }),
  },
  coreClip: {
    flex: 1, borderRadius: BTN_SIZE / 2, overflow: "hidden",
    backgroundColor: "rgba(20,20,24,0.65)",
    borderWidth: 1, borderColor: "rgba(255,255,255,0.18)",
  },
  coreGloss: {
    position: "absolute", top: 0, left: 0, right: 0, height: BTN_SIZE * 0.55,
    borderTopLeftRadius: BTN_SIZE / 2, borderTopRightRadius: BTN_SIZE / 2,
  },
  innerHairline: {
    position: "absolute", top: 4, left: 4, right: 4, bottom: 4,
    borderRadius: (BTN_SIZE - 8) / 2,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: "rgba(255,255,255,0.15)",
  },
  coreContent: {
    ...StyleSheet.absoluteFillObject,
    alignItems: "center", justifyContent: "center", gap: 8,
  },
  pttLabel: {
    color: "#fff", fontWeight: "700", fontSize: 13,
    letterSpacing: 2.4,
    ...Platform.select({ ios: { textShadowColor: "rgba(0,0,0,0.35)", textShadowOffset: { width: 0, height: 1 }, textShadowRadius: 3 }, default: {} }),
  },
  recIndicator: {
    position: "absolute", top: 22, alignSelf: "center",
    flexDirection: "row", alignItems: "center", gap: 5,
    paddingHorizontal: 8, paddingVertical: 3, borderRadius: 8,
    backgroundColor: "rgba(0,0,0,0.35)",
    borderWidth: StyleSheet.hairlineWidth, borderColor: "rgba(255,255,255,0.25)",
  },
  recDot: { width: 6, height: 6, borderRadius: 3, backgroundColor: "#FF453A" },
  recText: { color: "#fff", fontSize: 9, fontWeight: "800", letterSpacing: 0.8 },

  hint: { color: COLORS.textDim, marginTop: 24, fontSize: 13, textAlign: "center", paddingHorizontal: 24 },

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
  // Crew roster ÃÂÃÂ¢ÃÂÃÂÃÂÃÂ slim member row that fits inside the Glass card. Avatar +
  // handle + tiny car line, with a yellow ADMIN pill on the owner.
  memberRow: { flexDirection: "row", alignItems: "center", paddingVertical: 10, paddingHorizontal: 14, gap: 10 },
  memberRowDivider: { borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: COLORS.hairline },
  memberAvatar: { width: 28, height: 28, borderRadius: 14, backgroundColor: "rgba(118,118,128,0.4)", alignItems: "center", justifyContent: "center" },
  memberName: { color: COLORS.text, fontWeight: "600", fontSize: 14 },
  memberMeta: { color: COLORS.textDim, fontSize: 11, marginTop: 1 },
  adminPill: { backgroundColor: "#FFC70033", paddingHorizontal: 6, paddingVertical: 1, borderRadius: 5 },
  adminPillText: { color: "#FFC700", fontSize: 9, fontWeight: "700", letterSpacing: 0.5 },
});
