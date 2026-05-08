import React, { useState, useEffect, useRef } from "react";
import { View, Text, StyleSheet, TouchableOpacity, Image, Animated, ScrollView } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { SafeAreaView } from "react-native-safe-area-context";
import { COLORS } from "../../src/theme";

type Source = "spotify" | "apple" | "soundcloud";

const TRACKS: Record<Source, { id: string; title: string; artist: string; duration: string; cover: string }[]> = {
  spotify: [
    { id: "s1", title: "Initial D Eurobeat Mix", artist: "Manuel", duration: "4:12", cover: "https://images.unsplash.com/photo-1493238792000-8113da705763?w=200" },
    { id: "s2", title: "Drift King Anthem", artist: "Tokyo Tuners", duration: "3:48", cover: "https://images.unsplash.com/photo-1542362567-b07e54358753?w=200" },
    { id: "s3", title: "Night Highway", artist: "Synthwave Crew", duration: "5:02", cover: "https://images.unsplash.com/photo-1493238792000-8113da705763?w=200" },
  ],
  apple: [
    { id: "a1", title: "Mountain Pass", artist: "Apex Hunters", duration: "3:21", cover: "https://images.unsplash.com/photo-1580273916550-e323be2ae537?w=200" },
    { id: "a2", title: "Redline", artist: "Carbon Soul", duration: "4:00", cover: "https://images.unsplash.com/photo-1542362567-b07e54358753?w=200" },
  ],
  soundcloud: [
    { id: "c1", title: "Garage Sessions Vol.3", artist: "DJ Boost", duration: "62:11", cover: "https://images.unsplash.com/photo-1493238792000-8113da705763?w=200" },
    { id: "c2", title: "Boost & Bass", artist: "TurboKid", duration: "3:33", cover: "https://images.unsplash.com/photo-1580273916550-e323be2ae537?w=200" },
  ],
};

