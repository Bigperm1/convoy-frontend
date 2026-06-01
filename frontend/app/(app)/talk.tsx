import React, { useState, useRef, useEffect, useCallback } from 'react';
import {
  View, Text, StyleSheet, Pressable, TouchableOpacity, Animated,
  SafeAreaView, ScrollView, Easing, Image,
} from 'react-native';
import * as Haptics from 'expo-haptics';
import { Audio } from 'expo-av';
import { Ionicons } from '@expo/vector-icons';
import { useRouter, useFocusEffect } from 'expo-router';
import LogoMenu from '../../src/components/LogoMenu';
import { api } from '../../src/api';
import { useSettings } from '../../src/settings';
import { useLatestTier, type ProximityTier } from '../../src/proximityAudio';
import { usePttChannel, type PTTMessage } from '../../src/pttChannel';

const YELLOW = '#FFD60A';

type Community = {
  id: string; name: string; member_count: number;
  is_admin: boolean; logo_b64?: string | null;
  walkie_enabled?: boolean;
};

// Format helpers for the live transmission list.
function fmtClock(iso: string): string {
  try {
    const d = new Date(iso);
    return d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  } catch { return ''; }
}
function fmtDur(ms: number): string {
  const s = Math.max(0, Math.round((ms || 0) / 1000));
  const m = Math.floor(s / 60);
  return `${m}:${String(s % 60).padStart(2, '0')}`;
}

// Comms quality label per proximity tier. Mirrors the proximityAudio tiers:
// close (<500m) → HD, mid (<2km) → Clear, far → Standard.
const TIER_META: Record<ProximityTier, { label: string; color: string }> = {
  close: { label: 'HD', color: '#30D158' },
  mid: { label: 'Clear', color: '#FFD60A' },
  far: { label: 'Standard', color: '#8E8E93' },
};

