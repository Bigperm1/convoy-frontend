// SpotifyMusic.tsx — the Music-tab view when the user's source is Spotify.
// Controls playback through the Spotify Web API (Premium + an active Spotify
// device required). Audio plays on the user's Spotify app; Convoy shows
// now-playing + transport + lets them start a track/playlist. Mirrors the Apple
// Music screen's layout so switching sources feels seamless.
import React, { useCallback, useEffect, useRef, useState } from "react";
import { View, Text, StyleSheet, TouchableOpacity, ScrollView, ActivityIndicator, Alert } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { Image } from "expo-image";
import { useFocusEffect } from "expo-router";
import * as Haptics from "expo-haptics";
import { COLORS } from "./theme";
import { spotify } from "./spotify";

const SP_GREEN = "#1DB954";

function img(images?: any[]): string | undefined {
  if (!Array.isArray(images) || images.length === 0) return undefined;
  return images[0]?.url;
}

export default function SpotifyMusic({ onSwitchSource }: { onSwitchSource: () => void }) {
  const [now, setNow] = useState<any>(null);          // currently-playing item
  const [isPlaying, setIsPlaying] = useState(false);
  const [tracks, setTracks] = useState<any[]>([]);
  const [playlists, setPlaylists] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [shuffle, setShuffleState] = useState(false);
  const pollRef = useRef<any>(null);

  const refreshNow = useCallback(async () => {
    // /me/player carries shuffle_state too; fall back to currently-playing for
    // the odd device that 204s on the full state endpoint.
    const st = await spotify.playbackState();
    if (st) {
      setNow(st.item ?? null);
      setIsPlaying(!!st.is_playing);
      setShuffleState(!!st.shuffle_state);
      return;
    }
    const cur = await spotify.currentlyPlaying();
    setNow(cur?.item ?? null);
    setIsPlaying(!!cur?.is_playing);
  }, []);

  // Initial library load.
  useEffect(() => {
    (async () => {
      try {
        const [t, p] = await Promise.all([spotify.topTracks(), spotify.myPlaylists()]);
        setTracks(t?.items ?? []);
        setPlaylists((p?.items ?? []).filter(Boolean));
      } catch {}
      finally { setLoading(false); }
      refreshNow();
    })();
  }, [refreshNow]);

  // Poll now-playing every 3s while the tab is focused.
  useFocusEffect(useCallback(() => {
    refreshNow();
    pollRef.current = setInterval(refreshNow, 3000);
    return () => { if (pollRef.current) clearInterval(pollRef.current); };
  }, [refreshNow]));

  // Run a control; if Spotify reports no active device (404), try transferring to
  // the user's first available device and retry, else hint them to open Spotify.
  const control = useCallback(async (fn: () => Promise<{ ok: boolean; status: number }>, retry?: () => Promise<{ ok: boolean; status: number }>) => {
    setBusy(true);
    try {
      let r = await fn();
      if (r.status === 404) {
        const dev = await spotify.devices();
        const first = dev?.devices?.[0];
        if (first?.id) {
          await spotify.transfer(first.id, true);
          await new Promise((res) => setTimeout(res, 600));
          r = await (retry ?? fn)();
        } else {
          Alert.alert("Open Spotify first", "Start Spotify on your phone (play anything for a second), then come back — Convoy will control it from here.");
        }
      }
      if (r.status === 403) Alert.alert("Spotify Premium needed", "Controlling playback requires a Spotify Premium account.");
      setTimeout(refreshNow, 500);
    } finally { setBusy(false); }
  }, [refreshNow]);

  // Play the tapped top-track AND queue the rest of the list behind it (offset),
  // so playback continues and skip-forward/back work instead of stopping after
  // one song.
  const playTrackAt = (i: number) => {
    Haptics.selectionAsync().catch(() => {});
    const uris = tracks.map((t) => t.uri).filter(Boolean);
    control(() => spotify.playUris(uris, i));
  };
  const playPlaylist = (uri: string) => { Haptics.selectionAsync().catch(() => {}); control(() => spotify.playContext(uri)); };
  const toggle = () => control(() => (isPlaying ? spotify.pause() : spotify.resume()));
  const toggleShuffle = () => {
    const ns = !shuffle;
    setShuffleState(ns); // optimistic
    Haptics.selectionAsync().catch(() => {});
    control(() => spotify.setShuffle(ns));
  };

  return (
    <View style={{ flex: 1 }}>
      {/* Source switch */}
      <TouchableOpacity onPress={onSwitchSource} style={styles.switchRow} activeOpacity={0.8}>
        <Ionicons name="swap-horizontal" size={15} color={SP_GREEN} />
        <Text style={styles.switchText}>Switch source</Text>
      </TouchableOpacity>

      {loading ? (
        <ActivityIndicator color={SP_GREEN} style={{ marginTop: 40 }} />
      ) : (
        <ScrollView contentContainerStyle={{ paddingBottom: now ? 200 : 130 }} showsVerticalScrollIndicator={false}>
          {/* Your Playlists */}
          {playlists.length > 0 && (
            <View style={styles.section}>
              <Text style={styles.sectionTitle}>Your Playlists</Text>
              <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.hStrip}>
                {playlists.map((p, i) => (
                  <TouchableOpacity key={p.id || i} style={styles.card} activeOpacity={0.85} onPress={() => playPlaylist(p.uri)}>
                    {img(p.images) ? (
                      <Image source={{ uri: img(p.images) }} style={styles.cardArt} contentFit="cover" />
                    ) : (
                      <View style={[styles.cardArt, styles.artPlaceholder]}><Ionicons name="musical-notes" size={28} color={SP_GREEN} /></View>
                    )}
                    <Text style={styles.cardTitle} numberOfLines={2}>{p.name}</Text>
                    {!!p.tracks?.total && <Text style={styles.cardSub}>{p.tracks.total} songs</Text>}
                  </TouchableOpacity>
                ))}
              </ScrollView>
            </View>
          )}

          {/* Your Top Tracks */}
          {tracks.length > 0 && (
            <View style={styles.section}>
              <Text style={styles.sectionTitle}>Your Top Tracks</Text>
              <View style={styles.list}>
                {tracks.map((t, i) => (
                  <TouchableOpacity key={t.id || i} style={[styles.row, i === tracks.length - 1 && styles.rowLast]} activeOpacity={0.7} onPress={() => playTrackAt(i)}>
                    {img(t.album?.images) ? (
                      <Image source={{ uri: img(t.album?.images) }} style={styles.rowArt} contentFit="cover" />
                    ) : (
                      <View style={[styles.rowArt, styles.artPlaceholder]}><Ionicons name="musical-note" size={20} color={SP_GREEN} /></View>
                    )}
                    <View style={{ flex: 1 }}>
                      <Text style={styles.rowTitle} numberOfLines={1}>{t.name}</Text>
                      <Text style={styles.rowSub} numberOfLines={1}>{(t.artists ?? []).map((a: any) => a.name).join(", ")}</Text>
                    </View>
                    <Ionicons name="play-circle" size={26} color={SP_GREEN} />
                  </TouchableOpacity>
                ))}
              </View>
            </View>
          )}

          {tracks.length === 0 && playlists.length === 0 && (
            <Text style={styles.hint}>Nothing in your Spotify library yet. Add playlists or listen a bit and they'll show up here.</Text>
          )}

          <Text style={styles.footer}>Convoy controls your own Spotify. Premium is required to start/skip playback, and your Spotify app must be the active device.</Text>
        </ScrollView>
      )}

      {/* Now-playing bar */}
      {now && (
        <View style={styles.nowBar}>
          {img(now.album?.images) ? (
            <Image source={{ uri: img(now.album?.images) }} style={styles.nowArt} contentFit="cover" />
          ) : (
            <View style={[styles.nowArt, styles.artPlaceholder]}><Ionicons name="musical-note" size={20} color={SP_GREEN} /></View>
          )}
          <View style={{ flex: 1 }}>
            <Text style={styles.nowTitle} numberOfLines={1}>{now.name ?? "Now Playing"}</Text>
            <Text style={styles.nowSub} numberOfLines={1}>{(now.artists ?? []).map((a: any) => a.name).join(", ")}</Text>
          </View>
          <TouchableOpacity onPress={toggleShuffle} hitSlop={8} disabled={busy} style={{ marginRight: 12 }}>
            <Ionicons name="shuffle" size={20} color={shuffle ? SP_GREEN : COLORS.textDim} />
          </TouchableOpacity>
          <TouchableOpacity onPress={() => control(() => spotify.previous())} hitSlop={8} disabled={busy}>
            <Ionicons name="play-skip-back" size={22} color={COLORS.text} />
          </TouchableOpacity>
          <TouchableOpacity onPress={toggle} hitSlop={8} style={{ marginHorizontal: 14 }} disabled={busy}>
            <Ionicons name={isPlaying ? "pause" : "play"} size={26} color={COLORS.text} />
          </TouchableOpacity>
          <TouchableOpacity onPress={() => control(() => spotify.next())} hitSlop={8} disabled={busy}>
            <Ionicons name="play-skip-forward" size={22} color={COLORS.text} />
          </TouchableOpacity>
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  switchRow: { flexDirection: "row", alignItems: "center", gap: 5, alignSelf: "flex-end", paddingHorizontal: 20, paddingVertical: 6 },
  switchText: { color: SP_GREEN, fontSize: 12, fontWeight: "700" },
  section: { marginTop: 18 },
  sectionTitle: { color: COLORS.text, fontSize: 22, fontWeight: "800", letterSpacing: -0.5, paddingHorizontal: 20, marginBottom: 12 },
  hStrip: { paddingHorizontal: 20, gap: 14 },
  card: { width: 130 },
  cardArt: { width: 130, height: 130, borderRadius: 10, backgroundColor: "rgba(255,255,255,0.06)" },
  artPlaceholder: { alignItems: "center", justifyContent: "center" },
  cardTitle: { color: COLORS.text, fontSize: 14, fontWeight: "600", marginTop: 8 },
  cardSub: { color: COLORS.textDim, fontSize: 12, marginTop: 2 },
  list: { marginTop: 4, marginHorizontal: 20, backgroundColor: "rgba(255,255,255,0.05)", borderRadius: 14, overflow: "hidden", borderWidth: StyleSheet.hairlineWidth, borderColor: "rgba(255,255,255,0.08)" },
  row: { flexDirection: "row", alignItems: "center", gap: 12, paddingHorizontal: 12, paddingVertical: 8, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: "rgba(255,255,255,0.08)" },
  rowLast: { borderBottomWidth: 0 },
  rowArt: { width: 48, height: 48, borderRadius: 6, backgroundColor: "rgba(255,255,255,0.06)" },
  rowTitle: { color: COLORS.text, fontSize: 15, fontWeight: "600" },
  rowSub: { color: COLORS.textDim, fontSize: 13, marginTop: 1 },
  hint: { color: COLORS.textDim, fontSize: 14, lineHeight: 20, paddingHorizontal: 22, marginTop: 22 },
  footer: { color: "#808080", fontSize: 12, lineHeight: 18, textAlign: "center", paddingHorizontal: 24, marginTop: 26 },
  nowBar: { position: "absolute", left: 12, right: 12, bottom: 96, flexDirection: "row", alignItems: "center", gap: 12, paddingHorizontal: 12, paddingVertical: 10, backgroundColor: "rgba(34,35,38,0.98)", borderRadius: 16, borderWidth: StyleSheet.hairlineWidth, borderColor: "rgba(255,255,255,0.12)", shadowColor: "#000", shadowOpacity: 0.4, shadowRadius: 12, shadowOffset: { width: 0, height: 6 }, elevation: 12 },
  nowArt: { width: 44, height: 44, borderRadius: 8, backgroundColor: "rgba(255,255,255,0.06)" },
  nowTitle: { color: COLORS.text, fontSize: 14, fontWeight: "700" },
  nowSub: { color: COLORS.textDim, fontSize: 12, marginTop: 1 },
});
