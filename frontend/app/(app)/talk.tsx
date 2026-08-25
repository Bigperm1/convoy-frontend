import React, { useState, useRef, useEffect, useCallback } from 'react';
import {
  View, Text, StyleSheet, Pressable, TouchableOpacity, Animated,
  ScrollView, Easing, Image, Alert, Platform,
} from 'react-native';
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';
import * as Haptics from 'expo-haptics';
import { Audio } from 'expo-av';
import { Ionicons } from '@expo/vector-icons';
import { useRouter, useFocusEffect } from 'expo-router';
import LogoMenu from '../../src/components/LogoMenu';
import { GlassFill } from '../../src/Glass';
import GlassBackdrop from '../../src/components/GlassBackdrop';
import { getSettings, getAudioVol } from '../../src/settings';
import { shareInbox } from '../../src/shareInbox';
import { api } from '../../src/api';
import { useAuth } from '../../src/auth';
import { useSettings } from '../../src/settings';
import { useLatestTier, type ProximityTier } from '../../src/proximityAudio';
import { usePttChannel, type PTTMessage } from '../../src/pttChannel';
import { ensureMicPermission, ensureNotificationPermission } from '../../src/permissionGate';
import { registerPushToken } from '../../src/pushRegistration';
import { livePttBus, setCommsScreenFocused, acquireFloor, releaseFloor, getFloorHolder, floorBus, threadBus } from '../../src/livePtt';
import { commsRead } from '../../src/commsRead';
import { setPlaybackAudioMode, setIdleAudioMode } from '../../src/audioMode';
import { useAccent, useAccentAlpha, useAppSkin } from '../../src/appSkin';

const YELLOW = '#2DEC86';