export default function TalkScreen() {
  const router = useRouter();
  const [settings, setSettings] = useSettings();
  const { tier } = useLatestTier();

  const [communities, setCommunities] = useState<Community[]>([]);
  const [pressed, setPressed] = useState(false);
  const [dropdownOpen, setDropdownOpen] = useState(false);
  const [playingId, setPlayingId] = useState<string | null>(null);
  // Recent-transmissions sheet: CLOSED by default so it never covers the mic.
  // It opens on demand (toggle pill) and a tap anywhere off it dismisses it.
  const [txOpen, setTxOpen] = useState(false);
  // Live nearby count fetched directly on this screen (works even if the map
  // tab hasn't been opened this session). Gated by the Nearby setting.
  const [nearbyCount, setNearbyCount] = useState<number | null>(null);

  const glow = useRef(new Animated.Value(0)).current;
  const scale = useRef(new Animated.Value(1)).current;
  const ring = useRef(new Animated.Value(0)).current;
  const playerRef = useRef<Audio.Sound | null>(null);

  // The active community = the one whose id matches settings.activeCommunityId.
  const active = communities.find((c) => c.id === settings.activeCommunityId);

  // Real PTT send + history for the active channel, recorded at a quality that
  // scales with convoy proximity (close = HD, far = walkie-grade).
  const ptt = usePttChannel(active?.id ?? null, tier);

  // Load the user's joined communities. Reloads on focus so a community
  // created/joined in the Hub shows up when the user returns to Comms.
  const loadCommunities = useCallback(async () => {
    try {
      const { data } = await api.get('/communities/mine');
      setCommunities(Array.isArray(data) ? data : []);
    } catch { /* keep last known list */ }
  }, []);

  // Nearby crew count — direct fetch so the figure is live on this screen
  // regardless of whether the map published a tier. Skipped when the Nearby
  // setting is off.
  const loadNearby = useCallback(async () => {
    if (!settings.showNearby) { setNearbyCount(null); return; }
    try {
      const { data } = await api.get('/users/nearby');
      setNearbyCount(Array.isArray(data) ? data.length : 0);
    } catch { /* leave previous value */ }
  }, [settings.showNearby]);

  useFocusEffect(useCallback(() => {
    loadCommunities();
    loadNearby();
    // Pre-warm mic permission when Comms opens, so the OS prompt is handled
    // calmly here rather than under a press. Requesting it during a PTT press
    // and then immediately starting a recording crashes the iOS audio session.
    // Only prompts when status is still undetermined.
    (async () => {
      try {
        const p = await Audio.getPermissionsAsync();
        if (p.status === 'undetermined' && p.canAskAgain) {
          await Audio.requestPermissionsAsync();
        }
      } catch {}
    })();
    // Poll nearby every 20s while the Comms screen is focused.
    const t = setInterval(loadNearby, 20000);
    return () => clearInterval(t);
  }, [loadCommunities, loadNearby]));

  useEffect(() => {
    if (pressed) {
      Animated.timing(scale, { toValue: 1.08, duration: 130, useNativeDriver: false }).start();
      Animated.loop(
        Animated.sequence([
          Animated.timing(glow, { toValue: 1, duration: 600, easing: Easing.inOut(Easing.ease), useNativeDriver: false }),
          Animated.timing(glow, { toValue: 0.5, duration: 600, easing: Easing.inOut(Easing.ease), useNativeDriver: false }),
        ])
      ).start();
      // Expanding "sonar" ring that radiates out each cycle for a lively pulse.
      ring.setValue(0);
      Animated.loop(
        Animated.timing(ring, { toValue: 1, duration: 1100, easing: Easing.out(Easing.ease), useNativeDriver: false })
      ).start();
    } else {
      glow.stopAnimation();
      ring.stopAnimation();
      Animated.timing(scale, { toValue: 1, duration: 130, useNativeDriver: false }).start();
      Animated.timing(glow, { toValue: 0, duration: 200, useNativeDriver: false }).start();
      Animated.timing(ring, { toValue: 0, duration: 200, useNativeDriver: false }).start();
    }
  }, [pressed]);

  const onPressIn = () => {
    if (!active) { // nothing to transmit to — nudge the user to pick a crew
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning).catch(() => {});
      setDropdownOpen(true);
      return;
    }
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Heavy);
    setDropdownOpen(false);
    setPressed(true);
    ptt.start();
  };
  const onPressOut = () => {
    if (!active) return;
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    setPressed(false);
    // Always attempt a stop on release (stopAndSend is safe when idle) so a
    // release can never be skipped and leave the mic open.
    ptt.stopAndSend();
  };

  const toggleDropdown = () => { Haptics.selectionAsync(); setDropdownOpen((o) => !o); };

  // Pick a community from the switcher → make it the active convoy. This
  // updates settings.activeCommunityId, which the map (presence broadcast) and
  // this header both read, so the whole app swaps to the chosen crew at once.
  const pickCommunity = (c: Community) => {
    Haptics.selectionAsync();
    setSettings({ activeCommunityId: c.id });
    setDropdownOpen(false);
  };

  const playConvo = async (m: PTTMessage) => {
    Haptics.selectionAsync();
    // Toggle off if tapping the one that's playing.
    if (playingId === m.id) {
      try { await playerRef.current?.unloadAsync(); } catch {}
      playerRef.current = null;
      setPlayingId(null);
      return;
    }
    try { await playerRef.current?.unloadAsync(); } catch {}
    playerRef.current = null;
    try {
      const uri = `data:audio/mp4;base64,${m.audio_b64}`;
      const { sound } = await Audio.Sound.createAsync(
        { uri },
        { shouldPlay: true, volume: 1.0 },
        (status: any) => {
          if (status?.didJustFinish) {
            sound.unloadAsync().catch(() => {});
            if (playerRef.current === sound) playerRef.current = null;
            setPlayingId((cur) => (cur === m.id ? null : cur));
          }
        }
      );
      playerRef.current = sound;
      setPlayingId(m.id);
    } catch {
      setPlayingId(null);
    }
  };

  // Unload any playing clip on unmount.
  useEffect(() => () => { playerRef.current?.unloadAsync().catch(() => {}); }, []);

  const glowOpacity = glow.interpolate({ inputRange: [0, 1], outputRange: [0, 0.95] });
  const glowRadius = glow.interpolate({ inputRange: [0, 1], outputRange: [22, 60] });
  const ringScale = ring.interpolate({ inputRange: [0, 1], outputRange: [0.85, 1.6] });
  const ringOpacity = ring.interpolate({ inputRange: [0, 0.15, 1], outputRange: [0, 0.55, 0] });

  const tierMeta = TIER_META[tier];
  // Connected line: prefer the live nearby count (when the Nearby setting is
  // on), else fall back to the community's total member count.
  const connectedText = (settings.showNearby && nearbyCount != null)
    ? `${nearbyCount} nearby`
    : active ? `${active.member_count} member${active.member_count === 1 ? '' : 's'}` : '';

  return (
    <SafeAreaView style={styles.safe}>
      {/* Community header — live active convoy */}
      <View style={styles.header}>
        {active ? (
          <Pressable style={styles.communityBtn} onPress={toggleDropdown}>
            <View style={styles.avatar}>
              {active.logo_b64 ? (
                <Image source={{ uri: active.logo_b64 }} style={styles.avatarImg} />
              ) : (
                <Ionicons name="people" size={20} color={YELLOW} />
              )}
            </View>
            <View style={{ flexShrink: 1 }}>
              <Text style={styles.communityName} numberOfLines={1}>{active.name}</Text>
              <View style={styles.subRow}>
                <Text style={styles.connected}>{connectedText}</Text>
                <View style={[styles.tierPill, { backgroundColor: tierMeta.color + '22' }]}>
                  <Ionicons name="radio" size={10} color={tierMeta.color} />
                  <Text style={[styles.tierText, { color: tierMeta.color }]}>{tierMeta.label}</Text>
                </View>
              </View>
            </View>
            <TouchableOpacity onPress={toggleDropdown} hitSlop={12} style={styles.chevBtn}>
              <Ionicons name={dropdownOpen ? 'chevron-up' : 'chevron-down'} size={20} color="#fff" />
            </TouchableOpacity>
          </Pressable>
        ) : (
          <Pressable style={styles.communityBtn} onPress={toggleDropdown}>
            <View style={styles.avatar}>
              <Ionicons name="people" size={20} color="#8E8E93" />
            </View>
            <View style={{ flexShrink: 1 }}>
              <Text style={styles.communityName} numberOfLines={1}>
                {communities.length ? 'Choose your convoy' : 'No communities yet'}
              </Text>
              <Text style={styles.connectedMuted} numberOfLines={1}>
                {communities.length ? 'Tap to pick the crew you’re driving with' : 'Create or join one in the Hub'}
              </Text>
            </View>
            {communities.length > 0 && (
              <TouchableOpacity onPress={toggleDropdown} hitSlop={12} style={styles.chevBtn}>
                <Ionicons name={dropdownOpen ? 'chevron-up' : 'chevron-down'} size={20} color="#fff" />
              </TouchableOpacity>
            )}
          </Pressable>
        )}
        <LogoMenu size={30} style={styles.garageBtn} />
      </View>

      {/* Tap anywhere outside the mic to dismiss the open switcher. Rendered
          before the body so the mic Pressable stays on top and still works;
          empty-space taps fall through to this overlay. */}
      {dropdownOpen && (
        <Pressable style={styles.dismissOverlay} onPress={() => setDropdownOpen(false)} />
      )}

      {/* Community switcher dropdown — lists all joined communities. */}
      {dropdownOpen && (
        <View style={styles.switcher}>
          <Text style={styles.switcherTitle}>Your communities</Text>
          {communities.length === 0 ? (
            <TouchableOpacity onPress={() => { setDropdownOpen(false); router.push('/(app)/hub'); }} style={styles.switcherEmpty}>
              <Ionicons name="add-circle-outline" size={18} color={YELLOW} />
              <Text style={styles.switcherEmptyText}>Go to the Hub to create or join a community</Text>
            </TouchableOpacity>
          ) : (
            <ScrollView style={{ maxHeight: 300 }} showsVerticalScrollIndicator={false}>
              {communities.map((c) => {
                const isActive = c.id === settings.activeCommunityId;
                return (
                  <TouchableOpacity key={c.id} onPress={() => pickCommunity(c)} style={styles.switcherRow} activeOpacity={0.8}>
                    <View style={styles.switcherAvatar}>
                      {c.logo_b64 ? (
                        <Image source={{ uri: c.logo_b64 }} style={styles.switcherAvatarImg} />
                      ) : (
                        <Ionicons name="people" size={18} color={isActive ? YELLOW : '#8E8E93'} />
                      )}
                    </View>
                    <View style={{ flex: 1 }}>
                      <Text style={styles.switcherName} numberOfLines={1}>{c.name}</Text>
                      <Text style={styles.switcherMeta} numberOfLines={1}>
                        {c.member_count} member{c.member_count === 1 ? '' : 's'}{c.is_admin ? ' · admin' : ''}
                      </Text>
                    </View>
                    {isActive ? (
                      <View style={styles.switcherActivePill}>
                        <Text style={styles.switcherActiveText}>ACTIVE</Text>
                      </View>
                    ) : (
                      <Ionicons name="radio-button-off" size={20} color="#48484A" />
                    )}
                  </TouchableOpacity>
                );
              })}
            </ScrollView>
          )}
        </View>
      )}

      {/* Body */}
      <View style={styles.body}>
        {/* Mic + its sonar ring live in a fixed 320x320 box so the ring is
            always perfectly centered on the mic (the absolute ring fills this
            box, and the mic fills it too, so they share the same center). */}
        <View style={styles.micWrap}>
        {/* Expanding sonar ring while transmitting */}
        <Animated.View
          pointerEvents="none"
          style={[styles.pttRing, { opacity: ringOpacity, transform: [{ scale: ringScale }] }]}
        />
        <Animated.View
          style={[
            styles.glowWrap,
            {
              transform: [{ scale }],
              shadowColor: YELLOW,
              shadowOpacity: glowOpacity,
              shadowRadius: glowRadius,
              shadowOffset: { width: 0, height: 0 },
            },
          ]}
        >
          <Pressable onPressIn={onPressIn} onPressOut={onPressOut} style={[styles.pttOuter, pressed && styles.pttOuterActive, !active && styles.pttOuterDisabled]}>
            <View style={[styles.pttInner, pressed && styles.pttInnerActive]}>
              <Ionicons name="mic" size={112} color={pressed ? YELLOW : active ? '#fff' : '#555'} />
            </View>
          </Pressable>
        </Animated.View>
        </View>

        <Text style={[styles.pttLabel, pressed && { color: YELLOW }]}>
          {!active ? 'Pick a convoy to talk' : pressed ? 'Release to send' : 'Hold to Talk'}
        </Text>

        {/* Recent Transmissions toggle — sits inline under the label so it can
            never overlap the mic. Tapping opens the sheet below; the mic press
            no longer forces it open. */}
        {active && !dropdownOpen && (
          <TouchableOpacity
            style={styles.txToggle}
            activeOpacity={0.85}
            onPress={() => { Haptics.selectionAsync(); setTxOpen((o) => !o); }}
          >
            <Ionicons name="radio" size={15} color={YELLOW} />
            <Text style={styles.txToggleText}>
              Recent Transmissions{ptt.history.length ? `  ·  ${ptt.history.length}` : ''}
            </Text>
            {ptt.sending && <Text style={styles.txSending}>Sending…</Text>}
            <Ionicons name={txOpen ? 'chevron-down' : 'chevron-up'} size={16} color="#888" />
          </TouchableOpacity>
        )}

        {/* Tap-away backdrop + the transmissions sheet. The backdrop fills the
            screen so a tap ANYWHERE off the sheet closes it (the mic sits under
            it while open; close first to transmit). */}
        {active && !dropdownOpen && txOpen && (
          <>
            <Pressable style={styles.txBackdrop} onPress={() => { setTxOpen(false); }} />
            <View style={styles.txSheet}>
              <Text style={styles.txSheetTitle}>Recent Transmissions</Text>
              {ptt.history.length === 0 ? (
                <Text style={styles.emptyTx}>No transmissions yet. Hold the mic to talk to your crew.</Text>
              ) : (
                <ScrollView style={{ maxHeight: 300 }} showsVerticalScrollIndicator={false}>
                  {ptt.history.map((m) => (
                    <View key={m.id} style={styles.convoRow}>
                      <View style={styles.convoTop}>
                        <TouchableOpacity onPress={() => playConvo(m)} style={styles.playBtn} activeOpacity={0.8}>
                          <Ionicons name={playingId === m.id ? 'pause' : 'play'} size={18} color="#000" />
                        </TouchableOpacity>
                        <View style={{ flex: 1 }}>
                          <Text style={styles.convoSpeaker} numberOfLines={1}>{m.handle || 'Driver'}</Text>
                          <Text style={styles.convoMeta}>{fmtClock(m.created_at)} · {fmtDur(m.duration_ms)}</Text>
                        </View>
                        {playingId === m.id && (
                          <View style={styles.playingPill}>
                            <Ionicons name="volume-high" size={13} color={YELLOW} />
                          </View>
                        )}
                      </View>
                    </View>
                  ))}
                </ScrollView>
              )}
            </View>
          </>
        )}
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: '#000' },

  header: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingHorizontal: 16, paddingTop: 8, paddingBottom: 14,
    borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: '#1c1c1e',
  },
  communityBtn: { flexDirection: 'row', alignItems: 'center', gap: 10, flex: 1 },
  avatar: {
    width: 42, height: 42, borderRadius: 21, backgroundColor: '#1c1c1e',
    alignItems: 'center', justifyContent: 'center', borderWidth: 1, borderColor: 'rgba(255,214,10,0.45)',
    overflow: 'hidden',
  },
  avatarImg: { width: 42, height: 42 },
  communityName: { color: '#fff', fontSize: 17, fontWeight: '700' },
  subRow: { flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 2 },
  connected: { color: '#30D158', fontSize: 12 },
  connectedMuted: { color: '#8E8E93', fontSize: 12, marginTop: 1 },
  tierPill: { flexDirection: 'row', alignItems: 'center', gap: 3, paddingHorizontal: 7, paddingVertical: 2, borderRadius: 8 },
  tierText: { fontSize: 11, fontWeight: '700', letterSpacing: 0.3 },
  chevBtn: { marginLeft: 4, padding: 2 },
  garageBtn: { padding: 4, marginLeft: 8 },

  // Community switcher dropdown
  switcher: {
    marginHorizontal: 16, marginTop: 10,
    backgroundColor: '#161618', borderRadius: 18, padding: 12,
    borderWidth: 1, borderColor: '#2a2a2e',
    shadowColor: '#000', shadowOpacity: 0.5, shadowRadius: 18, shadowOffset: { width: 0, height: 8 }, elevation: 20,
  },
  switcherTitle: { color: '#8E8E93', fontSize: 11, fontWeight: '700', letterSpacing: 0.7, textTransform: 'uppercase', marginBottom: 8, marginLeft: 2 },
  switcherRow: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 9 },
  switcherAvatar: { width: 38, height: 38, borderRadius: 12, backgroundColor: '#1c1c1e', alignItems: 'center', justifyContent: 'center', overflow: 'hidden' },
  switcherAvatarImg: { width: 38, height: 38 },
  switcherName: { color: '#fff', fontSize: 15, fontWeight: '600' },
  switcherMeta: { color: '#8E8E93', fontSize: 12, marginTop: 1 },
  switcherActivePill: { backgroundColor: 'rgba(48,209,88,0.2)', paddingHorizontal: 8, paddingVertical: 3, borderRadius: 8 },
  switcherActiveText: { color: '#30D158', fontSize: 9, fontWeight: '700', letterSpacing: 0.5 },
  switcherEmpty: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingVertical: 10, paddingHorizontal: 2 },
  switcherEmptyText: { color: '#bbb', fontSize: 13, flex: 1 },

  body: { flex: 1, alignItems: 'center', justifyContent: 'center', position: 'relative' },

  micWrap: { width: 320, height: 320, alignItems: 'center', justifyContent: 'center', alignSelf: 'center' },
  glowWrap: { width: 320, height: 320, borderRadius: 160, alignItems: 'center', justifyContent: 'center', elevation: 18 },
  pttRing: {
    position: 'absolute',
    top: 0, left: 0, right: 0, bottom: 0,
    width: 320, height: 320, borderRadius: 160,
    borderWidth: 3, borderColor: YELLOW,
  },
  pttOuter: {
    width: 320, height: 320, borderRadius: 160, backgroundColor: '#0e0e10',
    alignItems: 'center', justifyContent: 'center', borderWidth: 6, borderColor: '#2a2a2e',
  },
  pttOuterActive: { borderColor: YELLOW },
  pttOuterDisabled: { opacity: 0.5 },
  pttInner: {
    width: 256, height: 256, borderRadius: 128, backgroundColor: '#141417',
    alignItems: 'center', justifyContent: 'center',
  },
  pttInnerActive: { backgroundColor: '#1f1b00' },
  pttLabel: { color: '#888', fontSize: 16, fontWeight: '600', marginTop: 30, letterSpacing: 0.5 },

  dropdown: {
    position: 'absolute', top: 12, left: 16, right: 16,
    backgroundColor: '#161618', borderRadius: 22, padding: 16,
    borderWidth: 1, borderColor: '#2a2a2e',
    shadowColor: '#000', shadowOpacity: 0.55, shadowRadius: 24, shadowOffset: { width: 0, height: 10 }, elevation: 24,
  },
  dropdownTitle: { color: '#fff', fontSize: 13, fontWeight: '700', marginBottom: 10, textTransform: 'uppercase', letterSpacing: 0.7 },
  dropdownHeaderRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  sendingText: { color: YELLOW, fontSize: 12, fontWeight: '600', marginBottom: 10 },
  emptyTx: { color: '#888', fontSize: 13, lineHeight: 18, paddingVertical: 4 },
  playingPill: { paddingHorizontal: 8, paddingVertical: 5, borderRadius: 8, backgroundColor: 'rgba(255,214,10,0.12)' },
  convoRow: { paddingVertical: 11, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: '#262629' },
  convoTop: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  playBtn: { width: 40, height: 40, borderRadius: 20, backgroundColor: YELLOW, alignItems: 'center', justifyContent: 'center' },
  convoSpeaker: { color: '#fff', fontSize: 15, fontWeight: '600' },
  convoMeta: { color: '#888', fontSize: 12, marginTop: 1 },

  // ----- Recent Transmissions: toggle pill + tap-away sheet + swipe rows -----
  txToggle: {
    flexDirection: 'row', alignItems: 'center', gap: 8,
    paddingHorizontal: 16, paddingVertical: 10, borderRadius: 22,
    backgroundColor: '#161618', borderWidth: 1, borderColor: '#2a2a2e',
    marginTop: 26,
  },
  txToggleText: { color: '#fff', fontSize: 13, fontWeight: '600' },
  txSending: { color: YELLOW, fontSize: 12, fontWeight: '600' },
  txBackdrop: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, zIndex: 20 },
  txSheet: {
    position: 'absolute', bottom: 96, left: 16, right: 16, zIndex: 30,
    backgroundColor: '#161618', borderRadius: 20, paddingHorizontal: 12, paddingTop: 14, paddingBottom: 6,
    borderWidth: 1, borderColor: '#2a2a2e',
    shadowColor: '#000', shadowOpacity: 0.55, shadowRadius: 24, shadowOffset: { width: 0, height: 10 }, elevation: 24,
  },
  txSheetTitle: { color: '#fff', fontSize: 13, fontWeight: '700', textTransform: 'uppercase', letterSpacing: 0.7, marginBottom: 6, marginLeft: 4 },

  dismissOverlay: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0 },
});
