import React, { useState, useRef, useEffect } from 'react';
import {
  View, Text, StyleSheet, Pressable, TouchableOpacity, Animated,
  SafeAreaView, ScrollView, Easing,
} from 'react-native';
import * as Haptics from 'expo-haptics';
import { Audio } from 'expo-av';
import { Ionicons } from '@expo/vector-icons';
import { useRouter } from 'expo-router';

const YELLOW = '#FFD60A';

type Convo = {
  id: string;
  speaker: string;
  time: string;
  duration: string;
  transcript: string;
};

const COMMUNITIES = ['Austin Dispatch', 'ATX Drivers', 'Night Convoy'];

// Placeholder transmissions — wire to the comms backend (audio URIs + speech-to-text) when ready.
const CONVERSATIONS: Convo[] = [
  { id: '1', speaker: 'Alfredo Villegas', time: '11:02 AM', duration: '0:06', transcript: 'Heading north on I-35, traffic is clear past the exit.' },
  { id: '2', speaker: 'Anna Stanley',    time: '11:09 AM', duration: '0:04', transcript: 'Urgent: gate code needed for the delivery at the south dock.' },
  { id: '3', speaker: 'Cheryl Campbell',  time: '11:12 AM', duration: '0:08', transcript: 'Copy that, rolling up now. Boxes are stacked and ready.' },
];

