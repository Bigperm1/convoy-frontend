import React, { useState, useEffect, useRef } from "react";
import { View, Text, StyleSheet, TouchableOpacity, Image, Animated, ScrollView } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { SafeAreaView } from "react-native-safe-area-context";
import { LinearGradient } from "expo-linear-gradient";
import { COLORS } from "../../src/theme";
import Glass from "../../src/Glass";

type Source = "spotify" | "apple" | "soundcloud";

const TRACKS: Record<Source, { id: string; title: string; artist: string; duration: string; cover: string }[]> = {
  spotify: [
    { id: "s1", title: "Initial D Eurobeat Mix", artist: "Manuel", duration: "4:12", cover: "https://images.unsplash.com/photo-1493238792000-8113da705763?w=300" },
    { id: "s2", title: "Drift King Anthem", artist: "Tokyo Tuners", duration: "3:48", cover: "https://images.unsplash.com/photo-1542362567-b07e54358753?w=300" },
    { id: "s3", title: "Night Highway", artist: "Synthwave Crew", duration: "5:02", cover: "https://images.unsplash.com/photo-1493238792000-8113da705763?w=300" },
  ],
  apple: [
    { id: "a1", title: "Mountain Pass", artist: "Apex Hunters", duration: "3:21", cover: "https://images.unsplash.com/photo-1580273916550-e323be2ae537?w=300" },
    { id: "a2", title: "Redline", artist: "Carbon Soul", duration: "4:00", cover: "https://images.unsplash.com/photo-1542362567-b07e54358753?w=300" },
  ],
  soundcloud: [
    { id: "c1", title: "Garage Sessions Vol.3", artist: "DJ Boost", duration: "62:11", cover: "https://images.unsplash.com/photo-1493238792000-8113da705763?w=300" },
    { id: "c2", title: "Boost & Bass", artist: "TurboKid", duration: "3:33", cover: "https://images.unsplash.com/photo-1580273916550-e323be2ae537?w=300" },
  ],
};

export default function MusicScreen() {
  const [source, setSource] = useState<Source>("spotify");
  const [current, setCurrent] = useState(TRACKS.spotify[0]);
  const [playing, setPlaying] = useState(false);
  const progress = useRef(new Animated.Value(0)).current;

  useEffect(() => { setCurrent(TRACKS[source][0]); setPlaying(false); progress.setValue(0); }, [source]);

  useEffect(() => {
    if (playing) {
      Animated.timing(progress, { toValue: 1, duration: 18000, useNativeDriver: false }).start();
    } else {
      progress.stopAnimation();
    }
  }, [playing]);

  return (
    <SafeAreaView style={styles.c} edges={["top"]}>
      <View style={styles.header}>
        <Text style={styles.title}>Music</Text>
        <Text style={styles.sub}>Mock player · Spotify, Apple Music, SoundCloud</Text>
      </View>

      <View style={styles.tabs}>
        {(["spotify", "apple", "soundcloud"] as Source[]).map((s) => (
          <TouchableOpacity key={s} testID={`music-${s}`} style={[styles.tab, source === s && styles.tabActive]} onPress={() => setSource(s)}>
            <Ionicons
              name={s === "spotify" ? "musical-note" : s === "apple" ? "logo-apple" : "cloud"}
              size={16}
              color={source === s ? "#fff" : COLORS.text}
            />
            <Text style={[styles.tabText, source === s && { color: "#fff", fontWeight: "600" }]}>{s === "soundcloud" ? "SoundCloud" : s === "apple" ? "Apple Music" : "Spotify"}</Text>
          </TouchableOpacity>
        ))}
      </View>

      <Glass radius={28} style={styles.player}>
        <View style={{ alignItems: "center", padding: 22 }} testID="now-playing">
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
            <TouchableOpacity testID="play-btn" onPress={() => setPlaying((p) => !p)} style={styles.playBtn}>
              <LinearGradient colors={[COLORS.primary, COLORS.primaryDim]} style={StyleSheet.absoluteFill} />
              <Ionicons name={playing ? "pause" : "play"} size={32} color="#fff" />
            </TouchableOpacity>
            <TouchableOpacity testID="next-btn"><Ionicons name="play-skip-forward" size={32} color={COLORS.text} /></TouchableOpacity>
          </View>
        </View>
      </Glass>

      <Text style={styles.up}>Up next</Text>
      <ScrollView contentContainerStyle={{ paddingHorizontal: 16, paddingBottom: 110 }}>
        {TRACKS[source].slice(1).map((t) => (
          <Glass key={t.id} radius={14} style={{ marginBottom: 8 }}>
            <TouchableOpacity testID={`track-${t.id}`} style={styles.row} onPress={() => { setCurrent(t); setPlaying(true); }}>
              <Image source={{ uri: t.cover }} style={styles.thumb} />
              <View style={{ flex: 1 }}>
                <Text style={styles.rowTitle}>{t.title}</Text>
                <Text style={styles.rowArtist}>{t.artist}</Text>
              </View>
              <Text style={styles.rowDur}>{t.duration}</Text>
            </TouchableOpacity>
          </Glass>
        ))}
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  c: { flex: 1, backgroundColor: COLORS.bg },
  header: { paddingHorizontal: 18, paddingTop: 8 },
  title: { color: COLORS.text, fontSize: 34, fontWeight: "700", letterSpacing: -1 },
  sub: { color: COLORS.textDim, marginTop: 2, fontSize: 13 },
  tabs: { flexDirection: "row", paddingHorizontal: 16, paddingTop: 14, gap: 8 },
  tab: { flex: 1, flexDirection: "row", justifyContent: "center", alignItems: "center", padding: 12, borderRadius: 12, backgroundColor: "rgba(118,118,128,0.18)", gap: 6 },
  tabActive: { backgroundColor: COLORS.primary },
  tabText: { color: COLORS.text, fontSize: 13, fontWeight: "500" },
  player: { marginHorizontal: 16, marginTop: 18 },
  cover: { width: 200, height: 200, borderRadius: 18, marginBottom: 16, backgroundColor: "#000" },
  songTitle: { color: COLORS.text, fontSize: 22, fontWeight: "700", textAlign: "center", letterSpacing: -0.4 },
  artist: { color: COLORS.textDim, marginTop: 4 },
  progressBar: { width: "100%", height: 4, backgroundColor: COLORS.hairline, borderRadius: 2, marginTop: 18, overflow: "hidden" },
  progressFill: { height: 4, backgroundColor: COLORS.primary },
  timeRow: { flexDirection: "row", justifyContent: "space-between", width: "100%", marginTop: 6 },
  timeText: { color: COLORS.textDim, fontSize: 11 },
  controls: { flexDirection: "row", alignItems: "center", gap: 36, marginTop: 18 },
  playBtn: { width: 64, height: 64, borderRadius: 32, alignItems: "center", justifyContent: "center", overflow: "hidden" },
  up: { color: COLORS.textDim, paddingHorizontal: 18, marginTop: 18, marginBottom: 8, fontSize: 13, fontWeight: "500" },
  row: { flexDirection: "row", alignItems: "center", padding: 10 },
  thumb: { width: 48, height: 48, borderRadius: 10, marginRight: 12 },
  rowTitle: { color: COLORS.text, fontWeight: "500" },
  rowArtist: { color: COLORS.textDim, fontSize: 12, marginTop: 2 },
  rowDur: { color: COLORS.textDim, fontSize: 12 },
});
