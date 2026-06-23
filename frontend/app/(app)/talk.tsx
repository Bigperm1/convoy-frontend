import React, { useState, useRef, useEffect, useCallback } from 'react';
import {
  View, Text, StyleSheet, Pressable, TouchableOpacity, Animated,
  ScrollView, Easing, Image, Alert, Platform,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import * as Haptics from 'expo-haptics';
import { Audio } from 'expo-av';
import { Ionicons } from '@expo/vector-icons';
import { useRouter, useFocusEffect } from 'expo-router';
import LogoMenu from '../../src/components/LogoMenu';
import CommsHoldGlow from '../../src/components/CommsHoldGlow';
import { shareInbox } from '../../src/shareInbox';
import { api } from '../../src/api';
import { useAuth } from '../../src/auth';
import { useSettings } from '../../src/settings';
import { useLatestTier, type ProximityTier } from '../../src/proximityAudio';
import { usePttChannel, type PTTMessage } from '../../src/pttChannel';
import { livePttBus, setCommsScreenFocused, acquireFloor, releaseFloor, getFloorHolder, floorBus, threadBus } from '../../src/livePtt';
import { commsRead } from '../../src/commsRead';
import { setPlaybackAudioMode, setIdleAudioMode } from '../../src/audioMode';

const YELLOW = '#2DEC86';

type Community = {
  id: string; name: string; member_count: number;
  is_admin: boolean; logo_b64?: string | null;
  walkie_enabled?: boolean;
};

type ThreadParticipant = { id: string; handle: string };
type Thread = {
  id: string; title: string; is_group: boolean;
  participants: ThreadParticipant[]; last_at?: string | null;
};
type RosterMember = { id: string; handle: string };

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
  mid: { label: 'Clear', color: '#2DEC86' },
  far: { label: 'Standard', color: '#8E8E93' },
};