export default function MusicScreen() {
  const [source, setSource] = useState<Source>("spotify");
  const [current, setCurrent] = useState(TRACKS.spotify[0]);
  const [playing, setPlaying] = useState(false);
  const progress = useRef(new Animated.Value(0)).current;

  useEffect(() => { setCurrent(TRACKS[source][0]); setPlaying(false); }, [source]);

  useEffect(() => {
    if (playing) {
      Animated.timing(progress, { toValue: 1, duration: 18000, useNativeDriver: false }).start();
    } else {
      progress.stopAnimation();
    }
  }, [playing]);

  return (
    <SafeAreaView style={styles.c} edges={["top"]}>
      <Text style={styles.title}>MUSIC</Text>
      <Text style={styles.sub}>Mock player · Spotify / Apple Music / SoundCloud</Text>

      <View style={styles.tabs}>
        {(["spotify", "apple", "soundcloud"] as Source[]).map((s) => (
          <TouchableOpacity
            key={s}
            testID={`music-${s}`}
            style={[styles.tab, source === s && styles.tabActive]}
            onPress={() => setSource(s)}
          >
            <Ionicons
              name={s === "spotify" ? "logo-no-smoking" : s === "apple" ? "logo-apple" : "cloud"}
              size={18}
              color={source === s ? "#000" : COLORS.text}
            />
            <Text style={[styles.tabText, source === s && { color: "#000" }]}>{s === "soundcloud" ? "SOUNDCLOUD" : s.toUpperCase()}</Text>
          </TouchableOpacity>
        ))}
      </View>

      <View style={styles.player} testID="now-playing">
        <Image source={{ uri: current.cover }} style={styles.cover} />
        <Text style={styles.songTitle}>{current.title}</Text>
        <Text style={styles.artist}>{current.artist}</Text>

        <View style={styles.progressBar}>
          <Animated.View style={[styles.progressFill, { width: progress.interpolate({ inputRange: [0, 1], outputRange: ["0%", "100%"] }) }]} />
        </View>
        <View style={styles.timeRow}>
          <Text style={styles.timeText}>0:00</Text>
          <Text style={styles.timeText}>{current.duration}</Text>
        </View>

        <View style={styles.controls}>
          <TouchableOpacity testID="prev-btn"><Ionicons name="play-skip-back" size={32} color={COLORS.text} /></TouchableOpacity>
          <TouchableOpacity testID="play-btn" style={styles.playBtn} onPress={() => setPlaying((p) => !p)}>
            <Ionicons name={playing ? "pause" : "play"} size={36} color="#000" />
          </TouchableOpacity>
          <TouchableOpacity testID="next-btn"><Ionicons name="play-skip-forward" size={32} color={COLORS.text} /></TouchableOpacity>
        </View>
      </View>

      <Text style={styles.up}>UP NEXT</Text>
      <ScrollView contentContainerStyle={{ paddingHorizontal: 16, paddingBottom: 30 }}>
        {TRACKS[source].slice(1).map((t) => (
          <TouchableOpacity key={t.id} testID={`track-${t.id}`} style={styles.row} onPress={() => { setCurrent(t); setPlaying(true); }}>
            <Image source={{ uri: t.cover }} style={styles.thumb} />
            <View style={{ flex: 1 }}>
              <Text style={styles.rowTitle}>{t.title}</Text>
              <Text style={styles.rowArtist}>{t.artist}</Text>
            </View>
            <Text style={styles.rowDur}>{t.duration}</Text>
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
  tabs: { flexDirection: "row", paddingHorizontal: 16, paddingTop: 12, gap: 8 },
  tab: { flex: 1, flexDirection: "row", justifyContent: "center", alignItems: "center", padding: 10, borderRadius: 10, backgroundColor: COLORS.surface, borderWidth: 1, borderColor: COLORS.border, gap: 6 },
  tabActive: { backgroundColor: COLORS.primary, borderColor: COLORS.primary },
  tabText: { color: COLORS.text, fontSize: 11, letterSpacing: 1.5, fontWeight: "800" },
  player: { alignItems: "center", padding: 20, marginHorizontal: 16, marginTop: 14, borderRadius: 20, backgroundColor: COLORS.surface, borderWidth: 1, borderColor: COLORS.border },
  cover: { width: 180, height: 180, borderRadius: 14, marginBottom: 14, backgroundColor: "#000" },
  songTitle: { color: COLORS.text, fontSize: 18, fontWeight: "900", textAlign: "center" },
  artist: { color: COLORS.textDim, marginTop: 4 },
  progressBar: { width: "100%", height: 4, backgroundColor: COLORS.border, borderRadius: 2, marginTop: 16, overflow: "hidden" },
  progressFill: { height: 4, backgroundColor: COLORS.secondary },
  timeRow: { flexDirection: "row", justifyContent: "space-between", width: "100%", marginTop: 6 },
  timeText: { color: COLORS.textDim, fontSize: 11 },
  controls: { flexDirection: "row", alignItems: "center", gap: 32, marginTop: 18 },
  playBtn: { width: 64, height: 64, borderRadius: 32, backgroundColor: COLORS.primary, alignItems: "center", justifyContent: "center" },
  up: { color: COLORS.textDim, paddingHorizontal: 18, marginTop: 16, marginBottom: 6, letterSpacing: 2, fontSize: 11 },
  row: { flexDirection: "row", alignItems: "center", padding: 10, borderRadius: 12, backgroundColor: COLORS.surface, marginBottom: 8, borderWidth: 1, borderColor: COLORS.border },
  thumb: { width: 44, height: 44, borderRadius: 8, marginRight: 12 },
  rowTitle: { color: COLORS.text, fontWeight: "700" },
  rowArtist: { color: COLORS.textDim, fontSize: 11, marginTop: 2 },
  rowDur: { color: COLORS.textDim, fontSize: 11 },
});
