import React, { useEffect, useRef } from "react";
import { Animated, Pressable, StyleSheet, Text, TouchableOpacity, View } from "react-native";
import { Image } from "expo-image";
import { Ionicons } from "@expo/vector-icons";
import { LinearGradient } from "expo-linear-gradient";
import { COLORS } from "../theme";
import { useNowPlaying } from "../nowPlaying";

/**
 * Now-playing banner that lives on the map, beside the speedometer.
 *
 * Visuals = the speedo's frosted-dark pill (same height, radius, border) so it
 * reads as part of the same control cluster; content = the Music tab's
 * now-playing card (art + title + artist + play/pause).
 *
 * It only appears while something is actually playing, and it SHIFTS right to
 * make room when the speed-limit sign slides out of the speedo (`shifted`),
 * keeping its right edge clear of the police-hazard FAB. Left edges are tuned
 * to the speedo (84w @ left:12 → right edge 96) and the slid-out limit sign
 * (84w @ left:104 → right edge 188). See SpeedPill in TurnByTurnNav.tsx.
 */

// Speedo right edge (96) + 8px gap.
const LEFT_BASE = 104;
// Slid-out speed-limit sign right edge (188) + 8px gap.
const LEFT_SHIFTED = 196;
// Clears the police FAB (right:12, 60 wide → left edge at screenW-72) by 8px.
const RIGHT_GAP = 80;
const BAR_H = 60;

function artURL(raw?: string, size = 120): string | undefined {
  if (!raw || typeof raw !== "string") return undefined;
  return raw.replace("{w}", String(size)).replace("{h}", String(size)).replace("{f}", "jpg");
}

const ART_GRADIENTS: [string, string][] = [
  ["#FF6A88", "#FF99AC"],
  ["#7F7FD5", "#86A8E7"],
  ["#43C6AC", "#0F2027"],
  ["#FDC830", "#F37335"],
  ["#4776E6", "#8E54E9"],
  ["#11998E", "#38EF7D"],
  ["#FC5C7D", "#6A82FB"],
  ["#F7971E", "#FFD200"],
  ["#C94B4B", "#4B134F"],
  ["#1FA2FF", "#12D8FA"],
];
function artHashIndex(seed: string): number {
  let h = 0;
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) >>> 0;
  return h % ART_GRADIENTS.length;
}
function artInitial(seed: string): string {
  const m = seed.trim().match(/[A-Za-z0-9]/);
  return m ? m[0].toUpperCase() : "♪";
}
function ArtFallback({ seed }: { seed?: string }) {
  const key = seed && seed.trim() ? seed : "?";
  const pair = ART_GRADIENTS[artHashIndex(key)];
  return (
    <LinearGradient
      colors={pair}
      start={{ x: 0, y: 0 }}
      end={{ x: 1, y: 1 }}
      style={styles.art}
    >
      <Text style={{ color: "rgba(255,255,255,0.95)", fontSize: 18, fontWeight: "800" }}>{artInitial(key)}</Text>
    </LinearGradient>
  );
}

export function MapNowPlaying({
  bottom,
  shifted,
  onOpen,
}: {
  bottom: number;
  shifted: boolean;
  onOpen?: () => void;
}) {
  const { song, isPlaying, toggle } = useNowPlaying();
  const nowPlaying = song && (song.title || song.name);

  const shift = useRef(new Animated.Value(shifted ? 1 : 0)).current;
  useEffect(() => {
    // Mirror the speed-limit sign's spring so the two move in lockstep.
    Animated.spring(shift, { toValue: shifted ? 1 : 0, useNativeDriver: false, tension: 80, friction: 12 }).start();
  }, [shifted, shift]);

  if (!nowPlaying) return null;

  const left = shift.interpolate({ inputRange: [0, 1], outputRange: [LEFT_BASE, LEFT_SHIFTED] });
  const art = artURL(song?.artworkUrl ?? song?.artwork?.url, 96);
  const title = song?.title ?? song?.name ?? "Now Playing";
  const artist = song?.artistName ?? song?.artist ?? "";

  return (
    <Animated.View style={[styles.wrap, { bottom, left }]} pointerEvents="box-none">
      <Pressable style={styles.bar} onPress={onOpen} hitSlop={4}>
        {art ? (
          <Image source={{ uri: art }} style={styles.art} contentFit="cover" />
        ) : (
          <ArtFallback seed={title} />
        )}
        <View style={styles.meta}>
          <Text style={styles.title} numberOfLines={1}>{title}</Text>
          {!!artist && <Text style={styles.sub} numberOfLines={1}>{artist}</Text>}
        </View>
        <TouchableOpacity onPress={() => toggle()} hitSlop={12} style={styles.playBtn} testID="map-now-toggle">
          <Ionicons name={isPlaying ? "pause" : "play"} size={24} color={COLORS.text} />
        </TouchableOpacity>
      </Pressable>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  wrap: { position: "absolute", right: RIGHT_GAP, height: BAR_H, zIndex: 54 },
  bar: {
    flex: 1,
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    paddingLeft: 8,
    paddingRight: 6,
    borderRadius: 16,
    backgroundColor: "rgba(22,22,24,0.92)",
    borderWidth: 1,
    borderColor: "rgba(255,255,255,0.12)",
    shadowColor: "#000",
    shadowOpacity: 0.3,
    shadowRadius: 5,
    shadowOffset: { width: 0, height: 2 },
    elevation: 5,
  },
  art: { width: 44, height: 44, borderRadius: 8, alignItems: "center", justifyContent: "center", backgroundColor: "rgba(255,255,255,0.06)" },
  meta: { flex: 1, minWidth: 0 },
  title: { color: COLORS.text, fontSize: 14, fontWeight: "700" },
  sub: { color: COLORS.textDim, fontSize: 12, marginTop: 1 },
  playBtn: { width: 34, height: 44, alignItems: "center", justifyContent: "center" },
});