export default function TalkScreen() {
  const router = useRouter();
  const [pressed, setPressed] = useState(false);
  const [dropdownOpen, setDropdownOpen] = useState(false);
  const [community, setCommunity] = useState(COMMUNITIES[0]);
  const [playingId, setPlayingId] = useState<string | null>(null);
  const [openTranscript, setOpenTranscript] = useState<string | null>(null);

  const glow = useRef(new Animated.Value(0)).current;
  const scale = useRef(new Animated.Value(1)).current;
  const askedMic = useRef(false);

  useEffect(() => {
    if (pressed) {
      Animated.timing(scale, { toValue: 1.05, duration: 130, useNativeDriver: false }).start();
      Animated.loop(
        Animated.sequence([
          Animated.timing(glow, { toValue: 1, duration: 650, easing: Easing.inOut(Easing.ease), useNativeDriver: false }),
          Animated.timing(glow, { toValue: 0.45, duration: 650, easing: Easing.inOut(Easing.ease), useNativeDriver: false }),
        ])
      ).start();
    } else {
      glow.stopAnimation();
      Animated.timing(scale, { toValue: 1, duration: 130, useNativeDriver: false }).start();
      Animated.timing(glow, { toValue: 0, duration: 200, useNativeDriver: false }).start();
    }
  }, [pressed]);

  const onPressIn = () => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Heavy);
    // Ask for mic permission the first time the user actually transmits.
    if (!askedMic.current) {
      askedMic.current = true;
      Audio.requestPermissionsAsync().catch(() => {});
    }
    setDropdownOpen(false);
    setPressed(true);
  };
  const onPressOut = () => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    setPressed(false);
  };

  const toggleDropdown = () => { Haptics.selectionAsync(); setDropdownOpen((o) => !o); };
  const cycleCommunity = () => {
    Haptics.selectionAsync();
    const i = COMMUNITIES.indexOf(community);
    setCommunity(COMMUNITIES[(i + 1) % COMMUNITIES.length]);
  };
  const playConvo = (id: string) => { Haptics.selectionAsync(); setPlayingId((p) => (p === id ? null : id)); };
  const transcribe = (id: string) => { Haptics.selectionAsync(); setOpenTranscript((t) => (t === id ? null : id)); };

  const glowOpacity = glow.interpolate({ inputRange: [0, 1], outputRange: [0, 0.95] });

  return (
    <SafeAreaView style={styles.safe}>
      {/* Community header */}
      <View style={styles.header}>
        <Pressable style={styles.communityBtn} onPress={cycleCommunity}>
          <View style={styles.avatar}>
            <Ionicons name="people" size={20} color={YELLOW} />
          </View>
          <View style={{ flexShrink: 1 }}>
            <Text style={styles.communityName} numberOfLines={1}>{community}</Text>
            <Text style={styles.connected}>13 connected</Text>
          </View>
          <TouchableOpacity onPress={toggleDropdown} hitSlop={12} style={styles.chevBtn}>
            <Ionicons name={dropdownOpen ? 'chevron-up' : 'chevron-down'} size={20} color="#fff" />
          </TouchableOpacity>
        </Pressable>
        <TouchableOpacity onPress={() => router.push('/(app)/garage')} hitSlop={12} style={styles.garageBtn}>
          <Ionicons name="car-sport" size={26} color={YELLOW} />
        </TouchableOpacity>
      </View>

      {/* Body */}
      <View style={styles.body}>
        <Animated.View
          style={[
            styles.glowWrap,
            {
              transform: [{ scale }],
              shadowColor: YELLOW,
              shadowOpacity: glowOpacity,
              shadowRadius: 34,
              shadowOffset: { width: 0, height: 0 },
            },
          ]}
        >
          <Pressable onPressIn={onPressIn} onPressOut={onPressOut} style={[styles.pttOuter, pressed && styles.pttOuterActive]}>
            <View style={[styles.pttInner, pressed && styles.pttInnerActive]}>
              <Ionicons name="mic" size={96} color={pressed ? YELLOW : '#fff'} />
            </View>
          </Pressable>
        </Animated.View>

        <Text style={[styles.pttLabel, pressed && { color: YELLOW }]}>
          {pressed ? 'Release to send' : 'Hold to Talk'}
        </Text>

        {/* Conversations dropdown — drops in front of the mic */}
        {dropdownOpen && (
          <View style={styles.dropdown}>
            <Text style={styles.dropdownTitle}>Recent Transmissions</Text>
            <ScrollView style={{ maxHeight: 360 }} showsVerticalScrollIndicator={false}>
              {CONVERSATIONS.map((c) => (
                <View key={c.id} style={styles.convoRow}>
                  <View style={styles.convoTop}>
                    <TouchableOpacity onPress={() => playConvo(c.id)} style={styles.playBtn} activeOpacity={0.8}>
                      <Ionicons name={playingId === c.id ? 'pause' : 'play'} size={18} color="#000" />
                    </TouchableOpacity>
                    <View style={{ flex: 1 }}>
                      <Text style={styles.convoSpeaker} numberOfLines={1}>{c.speaker}</Text>
                      <Text style={styles.convoMeta}>{c.time} · {c.duration}</Text>
                    </View>
                    <TouchableOpacity onPress={() => transcribe(c.id)} style={styles.transcribeBtn} activeOpacity={0.8}>
                      <Ionicons name="document-text-outline" size={15} color={YELLOW} />
                      <Text style={styles.transcribeText}>Transcribe</Text>
                    </TouchableOpacity>
                  </View>
                  {openTranscript === c.id && (
                    <Text style={styles.transcript}>“{c.transcript}”</Text>
                  )}
                </View>
              ))}
            </ScrollView>
          </View>
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
  },
  communityName: { color: '#fff', fontSize: 17, fontWeight: '700' },
  connected: { color: '#30D158', fontSize: 12, marginTop: 1 },
  chevBtn: { marginLeft: 4, padding: 2 },
  garageBtn: { padding: 4, marginLeft: 8 },

  body: { flex: 1, alignItems: 'center', justifyContent: 'center', position: 'relative' },

  glowWrap: { borderRadius: 150, elevation: 18 },
  pttOuter: {
    width: 280, height: 280, borderRadius: 140, backgroundColor: '#0e0e10',
    alignItems: 'center', justifyContent: 'center', borderWidth: 5, borderColor: '#2a2a2e',
  },
  pttOuterActive: { borderColor: YELLOW },
  pttInner: {
    width: 224, height: 224, borderRadius: 112, backgroundColor: '#141417',
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
  convoRow: { paddingVertical: 11, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: '#262629' },
  convoTop: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  playBtn: { width: 40, height: 40, borderRadius: 20, backgroundColor: YELLOW, alignItems: 'center', justifyContent: 'center' },
  convoSpeaker: { color: '#fff', fontSize: 15, fontWeight: '600' },
  convoMeta: { color: '#888', fontSize: 12, marginTop: 1 },
  transcribeBtn: { flexDirection: 'row', alignItems: 'center', gap: 4, paddingHorizontal: 9, paddingVertical: 7, borderRadius: 9, backgroundColor: 'rgba(255,214,10,0.12)' },
  transcribeText: { color: YELLOW, fontSize: 12, fontWeight: '600' },
  transcript: { color: '#bbb', fontSize: 13, fontStyle: 'italic', marginTop: 9, marginLeft: 52, lineHeight: 18 },
});