export default function TalkScreen() {
  const router = useRouter();
  const [settings, setSettings] = useSettings();
  const { user } = useAuth();
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
  // Private conversation threads (walkie DMs / groups) — pick a thread to talk
  // to just those members instead of the whole crew.
  const [threads, setThreads] = useState<Thread[]>([]);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [roster, setRoster] = useState<RosterMember[]>([]);
  const [picked, setPicked] = useState<string[]>([]);
  const [creating, setCreating] = useState(false);
  // "[name] is talking…" indicator shown right above the mic.
  const [talkingHandle, setTalkingHandle] = useState<string | null>(null);
  // Who currently holds the walkie floor on this channel (null = free / me).
  const [floorHolder, setFloorHolder] = useState<{ id: string; handle: string } | null>(null);
  // Hands-free (VOX) mode — only offered on private threads. When on, the mic
  // is tap-to-open instead of hold, and a 3s-silence auto-cut ends each turn.
  const [voxOn, setVoxOn] = useState(false);

  const glow = useRef(new Animated.Value(0)).current;
  const scale = useRef(new Animated.Value(1)).current;
  const ring = useRef(new Animated.Value(0)).current;
  const playerRef = useRef<Audio.Sound | null>(null);
  const talkTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const floorTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Read/unread tracking: re-render on changes + a focus flag so we only
  // auto-mark the active channel read while Comms is actually on-screen.
  const [, setReadTick] = useState(0);
  const focusedRef = useRef(false);
  useEffect(() => commsRead.subscribe(() => setReadTick((n) => n + 1)), []);

  // The active community = the one whose id matches settings.activeCommunityId.
  const active = communities.find((c) => c.id === settings.activeCommunityId);

  // A private thread can be selected as the active conversation. When one is
  // picked we transmit to JUST its participants; otherwise we talk to the whole
  // crew (the community channel). channelId is what every layer keys on: the
  // PTT hook, the history list, and the global live listener.
  const activeThreadId = settings.activeThreadId ?? null;
  const activeThread = threads.find((t) => t.id === activeThreadId) || null;
  const channelId = activeThreadId || active?.id || null;

  // Real PTT send + history for the active channel (crew OR private thread),
  // recorded at a quality that scales with convoy proximity.
  const ptt = usePttChannel(channelId, tier);

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

  // Load the user's private conversation threads (the inbox of walkie DMs /
  // groups). Reloads on focus so a thread started elsewhere shows up.
  const loadThreads = useCallback(async () => {
    try {
      const { data } = await api.get('/threads');
      setThreads(Array.isArray(data) ? data : []);
    } catch { /* keep last known list */ }
  }, []);

  useFocusEffect(useCallback(() => {
    loadCommunities();
    loadThreads();
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
  }, [loadCommunities, loadThreads, loadNearby]));

  // Show "[name] is talking…" above the mic when a member transmits on the
  // channel you're viewing (crew OR thread). Never for your own voice.
  useEffect(() => {
    const off = livePttBus.on((m) => {
      if (!channelId || m.channel !== channelId) return;
      if (user?.id && m.user_id === user.id) return;
      if (settings.commsLive === false) return;
      // Ignore replayed backlog (cold start / channel switch) — only a recent
      // clip means someone is talking live.
      const created = new Date(m.created_at).getTime();
      if (Number.isFinite(created) && Date.now() - created > 15000) return;
      setTalkingHandle(m.handle || 'Driver');
      if (talkTimer.current) clearTimeout(talkTimer.current);
      talkTimer.current = setTimeout(() => setTalkingHandle(null), 3000);
    });
    return () => { off(); if (talkTimer.current) clearTimeout(talkTimer.current); };
  }, [channelId, user?.id, settings.commsLive]);

  // Feed EVERY incoming transmission into the read/unread tracker so threads
  // you're not currently viewing light up. If it lands on the channel you're
  // viewing while focused, keep that channel marked read so it never self-dots.
  useEffect(() => {
    const off = livePttBus.on((m) => {
      if (!m.channel) return;
      if (user?.id && m.user_id === user.id) return; // our own voice isn't "unread"
      commsRead.noteActivity(m.channel);
      if (m.channel === channelId && focusedRef.current) commsRead.markChannelRead(channelId);
    });
    return () => { off(); };
  }, [channelId, user?.id]);

  // Seed the tracker with each thread's latest activity (last_at) so a thread
  // with messages newer than you last opened it shows a chip dot.
  useEffect(() => {
    threads.forEach((t) => {
      const ts = t.last_at ? new Date(t.last_at).getTime() : 0;
      if (Number.isFinite(ts) && ts > 0) commsRead.noteActivity(t.id, ts);
    });
  }, [threads]);

  // While Comms is focused, suppress the global top "talking" banner — we show
  // our own indicator above the mic instead.
  useFocusEffect(useCallback(() => {
    setCommsScreenFocused(true);
    return () => setCommsScreenFocused(false);
  }, []));

  // Mark the active conversation read whenever Comms is focused, and again
  // whenever you switch conversations while it's open.
  useFocusEffect(useCallback(() => {
    focusedRef.current = true;
    if (channelId) commsRead.markChannelRead(channelId);
    return () => { focusedRef.current = false; };
  }, [channelId]));

  // ----- Walkie floor control: track who holds the mic on this channel -----
  useEffect(() => {
    const h = channelId ? getFloorHolder(channelId) : null;
    setFloorHolder(h && h.id !== user?.id ? h : null);
    const off = floorBus.on((f) => {
      if (!channelId || f.channel !== channelId) return;
      if (floorTimer.current) { clearTimeout(floorTimer.current); floorTimer.current = null; }
      if (f.state === 'free' || (f.holder_id && f.holder_id === user?.id)) { setFloorHolder(null); return; }
      setFloorHolder({ id: f.holder_id!, handle: f.holder_handle || 'Driver' });
      // Client backstop: clear after the server's TTL in case a "free" is missed.
      floorTimer.current = setTimeout(() => setFloorHolder(null), 65000);
    });
    return () => { off(); if (floorTimer.current) clearTimeout(floorTimer.current); };
  }, [channelId, user?.id]);

  // If we were keying up but someone else holds the floor (we lost a
  // simultaneous-press race), back off and cancel our recording so two people
  // can't both transmit at once.
  useEffect(() => {
    if (floorHolder && (pressed || ptt.voxActive)) {
      setPressed(false);
      if (ptt.voxActive) ptt.stopVox(); else ptt.cancel();
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning).catch(() => {});
    }
  }, [floorHolder, pressed, ptt.voxActive]);

  // Switching conversation (or leaving a thread for Crew) closes an open
  // hands-free session so the mic never stays hot on a channel you've left.
  useEffect(() => {
    if (ptt.voxActive) ptt.stopVox();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [channelId]);

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
    if (!channelId) { // nothing to transmit to — nudge the user to pick a crew
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning).catch(() => {});
      setDropdownOpen(true);
      return;
    }
    if (floorHolder) { // someone else holds the mic — can't cut in
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning).catch(() => {});
      return;
    }
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Heavy);
    setDropdownOpen(false);
    setPressed(true);
    acquireFloor(channelId);
    ptt.start();
  };
  const onPressOut = () => {
    if (!channelId) return;
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    setPressed(false);
    // Release the floor so the next person can key up.
    releaseFloor(channelId);
    // Always attempt a stop on release (stopAndSend is safe when idle) so a
    // release can never be skipped and leave the mic open.
    ptt.stopAndSend();
  };

  // Hands-free tap handler (VOX mode, threads only): tap to OPEN the mic, tap
  // again (or 3s of silence) sends the turn + closes.
  const onMicTap = () => {
    if (!channelId) {
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning).catch(() => {});
      setDropdownOpen(true);
      return;
    }
    if (ptt.voxActive) { ptt.stopVox(); setPressed(false); return; }
    if (floorHolder) { Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning).catch(() => {}); return; }
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Heavy);
    setDropdownOpen(false);
    setPressed(true);
    acquireFloor(channelId);
    ptt.startVox(() => { releaseFloor(channelId); setPressed(false); });
  };

  // Toggle hands-free on/off (closes any open session when turning it off).
  const toggleVox = () => {
    Haptics.selectionAsync().catch(() => {});
    if (ptt.voxActive) { ptt.stopVox(); setPressed(false); }
    setVoxOn((v) => !v);
  };

  const toggleDropdown = () => { Haptics.selectionAsync(); setDropdownOpen((o) => !o); };

  // Pick a community from the switcher → make it the active convoy. This
  // updates settings.activeCommunityId, which the map (presence broadcast) and
  // this header both read, so the whole app swaps to the chosen crew at once.
  const pickCommunity = (c: Community) => {
    Haptics.selectionAsync();
    // Switching crew always lands you on that crew's whole-channel (not a
    // leftover private thread from another context).
    setSettings({ activeCommunityId: c.id, activeThreadId: null });
    setDropdownOpen(false);
  };

  // ----- Private conversation threads -----
  const selectCrew = () => { Haptics.selectionAsync().catch(() => {}); setSettings({ activeThreadId: null }); };
  const selectThread = (t: Thread) => { Haptics.selectionAsync().catch(() => {}); setSettings({ activeThreadId: t.id }); };

  // ----- Delete a private conversation (hold-to-delete) -----
  // Long-pressing a thread chip removes the whole conversation. The backend
  // deletes it for EVERY participant (server-side) and fans out a
  // `thread_deleted` frame, so the other members' inboxes drop it live too.
  // The Crew chip is a community channel (not a thread), so it has no
  // long-press affordance and can never be deleted here.
  const removeThreadLocal = useCallback((id: string) => {
    setThreads((prev) => prev.filter((t) => t.id !== id));
    // If we were viewing the deleted thread, fall back to the Crew channel.
    if ((settings.activeThreadId ?? null) === id) setSettings({ activeThreadId: null });
  }, [settings.activeThreadId, setSettings]);

  const confirmDeleteThread = useCallback((t: Thread) => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium).catch(() => {});
    Alert.alert(
      'Delete conversation',
      `Delete your conversation with ${t.title}? This removes it for everyone in it.`,
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Delete',
          style: 'destructive',
          onPress: async () => {
            removeThreadLocal(t.id);          // optimistic
            try { await api.delete(`/threads/${t.id}`); }
            catch { loadThreads(); }          // restore the list if the delete failed
          },
        },
      ],
    );
  }, [removeThreadLocal, loadThreads]);

  // Live-remove a thread when ANY participant deletes it (the other member
  // pressed delete on their device).
  useEffect(() => {
    const off = threadBus.on((e) => { if (e.type === 'deleted') removeThreadLocal(e.id); });
    return () => { off(); };
  }, [removeThreadLocal]);

  // Open the "new conversation" picker — load the active crew's roster so the
  // user can choose who to talk to privately. Self is filtered out.
  const openThreadPicker = useCallback(async () => {
    if (!active) { setDropdownOpen(true); return; }
    Haptics.selectionAsync().catch(() => {});
    setPicked([]);
    setRoster([]);
    setPickerOpen(true);
    try {
      const { data } = await api.get(`/communities/${active.id}`);
      const list = Array.isArray(data?.members_users) ? data.members_users : [];
      setRoster(
        list
          .filter((m: any) => m?.id && m.id !== user?.id)
          .map((m: any) => ({ id: m.id, handle: m.handle || 'Driver' }))
      );
    } catch { setRoster([]); }
  }, [active, user?.id]);

  const toggleMember = (id: string) => {
    Haptics.selectionAsync().catch(() => {});
    setPicked((p) => (p.includes(id) ? p.filter((x) => x !== id) : [...p, id]));
  };

  // Create (or reuse) the thread for the picked members, then make it active.
  const startThread = useCallback(async () => {
    if (!active || picked.length === 0 || creating) return;
    setCreating(true);
    try {
      const { data } = await api.post('/threads', { participant_ids: picked, community_id: active.id });
      if (data?.id) {
        setThreads((prev) => [data, ...prev.filter((t) => t.id !== data.id)]);
        setSettings({ activeThreadId: data.id });
      }
      setPickerOpen(false);
      setPicked([]);
    } catch { /* leave picker open so the user can retry */ }
    finally { setCreating(false); }
  }, [active, picked, creating, setSettings]);

  // ----- Receive a shared comms channel -----
  // A crew member shared their channel (kind:"comm") via the ShareToast. Switch
  // our active community to it so we land on the SAME PTT channel — that's what
  // lets us hear them and talk back. Live PTT requires both drivers to be
  // members of, and active on, the same community (the backend scopes every
  // transmission to channel members). Consumed once — on the ping if Talk is
  // mounted, else on next focus.
  const applyPendingComm = useCallback(() => {
    const c = shareInbox.takeComm();
    if (!c?.id) return;
    setSettings({ activeCommunityId: c.id, activeThreadId: null });
    setDropdownOpen(false);
  }, [setSettings]);
  useEffect(() => {
    const fn = () => { applyPendingComm(); };
    return shareInbox.subscribe(fn);
  }, [applyPendingComm]);
  useFocusEffect(useCallback(() => { applyPendingComm(); }, [applyPendingComm]));

  const playConvo = async (m: PTTMessage) => {
    Haptics.selectionAsync();
    commsRead.markClipPlayed(m.id);
    // Toggle off if tapping the one that's playing.
    if (playingId === m.id) {
      try { await playerRef.current?.unloadAsync(); } catch {}
      playerRef.current = null;
      setPlayingId(null);
      void setIdleAudioMode(); // release the duck → other apps back to full volume
      return;
    }
    try { await playerRef.current?.unloadAsync(); } catch {}
    playerRef.current = null;
    try {
      // Duck all other apps (Spotify / Apple Music / YouTube / etc.) while the
      // replayed transmission plays — same loudspeaker + .duckOthers session the
      // live PTT and Nova use. Released on finish / toggle-off / unmount.
      await setPlaybackAudioMode();
      const uri = `data:audio/mp4;base64,${m.audio_b64}`;
      const { sound } = await Audio.Sound.createAsync(
        { uri },
        { shouldPlay: true, volume: 1.0 },
        (status: any) => {
          if (status?.didJustFinish) {
            sound.unloadAsync().catch(() => {});
            if (playerRef.current === sound) playerRef.current = null;
            setPlayingId((cur) => (cur === m.id ? null : cur));
            void setIdleAudioMode(); // un-duck once the clip ends
          }
        }
      );
      playerRef.current = sound;
      setPlayingId(m.id);
    } catch {
      setPlayingId(null);
    }
  };

  // Unload any playing clip on unmount + release the duck so other apps recover.
  useEffect(() => () => { playerRef.current?.unloadAsync().catch(() => {}); void setIdleAudioMode(); }, []);

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

  // Hands-free is only available on a private thread (not the whole-crew channel).
  const voxMode = voxOn && !!activeThread;

  return (
    <>
    <SafeAreaView style={styles.safe} edges={["top"]}>
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

      {/* Conversation strip — Crew (whole community) + your private threads +
          a New button. Pick one to set who the mic talks to. */}
      {active && !dropdownOpen && (
        <View style={styles.stripWrap}>
          <Text style={styles.stripTitle}>Comms Threads</Text>
          <ScrollView
            horizontal
            showsHorizontalScrollIndicator={false}
            contentContainerStyle={styles.strip}
          >
            <TouchableOpacity onPress={selectCrew} style={[styles.chip, !activeThreadId && styles.chipActive]} activeOpacity={0.85}>
              <Ionicons name="people" size={15} color={!activeThreadId ? '#000' : YELLOW} />
              <Text style={[styles.chipText, !activeThreadId && styles.chipTextActive]} numberOfLines={1}>Crew</Text>
              {!!activeThreadId && !!active && commsRead.channelHasUnread(active.id) && <View style={styles.chipDot} />}
            </TouchableOpacity>
            {threads.map((t) => {
              const on = t.id === activeThreadId;
              return (
                <TouchableOpacity key={t.id} onPress={() => selectThread(t)} onLongPress={() => confirmDeleteThread(t)} delayLongPress={400} style={[styles.chip, on && styles.chipActive]} activeOpacity={0.85}>
                  <Ionicons name={t.is_group ? 'people-circle' : 'person'} size={15} color={on ? '#000' : '#bbb'} />
                  <Text style={[styles.chipText, on && styles.chipTextActive]} numberOfLines={1}>{t.title}</Text>
                  {!on && commsRead.channelHasUnread(t.id) && <View style={styles.chipDot} />}
                </TouchableOpacity>
              );
            })}
            <TouchableOpacity onPress={openThreadPicker} style={styles.chipNew} activeOpacity={0.85}>
              <Ionicons name="add" size={16} color={YELLOW} />
              <Text style={styles.chipNewText}>New</Text>
            </TouchableOpacity>
          </ScrollView>
        </View>
      )}

      {/* Body */}
      <View style={styles.body}>
        {/* "[name] is talking…" — fixed-height slot so it never shifts the mic. */}
        <View style={styles.talkingWrap}>
          {(floorHolder || talkingHandle) ? (
            <View style={styles.talkingPill}>
              <Ionicons name="mic" size={14} color="#FF6A00" />
              <Text style={styles.talkingText} numberOfLines={1}>{floorHolder?.handle ?? talkingHandle} is talking…</Text>
            </View>
          ) : null}
        </View>
        {/* Mic + its sonar ring live in a fixed 320x320 box so the ring is
            always perfectly centered on the mic (the absolute ring fills this
            box, and the mic fills it too, so they share the same center). */}
        <View style={styles.micWrap}>
        {/* Smoky green hold-glow — the same cloud as the Comms tab mic, scaled up
            and more dramatic. Breathes outward while holding-to-talk or hands-free. */}
        <CommsHoldGlow active={pressed || ptt.voxActive} sizeScale={2.6} />
        {/* Expanding sonar ring while transmitting */}
        <Animated.View
          pointerEvents="none"
          style={[styles.pttRing, { opacity: ringOpacity, transform: [{ scale: ringScale }] }]}
        />
        <Animated.View
          style={[
            styles.glowWrap,
            // Green smoke (CommsHoldGlow) is the only glow now — drop the yellow
            // shadow halo so this matches the Comms tab mic's animation exactly.
            { transform: [{ scale }] },
          ]}
        >
          <Pressable
            onPressIn={voxMode ? undefined : onPressIn}
            onPressOut={voxMode ? undefined : onPressOut}
            onPress={voxMode ? onMicTap : undefined}
            style={[styles.pttOuter, pressed && styles.pttOuterActive, (!channelId || !!floorHolder) && styles.pttOuterDisabled]}
          >
            <View style={[styles.pttInner, pressed && styles.pttInnerActive]}>
              <Ionicons name={floorHolder ? 'lock-closed' : 'mic'} size={MIC_ICON_SIZE} color={pressed ? '#fff' : floorHolder ? '#8E8E93' : channelId ? YELLOW : 'rgba(45,236,134,0.5)'} />
            </View>
          </Pressable>
        </Animated.View>
        </View>

        <Text style={[styles.pttLabel, (pressed || ptt.voxActive) && { color: YELLOW }]} numberOfLines={1}>
          {!channelId
            ? 'Pick a convoy to talk'
            : ptt.voxActive
            ? 'Hands-free · listening… (1s quiet sends)'
            : pressed
            ? 'Release to send'
            : floorHolder
            ? `${floorHolder.handle} has the mic`
            : voxMode
            ? 'Tap to talk · hands-free'
            : activeThread
            ? `Talk · ${activeThread.title}`
            : 'Hold to Talk'}
        </Text>

        {/* Hands-free (VOX) toggle — private threads only. When on, the mic is
            tap-to-open and a 3s-silence gap auto-sends the turn and closes. */}
        {activeThread && (
          <TouchableOpacity
            style={[styles.voxToggle, voxOn && styles.voxToggleOn]}
            activeOpacity={0.85}
            onPress={toggleVox}
          >
            <Ionicons name={voxOn ? 'radio' : 'hand-right'} size={14} color={voxOn ? '#000' : YELLOW} />
            <Text style={[styles.voxToggleText, voxOn && styles.voxToggleTextOn]}>
              {voxOn ? 'Hands-free on' : 'Hands-free off'}
            </Text>
          </TouchableOpacity>
        )}

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
                        {playingId === m.id ? (
                          <View style={styles.playingPill}>
                            <Ionicons name="volume-high" size={13} color={YELLOW} />
                          </View>
                        ) : (m.user_id !== user?.id && !commsRead.clipPlayed(m.id)) ? (
                          <View style={styles.unreadDot} />
                        ) : null}
                      </View>
                    </View>
                  ))}
                </ScrollView>
              )}
            </View>
          </>
        )}
      </View>

      {/* New-conversation picker — choose crew members to talk to privately. */}
      {pickerOpen && (
        <>
          <Pressable style={styles.pickerBackdrop} onPress={() => { setPickerOpen(false); }} />
          <View style={styles.pickerCard}>
            <Text style={styles.pickerTitle}>New conversation</Text>
            <Text style={styles.pickerSub}>
              Pick who to talk to privately. The same people always continue the same conversation.
            </Text>
            {roster.length === 0 ? (
              <Text style={styles.emptyTx}>No other members in this crew yet.</Text>
            ) : (
              <ScrollView style={{ maxHeight: 280 }} showsVerticalScrollIndicator={false}>
                {roster.map((m) => {
                  const on = picked.includes(m.id);
                  return (
                    <TouchableOpacity key={m.id} onPress={() => toggleMember(m.id)} style={styles.pickRow} activeOpacity={0.8}>
                      <View style={[styles.pickAvatar, on && styles.pickAvatarOn]}>
                        <Ionicons name="person" size={16} color={on ? '#000' : '#8E8E93'} />
                      </View>
                      <Text style={styles.pickName} numberOfLines={1}>{m.handle}</Text>
                      <Ionicons name={on ? 'checkmark-circle' : 'ellipse-outline'} size={22} color={on ? YELLOW : '#48484A'} />
                    </TouchableOpacity>
                  );
                })}
              </ScrollView>
            )}
            <TouchableOpacity
              style={[styles.startBtn, (picked.length === 0 || creating) && styles.startBtnDisabled]}
              disabled={picked.length === 0 || creating}
              onPress={startThread}
              activeOpacity={0.85}
            >
              <Text style={styles.startBtnText}>
                {creating ? 'Starting…' : picked.length > 1 ? `Start group · ${picked.length}` : 'Start conversation'}
              </Text>
            </TouchableOpacity>
          </View>
        </>
      )}

    </SafeAreaView>
    {/* Top-right logo — absolute, pixel-identical to Map/Music (positions
        relative to the full-screen tab container, no SafeArea padding offset). */}
    <View style={styles.logoBacking}><LogoMenu size={Platform.OS === 'ios' ? 34 : 40} align="right" /></View>
    </>
  );
}