// ── THE MIC WEARS THE APP SKIN (Jeff, 2026-08-25) ────────────────────────────
// "the comms page needs to be silver and gold too including the wallpaper."
// The halo is a pre-rendered DONUT png and the pressed mic face is a baked candy
// gradient — neither can ride a tintColor, so the skin needs its own baked pairs or
// the mic would stay green on a gold page while everything around it moved. Both are
// hue-rotations of the same artwork (green sits at ~145deg -> ultra's 40deg; silver is
// desaturated and lifted). mic_chrome (the UNPRESSED face) is already neutral grey and
// is skin-independent by construction. New asset paths on purpose (OTA path-key trap).
const MIC_GLOW = {
  brand:   require('../../assets/images/mic-glow.png'),
  premium: require('../../assets/images/mic-glow_silver.png'),
  ultra:   require('../../assets/images/mic-glow_gold.png'),
} as const;
const MIC_CANDY = {
  brand:   require('../../assets/images/premium/mic_candy.png'),
  premium: require('../../assets/images/premium/mic_candy_silver.png'),
  ultra:   require('../../assets/images/premium/mic_candy_gold.png'),
} as const;

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
  // App skin (silver at Premium, gold at Ultra) for the chrome on this screen.
  // One hook per distinct alpha — the tint stays a tint, never a solid disc.
  const accent = useAccent();
  const skinTier = useAppSkin();
  const accentTint = useAccentAlpha(0.12);
  const accentEdge = useAccentAlpha(0.4);
  const accentRing = useAccentAlpha(0.45);

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

  // The tab bar is position:absolute (see (app)/_layout.tsx) with height
  // (ios 86 / android 84) + the android system-nav inset, so it overlays the
  // bottom of this screen. The Recent Transmissions sheet is bottom-anchored, so
  // it must clear that bar or it hides behind it on Android (where the nav-bar
  // inset makes the bar taller than the old fixed 96). iOS resolves to 96 as
  // before; Android adds insets.bottom.
  const insets = useSafeAreaInsets();
  const txSheetBottom =
    (Platform.OS === 'ios' ? 86 : 84) + (Platform.OS === 'android' ? insets.bottom : 0) + 10;

  // The active community = the one whose id matches settings.activeCommunityId.
  const active = communities.find((c) => c.id === settings.activeCommunityId);

  // A private thread can be selected as the active conversation. When one is
  // picked we transmit to JUST its participants; otherwise we talk to the whole
  // crew (the community channel). channelId is what every layer keys on: the
  // PTT hook, the history list, and the global live listener.
  // OPTIMISTIC SELECTION (2026-07-24). The chip used to read `settings` directly, so
  // the whole strip only responded once the settings listener fired — and on Android
  // that made a registered tap look completely dead ("the comms threads they cant use
  // or touch it only stays on crew"). updateSettings no longer blocks on its disk
  // write, which fixes the known cause, but the strip should not depend on settings
  // propagation AT ALL to acknowledge a touch: this is the one control a driver uses
  // to pick who hears them.
  // `pendingThreadId === undefined` means "no local override, follow settings".
  // null is a REAL value here (Crew), which is why undefined is the sentinel.
  const [pendingThreadId, setPendingThreadId] = useState<string | null | undefined>(undefined);
  const activeThreadId = pendingThreadId !== undefined ? pendingThreadId : (settings.activeThreadId ?? null);
  const activeThread = threads.find((t) => t.id === activeThreadId) || null;
  const channelId = activeThreadId || active?.id || null;
  // Drop the override once settings agrees. If settings never catches up the override
  // simply stands — which is the point: the driver's explicit choice wins over a
  // storage layer that is not answering.
  useEffect(() => {
    if (pendingThreadId !== undefined && (settings.activeThreadId ?? null) === pendingThreadId) {
      setPendingThreadId(undefined);
    }
  }, [settings.activeThreadId, pendingThreadId]);

  // Real PTT send + history for the active channel (crew OR private thread),
  // recorded at a quality that scales with convoy proximity.
  const ptt = usePttChannel(channelId, tier);

  // Load the user's joined communities. Reloads on focus so a community
  // created/joined in the Hub shows up when the user returns to Comms.
  const loadCommunities = useCallback(async () => {
    try {
      const { data } = await api.get('/communities/mine');
      const list = Array.isArray(data) ? data : [];
      setCommunities(list);
      // ANDROID TESTER FIX (2026-07-17): activeCommunityId lives in LOCAL
      // AsyncStorage — it never syncs to a new device. A fresh install (or a
      // stale id after leaving a club) rendered Comms in a DEAD state: the
      // threads strip is gated on `active`, so the chats the tester belongs to
      // never showed ("can't click into my chats"), and New only toggled the
      // club dropdown ("can't create a chat"). If the saved id is missing or
      // no longer one of their clubs, auto-activate the first club so Comms
      // always lands usable. (getSettings() — not the hook value — so this
      // reads the LIVE id even inside the stable callback.)
      const cur = getSettings().activeCommunityId;
      if (list.length > 0 && !list.some((c) => c.id === cur)) {
        setSettings({ activeCommunityId: list[0].id, activeThreadId: null });
      }
    } catch { /* keep last known list */ }
  }, [setSettings]);

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
    //
    // NOTIFICATIONS ARE ALSO ASKED HERE (2026-07-25), not at login. Push on this
    // app means hails and crew messages, so Comms is the screen where the ask
    // makes sense — and asking on login is what stacked every dialog at once
    // ("bombarded with the allows right when you login"). Both go through
    // src/permissionGate.ts, which serializes prompts with a gap, so the mic
    // sheet is fully dismissed before the notification sheet appears. Awaiting
    // the mic call first also fixes the ORDER: mic is what this screen actually
    // needs, so it is asked first and notifications follow.
    // Once notifications are granted we register the push token immediately,
    // because login no longer does it for a first-launch user.
    (async () => {
      await ensureMicPermission();
      const status = await ensureNotificationPermission();
      if (status === 'granted') void registerPushToken();
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
    if (pressed || ptt.voxActive) {
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
  }, [pressed, ptt.voxActive]);

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
  // Set the local override FIRST so the chip moves on this frame, then persist.
  const selectCrew = () => {
    Haptics.selectionAsync().catch(() => {});
    setPendingThreadId(null);
    setSettings({ activeThreadId: null });
  };
  const selectThread = (t: Thread) => {
    Haptics.selectionAsync().catch(() => {});
    setPendingThreadId(t.id);
    setSettings({ activeThreadId: t.id });
  };

  // ----- Delete a private conversation (hold-to-delete) -----
  // Long-pressing a thread chip removes the whole conversation. The backend
  // deletes it for EVERY participant (server-side) and fans out a
  // `thread_deleted` frame, so the other members' inboxes drop it live too.
  // The Crew chip is a community channel (not a thread), so it has no
  // long-press affordance and can never be deleted here.
  const removeThreadLocal = useCallback((id: string) => {
    setThreads((prev) => prev.filter((t) => t.id !== id));
    // If we were viewing the deleted thread, fall back to the Crew channel. Checks the
    // EFFECTIVE selection (override included), or deleting a just-tapped thread would
    // leave the strip pointing at a conversation that no longer exists.
    if (activeThreadId === id) { setPendingThreadId(null); setSettings({ activeThreadId: null }); }
  }, [activeThreadId, setSettings]);

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
        { shouldPlay: true, volume: getAudioVol(getSettings(), "volTransmission") },
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
      void setIdleAudioMode(); // replay failed AFTER ducking → release so music recovers
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
      <GlassBackdrop />
      {/* Community header — live active convoy */}
      <View style={styles.header}>
        {active ? (
          <Pressable style={styles.communityBtn} onPress={toggleDropdown}>
            <View style={[styles.avatar, { borderColor: accentRing }]}>
              {active.logo_b64 ? (
                <Image source={{ uri: active.logo_b64 }} style={styles.avatarImg} />
              ) : (
                <Ionicons name="people" size={20} color={accent} />
              )}
            </View>
            <View style={{ flexShrink: 1 }}>
              <Text style={styles.communityName} numberOfLines={1}>{active.name}</Text>
              <View style={styles.subRow}>
                <Text style={[styles.connected, { color: accent }]}>{connectedText}</Text>
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
            <View style={[styles.avatar, { borderColor: accentRing }]}>
              <Ionicons name="people" size={20} color="#8E8E93" />
            </View>
            <View style={{ flexShrink: 1 }}>
              <Text style={styles.communityName} numberOfLines={1}>
                {communities.length ? 'Choose your convoy' : 'No clubs yet'}
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
          <Text style={styles.switcherTitle}>Your clubs</Text>
          {communities.length === 0 ? (
            <TouchableOpacity onPress={() => { setDropdownOpen(false); router.push('/(app)/hub'); }} style={styles.switcherEmpty}>
              <Ionicons name="add-circle-outline" size={18} color={accent} />
              <Text style={styles.switcherEmptyText}>Go to the Hub to create or join a club</Text>
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
                        <Ionicons name="people" size={18} color={isActive ? accent : '#8E8E93'} />
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
      {(active || threads.length > 0) && !dropdownOpen && (
        <View style={styles.stripWrap} collapsable={false}>
          <Text style={styles.stripTitle}>Comms Threads</Text>
          {/* Horizontal scroller — the ORIGINAL design, restored. It was briefly
              replaced with wrapped rows while chasing the dead-chip bug; the real
              cause turned out to be the mic glow covering the strip (see the
              pointerEvents note on micGlowWrap), not the ScrollView. */}
          <ScrollView
            horizontal
            showsHorizontalScrollIndicator={false}
            contentContainerStyle={styles.strip}
          >
            {active ? (
              <Pressable onPress={selectCrew} style={({ pressed }) => [styles.chip, !activeThreadId && [styles.chipActive, { backgroundColor: accent, borderColor: accent }], pressed && { opacity: 0.85 }]}>
                <Ionicons name="people" size={15} color={!activeThreadId ? '#000' : accent} />
                <Text style={[styles.chipText, !activeThreadId && styles.chipTextActive]} numberOfLines={1}>Crew</Text>
                {!!activeThreadId && !!active && commsRead.channelHasUnread(active.id) && <View style={[styles.chipDot, { backgroundColor: accent }]} />}
              </Pressable>
            ) : null}
            {threads.map((t) => {
              const on = t.id === activeThreadId;
              return (
                <Pressable key={t.id} onPress={() => selectThread(t)} onLongPress={() => confirmDeleteThread(t)} delayLongPress={400} style={({ pressed }) => [styles.chip, on && [styles.chipActive, { backgroundColor: accent, borderColor: accent }], pressed && { opacity: 0.85 }]}>
                  <Ionicons name={t.is_group ? 'people-circle' : 'person'} size={15} color={on ? '#000' : '#bbb'} />
                  <Text style={[styles.chipText, on && styles.chipTextActive]} numberOfLines={1}>{t.title}</Text>
                  {!on && commsRead.channelHasUnread(t.id) && <View style={[styles.chipDot, { backgroundColor: accent }]} />}
                </Pressable>
              );
            })}
            <Pressable onPress={openThreadPicker} style={({ pressed }) => [styles.chipNew, { backgroundColor: accentTint, borderColor: accentEdge }, pressed && { opacity: 0.85 }]}>
              <Ionicons name="add" size={16} color={accent} />
              <Text style={[styles.chipNewText, { color: accent }]}>New</Text>
            </Pressable>
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
        {/* Soft green glow halo AROUND the mic while pushed (or hands-free) — a radial
            gradient that breathes with the `glow` value. Deliberately DISTINCT from the
            Scout screen-edge glow: this one hugs the button; the edge glow frames the
            whole screen. Replaces the old smoke cloud + sonar ring. */}
        {/* pointerEvents on a WRAPPER VIEW, not in the image's style. The glow is a
            516pt box anchored 108pt ABOVE the mic (top: (MIC_D - GLOW_D) / 2), so it
            reaches far up the screen and lands on the thread chips: with the mic at
            y811 its top edge is y~514 and the second chip row spans 513..607. Style-
            level pointerEvents is not reliably applied on Android, so this fully
            transparent glow was swallowing every touch beneath it — and with a
            one-row strip the mic sat higher (y687 -> glow top ~390), covering the
            WHOLE strip, which is why no chip responded at all. Animated.Image does
            not accept a pointerEvents prop, hence the wrapper. */}
        <View pointerEvents="none" style={styles.micGlowWrap}>
          <Animated.Image
            source={MIC_GLOW[skinTier]}
            resizeMode="contain"
            style={[styles.micGlowImg, { opacity: glowOpacity }]}
          />
        </View>
        <Animated.View
          style={[
            styles.glowWrap,
            { transform: [{ scale }] },
          ]}
        >
          <Pressable
            onPressIn={voxMode ? undefined : onPressIn}
            onPressOut={voxMode ? undefined : onPressOut}
            onPress={voxMode ? onMicTap : undefined}
            style={[styles.pttOuter, pressed && styles.pttOuterActive, (!channelId || !!floorHolder) && styles.pttOuterDisabled]}
          >
            {/* Liquid Glass mic — the outer circle is real glass; the inner disc keeps
                contrast for the mic glyph. */}
            <GlassFill style={{ borderRadius: MIC_D / 2, overflow: 'hidden' }} />
            <View style={[styles.pttInner, pressed && styles.pttInnerActive]}>
              {/* Premium mic (8/20, the CarPlay-glyph language): chrome at rest,
                  candy green while TRANSMITTING (pressed or VOX-live) — the state
                  reads at a glance without a colour legend. Floor-locked keeps the
                  lock glyph; no channel dims the chrome. */}
              {floorHolder ? (
                <Ionicons name="lock-closed" size={MIC_ICON_SIZE} color="#8E8E93" />
              ) : (
                <Image
                  source={(pressed || ptt.voxActive)
                    ? MIC_CANDY[skinTier]
                    : require('../../assets/images/premium/mic_chrome.png')}
                  style={{ width: MIC_ICON_SIZE, height: MIC_ICON_SIZE, opacity: channelId ? 1 : 0.45 }}
                  resizeMode="contain"
                />
              )}
            </View>
          </Pressable>
        </Animated.View>
        </View>

        <Text style={[styles.pttLabel, (pressed || ptt.voxActive) && { color: accent }]} numberOfLines={1}>
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
            style={[styles.voxToggle, { borderColor: accentEdge }, voxOn && [styles.voxToggleOn, { backgroundColor: accent, borderColor: accent }]]}
            activeOpacity={0.85}
            onPress={toggleVox}
          >
            <Ionicons name={voxOn ? 'radio' : 'hand-right'} size={14} color={voxOn ? '#000' : accent} />
            <Text style={[styles.voxToggleText, { color: accent }, voxOn && styles.voxToggleTextOn]}>
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
            <Ionicons name="radio" size={15} color={accent} />
            <Text style={styles.txToggleText}>
              Recent Transmissions{ptt.history.length ? `  ·  ${ptt.history.length}` : ''}
            </Text>
            {ptt.sending && <Text style={[styles.txSending, { color: accent }]}>Sending…</Text>}
            <Ionicons name={txOpen ? 'chevron-down' : 'chevron-up'} size={16} color="#888" />
          </TouchableOpacity>
        )}

        {/* Tap-away backdrop + the transmissions sheet. The backdrop fills the
            screen so a tap ANYWHERE off the sheet closes it (the mic sits under
            it while open; close first to transmit). */}
        {active && !dropdownOpen && txOpen && (
          <>
            <Pressable style={styles.txBackdrop} onPress={() => { setTxOpen(false); }} />
            <View style={[styles.txSheet, { bottom: txSheetBottom }]}>
              <Text style={styles.txSheetTitle}>Recent Transmissions</Text>
              {ptt.history.length === 0 ? (
                <Text style={styles.emptyTx}>No transmissions yet. Hold the mic to talk to your crew.</Text>
              ) : (
                <ScrollView style={{ maxHeight: 300 }} showsVerticalScrollIndicator={false}>
                  {ptt.history.map((m) => (
                    <View key={m.id} style={styles.convoRow}>
                      <View style={styles.convoTop}>
                        <TouchableOpacity onPress={() => playConvo(m)} style={[styles.playBtn, { backgroundColor: accent }]} activeOpacity={0.8}>
                          <Ionicons name={playingId === m.id ? 'pause' : 'play'} size={18} color="#000" />
                        </TouchableOpacity>
                        <View style={{ flex: 1 }}>
                          <Text style={styles.convoSpeaker} numberOfLines={1}>{m.handle || 'Driver'}</Text>
                          <Text style={styles.convoMeta}>{fmtClock(m.created_at)} · {fmtDur(m.duration_ms)}</Text>
                        </View>
                        {playingId === m.id ? (
                          <View style={[styles.playingPill, { backgroundColor: accentTint }]}>
                            <Ionicons name="volume-high" size={13} color={accent} />
                          </View>
                        ) : (m.user_id !== user?.id && !commsRead.clipPlayed(m.id)) ? (
                          <View style={[styles.unreadDot, { backgroundColor: accent }]} />
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
                      <View style={[styles.pickAvatar, on && [styles.pickAvatarOn, { backgroundColor: accent }]]}>
                        <Ionicons name="person" size={16} color={on ? '#000' : '#8E8E93'} />
                      </View>
                      <Text style={styles.pickName} numberOfLines={1}>{m.handle}</Text>
                      <Ionicons name={on ? 'checkmark-circle' : 'ellipse-outline'} size={22} color={on ? accent : '#48484A'} />
                    </TouchableOpacity>
                  );
                })}
              </ScrollView>
            )}
            <TouchableOpacity
              style={[styles.startBtn, { backgroundColor: accent }, (picked.length === 0 || creating) && styles.startBtnDisabled]}
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
    <View style={styles.logoBacking}><LogoMenu size={38} align="right" /></View>
    </>
  );
}

// Comms mic sizing — on Android the mic + label + Hands-free + Recent Transmissions
// stack ran long enough that the Recent Transmissions pill hid behind the bottom
// tab bar. Shrink the mic on Android (and lift the stack via body.paddingBottom)
// so it clears the bar. iOS keeps the original 360. Tunable.
const MIC_D = Platform.OS === 'android' ? 300 : 360;
// Button-glow diameter. The glow is a pre-rendered DONUT png (mic-glow.png): transparent
// in the center so the mic stays clean (nothing bleeds through the glass), glowing only
// OUTSIDE the ring and fading outward toward the screen edges. 1.72× sizes the donut so its
// transparent hole lands on the mic edge (no dark gap, no green inside). A bitmap renders
// perfectly soft — react-native-svg radial gradients came out hard/ring-y.
const GLOW_D = Math.round(MIC_D * 1.72);
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
    // Identical to the map's logo button (mapLogoBacking) so it never jumps between tabs.
    position: 'absolute', top: Platform.OS === 'ios' ? 52 : 28, right: 12, zIndex: 100,
    width: 50,
    height: 50,
    borderRadius: 14,
    overflow: 'hidden',
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
  // Halo glow sits BEHIND the mic, centered on it (GLOW_D box centered in the MIC_D micWrap).
  micGlowWrap: { position: 'absolute', width: GLOW_D, height: GLOW_D, top: (MIC_D - GLOW_D) / 2, left: (MIC_D - GLOW_D) / 2 },
  micGlowImg: { width: '100%', height: '100%' },
  pttRing: {
    position: 'absolute',
    top: 0, left: 0, right: 0, bottom: 0,
    width: MIC_D, height: MIC_D, borderRadius: MIC_D / 2,
    borderWidth: 3, borderColor: YELLOW,
  },
  pttOuter: {
    width: MIC_D, height: MIC_D, borderRadius: MIC_D / 2, backgroundColor: 'transparent',
    alignItems: 'center', justifyContent: 'center', borderWidth: 6, borderColor: '#2a2a2e',
  },
  // Pressed feedback is the soft outward glow ONLY — drop the button's ring entirely so
  // there's no hard line at all (was borderColor YELLOW = a bright hard ring on press; even
  // the neutral dark ring read as a hard edge). The button dissolves into the glow.
  pttOuterActive: { borderWidth: 0 },
  pttOuterDisabled: { opacity: 0.5 },
  pttInner: {
    width: MIC_INNER_D, height: MIC_INNER_D, borderRadius: MIC_INNER_D / 2, backgroundColor: 'transparent',
    alignItems: 'center', justifyContent: 'center',
  },
  pttInnerActive: {},
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