// Comms mic sizing — on Android the mic + label + Hands-free + Recent Transmissions
// stack ran long enough that the Recent Transmissions pill hid behind the bottom
// tab bar. Shrink the mic on Android (and lift the stack via body.paddingBottom)
// so it clears the bar. iOS keeps the original 360. Tunable.
const MIC_D = Platform.OS === 'android' ? 300 : 360;
const MIC_INNER_D = Platform.OS === 'android' ? 242 : 290;
const MIC_ICON_SIZE = Platform.OS === 'android' ? 106 : 128;

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
    alignItems: 'center', justifyContent: 'center', borderWidth: 1, borderColor: 'rgba(45,236,134,0.45)',
    overflow: 'hidden',
  },
  avatarImg: { width: 42, height: 42 },
  communityName: { color: '#F4F4F4', fontSize: 17, fontWeight: '700' },
  subRow: { flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 2 },
  connected: { color: '#30D158', fontSize: 12 },
  connectedMuted: { color: '#808080', fontSize: 12, marginTop: 1 },
  tierPill: { flexDirection: 'row', alignItems: 'center', gap: 3, paddingHorizontal: 7, paddingVertical: 2, borderRadius: 8 },
  tierText: { fontSize: 11, fontWeight: '700', letterSpacing: 0.3 },
  chevBtn: { marginLeft: 4, padding: 2 },
  garageBtn: { padding: 4, marginLeft: 8 },
  logoBacking: {
    position: 'absolute', top: Platform.OS === 'ios' ? 47 : 28, right: 12, zIndex: 100,
    width: Platform.OS === 'ios' ? 46 : 54,
    height: Platform.OS === 'ios' ? 46 : 54,
    borderRadius: Platform.OS === 'ios' ? 23 : 27,
    alignItems: 'center', justifyContent: 'center',
    backgroundColor: 'rgba(20,20,22,0.9)',
    borderWidth: 1, borderColor: 'rgba(255,255,255,0.18)',
    shadowColor: '#000', shadowOpacity: 0.35, shadowRadius: 5, shadowOffset: { width: 0, height: 2 },
    elevation: 6,
  },
  shareCommBtn: { padding: 4, marginLeft: 4 },

  // Community switcher dropdown
  switcher: {
    marginHorizontal: 16, marginTop: 10,
    backgroundColor: '#161618', borderRadius: 18, padding: 12,
    borderWidth: 1, borderColor: '#2a2a2e',
    shadowColor: '#000', shadowOpacity: 0.5, shadowRadius: 18, shadowOffset: { width: 0, height: 8 }, elevation: 20,
  },
  switcherTitle: { color: '#808080', fontSize: 11, fontWeight: '700', letterSpacing: 0.7, textTransform: 'uppercase', marginBottom: 8, marginLeft: 2 },
  switcherRow: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 9 },
  switcherAvatar: { width: 38, height: 38, borderRadius: 12, backgroundColor: '#1c1c1e', alignItems: 'center', justifyContent: 'center', overflow: 'hidden' },
  switcherAvatarImg: { width: 38, height: 38 },
  switcherName: { color: '#F4F4F4', fontSize: 15, fontWeight: '600' },
  switcherMeta: { color: '#808080', fontSize: 12, marginTop: 1 },
  switcherActivePill: { backgroundColor: 'rgba(48,209,88,0.2)', paddingHorizontal: 8, paddingVertical: 3, borderRadius: 8 },
  switcherActiveText: { color: '#30D158', fontSize: 9, fontWeight: '700', letterSpacing: 0.5 },
  switcherEmpty: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingVertical: 10, paddingHorizontal: 2 },
  switcherEmptyText: { color: '#808080', fontSize: 13, flex: 1 },

  body: { flex: 1, alignItems: 'center', justifyContent: 'center', position: 'relative', paddingBottom: Platform.OS === 'android' ? 150 : 100 },

  micWrap: { width: MIC_D, height: MIC_D, alignItems: 'center', justifyContent: 'center', alignSelf: 'center' },
  glowWrap: { width: MIC_D, height: MIC_D, borderRadius: MIC_D / 2, alignItems: 'center', justifyContent: 'center', elevation: 18 },
  pttRing: {
    position: 'absolute',
    top: 0, left: 0, right: 0, bottom: 0,
    width: MIC_D, height: MIC_D, borderRadius: MIC_D / 2,
    borderWidth: 3, borderColor: YELLOW,
  },
  pttOuter: {
    width: MIC_D, height: MIC_D, borderRadius: MIC_D / 2, backgroundColor: '#0e0e10',
    alignItems: 'center', justifyContent: 'center', borderWidth: 6, borderColor: '#2a2a2e',
  },
  pttOuterActive: { borderColor: YELLOW },
  pttOuterDisabled: { opacity: 0.5 },
  pttInner: {
    width: MIC_INNER_D, height: MIC_INNER_D, borderRadius: MIC_INNER_D / 2, backgroundColor: '#141417',
    alignItems: 'center', justifyContent: 'center',
  },
  pttInnerActive: { backgroundColor: '#1f1b00' },
  pttLabel: { color: '#808080', fontSize: 16, fontWeight: '600', marginTop: 30, letterSpacing: 0.5 },
  // Hands-free (VOX) toggle pill, shown under the mic label on private threads.
  voxToggle: {
    flexDirection: 'row', alignItems: 'center', gap: 7,
    paddingHorizontal: 14, paddingVertical: 8, borderRadius: 999,
    backgroundColor: '#161618', borderWidth: 1, borderColor: 'rgba(45,236,134,0.4)',
    marginTop: 14,
  },
  voxToggleOn: { backgroundColor: YELLOW, borderColor: YELLOW },
  voxToggleText: { color: YELLOW, fontSize: 13, fontWeight: '700' },
  voxToggleTextOn: { color: '#000' },

  dropdown: {
    position: 'absolute', top: 12, left: 16, right: 16,
    backgroundColor: '#161618', borderRadius: 22, padding: 16,
    borderWidth: 1, borderColor: '#2a2a2e',
    shadowColor: '#000', shadowOpacity: 0.55, shadowRadius: 24, shadowOffset: { width: 0, height: 10 }, elevation: 24,
  },
  dropdownTitle: { color: '#F4F4F4', fontSize: 13, fontWeight: '700', marginBottom: 10, textTransform: 'uppercase', letterSpacing: 0.7 },
  dropdownHeaderRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  sendingText: { color: YELLOW, fontSize: 12, fontWeight: '600', marginBottom: 10 },
  emptyTx: { color: '#808080', fontSize: 13, lineHeight: 18, paddingVertical: 4 },
  playingPill: { paddingHorizontal: 8, paddingVertical: 5, borderRadius: 8, backgroundColor: 'rgba(45,236,134,0.12)' },
  convoRow: { paddingVertical: 11, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: '#262629' },
  convoTop: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  playBtn: { width: 40, height: 40, borderRadius: 20, backgroundColor: YELLOW, alignItems: 'center', justifyContent: 'center' },
  convoSpeaker: { color: '#F4F4F4', fontSize: 15, fontWeight: '600' },
  convoMeta: { color: '#808080', fontSize: 12, marginTop: 1 },

  // ----- Recent Transmissions: toggle pill + tap-away sheet + swipe rows -----
  txToggle: {
    flexDirection: 'row', alignItems: 'center', gap: 8,
    paddingHorizontal: 16, paddingVertical: 10, borderRadius: 22,
    backgroundColor: '#161618', borderWidth: 1, borderColor: '#2a2a2e',
    marginTop: 26,
  },
  txToggleText: { color: '#F4F4F4', fontSize: 13, fontWeight: '600' },
  txSending: { color: YELLOW, fontSize: 12, fontWeight: '600' },
  txBackdrop: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, zIndex: 20 },
  txSheet: {
    position: 'absolute', bottom: 96, left: 16, right: 16, zIndex: 30,
    backgroundColor: '#161618', borderRadius: 20, paddingHorizontal: 12, paddingTop: 14, paddingBottom: 6,
    borderWidth: 1, borderColor: '#2a2a2e',
    shadowColor: '#000', shadowOpacity: 0.55, shadowRadius: 24, shadowOffset: { width: 0, height: 10 }, elevation: 24,
  },
  txSheetTitle: { color: '#F4F4F4', fontSize: 13, fontWeight: '700', textTransform: 'uppercase', letterSpacing: 0.7, marginBottom: 6, marginLeft: 4 },

  dismissOverlay: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0 },

  // ----- Conversation strip (Crew + private threads + New) -----
  stripWrap: { paddingTop: 10, paddingBottom: 2 },
  stripTitle: { color: '#F4F4F4', fontSize: 13, fontWeight: '700', marginLeft: 16, marginBottom: 8, letterSpacing: 0.2 },
  strip: { paddingHorizontal: 16, gap: 8, alignItems: 'center' },
  chip: {
    flexDirection: 'row', alignItems: 'center', gap: 6,
    paddingHorizontal: 13, paddingVertical: 8, borderRadius: 18,
    backgroundColor: '#161618', borderWidth: 1, borderColor: '#2a2a2e', maxWidth: 200,
  },
  chipActive: { backgroundColor: YELLOW, borderColor: YELLOW },
  chipText: { color: '#F4F4F4', fontSize: 13, fontWeight: '600', flexShrink: 1 },
  chipTextActive: { color: '#000' },
  chipNew: {
    flexDirection: 'row', alignItems: 'center', gap: 4,
    paddingHorizontal: 13, paddingVertical: 8, borderRadius: 18,
    backgroundColor: 'rgba(45,236,134,0.12)', borderWidth: 1, borderColor: 'rgba(45,236,134,0.4)',
  },
  chipNewText: { color: YELLOW, fontSize: 13, fontWeight: '700' },
  chipDot: { width: 8, height: 8, borderRadius: 4, backgroundColor: YELLOW, marginLeft: 1 },
  unreadDot: { width: 9, height: 9, borderRadius: 5, backgroundColor: YELLOW },

  // ----- New-conversation picker -----
  pickerBackdrop: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, backgroundColor: 'rgba(0,0,0,0.55)', zIndex: 40 },
  pickerCard: {
    position: 'absolute', top: '18%', left: 16, right: 16, zIndex: 50,
    backgroundColor: '#161618', borderRadius: 20, padding: 16,
    borderWidth: 1, borderColor: '#2a2a2e',
    shadowColor: '#000', shadowOpacity: 0.55, shadowRadius: 24, shadowOffset: { width: 0, height: 10 }, elevation: 24,
  },
  pickerTitle: { color: '#F4F4F4', fontSize: 17, fontWeight: '700' },
  pickerSub: { color: '#808080', fontSize: 13, lineHeight: 18, marginTop: 4, marginBottom: 10 },
  pickRow: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 9 },
  pickAvatar: { width: 36, height: 36, borderRadius: 18, backgroundColor: '#1c1c1e', alignItems: 'center', justifyContent: 'center' },
  pickAvatarOn: { backgroundColor: YELLOW },
  pickName: { color: '#F4F4F4', fontSize: 15, fontWeight: '600', flex: 1 },
  startBtn: { marginTop: 12, backgroundColor: YELLOW, borderRadius: 14, paddingVertical: 13, alignItems: 'center' },
  startBtnDisabled: { opacity: 0.4 },
  startBtnText: { color: '#000', fontSize: 15, fontWeight: '700' },

  // ----- "X is talking" indicator above the mic -----
  talkingWrap: { height: 34, alignItems: 'center', justifyContent: 'center', marginBottom: 4 },
  talkingPill: {
    flexDirection: 'row', alignItems: 'center', gap: 7,
    paddingHorizontal: 14, paddingVertical: 8, borderRadius: 999,
    backgroundColor: 'rgba(28,28,30,0.92)', borderWidth: StyleSheet.hairlineWidth, borderColor: 'rgba(255,106,0,0.55)',
  },
  talkingText: { color: '#F4F4F4', fontSize: 13, fontWeight: '700', letterSpacing: 0.2 },
});
