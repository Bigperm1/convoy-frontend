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
import { COLORS, ACTION } from "./theme";
import { spotify, spotifyMissingScopes, startLogin } from "./spotify";
import ShareSheet from "./ShareSheet";
import { shareInbox } from "./shareInbox";

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
  const [recent, setRecent] = useState<any[]>([]);
  // Scopes this build needs that the linked session never granted. Spotify cannot
  // widen scope on a refresh, so an account linked before a scope existed keeps a
  // narrower token and the dependent feature returns 403 — which callSafe turns into
  // null, i.e. a feature that silently never appears. Surface it instead.
  const [needsReauth, setNeedsReauth] = useState<string[]>([]);
  // Share target — same one-slot pattern the Apple screen uses, so a song and a
  // playlist can share one sheet.
  const [sharePayload, setSharePayload] = useState<any | null>(null);
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
        const [t, p, r] = await Promise.all([
          spotify.topTracks(), spotify.myPlaylists(), spotify.recentlyPlayed(),
        ]);
        setTracks(t?.items ?? []);
        setPlaylists((p?.items ?? []).filter(Boolean));
        // recently-played is a list of PLAY EVENTS: {track, context}. Dedupe by the
        // thing you would actually replay — the context when there is one, else the
        // track — so the strip is not five rows of the same playlist.
        const seen = new Set<string>();
        const rows: any[] = [];
        for (const it of (r?.items ?? [])) {
          const ctx = it?.context?.uri;
          const key = ctx || it?.track?.uri;
          if (!key || seen.has(key)) continue;
          seen.add(key);
          rows.push({
            uri: key,
            isContext: !!ctx,
            title: ctx ? (it?.track?.album?.name ?? it?.track?.name) : it?.track?.name,
            subtitle: (it?.track?.artists ?? []).map((a: any) => a?.name).filter(Boolean).join(", "),
            artwork: img(it?.track?.album?.images),
          });
          if (rows.length >= 12) break;
        }
        setRecent(rows);
      } catch {}
      try { setNeedsReauth(await spotifyMissingScopes()); } catch {}
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
          Alert.alert("Open Spotify first", "Start Spotify on your phone (play anything for a second), then come back — Hairpin will control it from here.");
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
  // Recently Played: resume the CONTEXT (playlist/album) when the event had one,
  // else just the track. Mirrors playRecentItem on the Apple side.
  const playRecent = (r: any) => {
    Haptics.selectionAsync().catch(() => {});
    control(() => (r?.isContext ? spotify.playContext(r.uri) : spotify.playUris([r.uri])));
  };
  const sharePlaylistSp = useCallback((p: any) => {
    Haptics.selectionAsync().catch(() => {});
    setSharePayload({
      kind: "music",
      mediaType: "playlist",
      // Carried so a Spotify->Spotify share is exact; a recipient on Apple Music
      // ignores it and falls back to the title, which is the cross-service handle.
      spotifyUri: p?.uri,
      title: p?.name,
      artworkUrl: img(p?.images),
    });
  }, []);

  // ── RECEIVE A SHARE (2026-07-30) ─────────────────────────────────────────
  // Previously nothing here consumed shareInbox, so a song or playlist sent to an
  // Android/Spotify user silently did nothing — music.tsx's applyPendingMusic is
  // all MusicKit and bails on `isMusicSupported`, and this view returns before it
  // can matter anyway.
  //
  // Resolution order, most-exact first:
  //   1. a spotify: uri from another Spotify user  -> play it directly
  //   2. otherwise search by NAME. This is what makes an APPLE MUSIC share work
  //      here: the id is meaningless across services but the name is not, and
  //      Spotify (unlike Apple's native module) exposes playlist search.
  const applyPendingShare = useCallback(async () => {
    const m = shareInbox.takeMusic();
    if (!m) return;
    try {
      if (m.mediaType === "playlist") {
        if (typeof m.spotifyUri === "string" && m.spotifyUri.startsWith("spotify:")) {
          await control(() => spotify.playContext(m.spotifyUri!));
          return;
        }
        if (m.title) {
          const res = await spotify.searchPlaylists(m.title);
          const hit = (res?.playlists?.items ?? []).filter(Boolean)[0];
          if (hit?.uri) { await control(() => spotify.playContext(hit.uri)); return; }
        }
        return;
      }
      const q = [m.title, m.artist].filter(Boolean).join(" ").trim();
      if (!q) return;
      const res = await spotify.searchTracks(q);
      const hit = (res?.tracks?.items ?? []).filter(Boolean)[0];
      if (hit?.uri) await control(() => spotify.playUris([hit.uri]));
    } catch {
      // A share that cannot be resolved must never break the screen.
    }
  }, []);
  useEffect(() => shareInbox.subscribe(() => { void applyPendingShare(); }), [applyPendingShare]);
  useFocusEffect(useCallback(() => { void applyPendingShare(); }, [applyPendingShare]));
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
          {/* Re-link prompt. Only shown when we KNOW the grant is short — never on a
              guess, so a healthy session never sees it. */}
          {needsReauth.length > 0 && (
            <TouchableOpacity
              style={styles.reauthRow}
              activeOpacity={0.85}
              onPress={async () => {
                Haptics.selectionAsync().catch(() => {});
                const ok = await startLogin().catch(() => false);
                // Re-authorising widens the grant, so re-read it — otherwise the
                // prompt would stay on screen until the next cold start.
                if (ok) { try { setNeedsReauth(await spotifyMissingScopes()); } catch {} }
              }}
            >
              <Ionicons name="refresh-circle" size={18} color={SP_GREEN} />
              <Text style={styles.reauthText}>
                Reconnect Spotify to enable Recently Played
              </Text>
            </TouchableOpacity>
          )}

          {/* Recently Played — same position and behaviour as the Apple screen. */}
          {recent.length > 0 && (
            <View style={styles.section}>
              <Text style={styles.sectionTitle}>Recently Played</Text>
              <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.hStrip}>
                {recent.map((r, i) => (
                  <TouchableOpacity
                    key={r.uri || i}
                    style={styles.card}
                    activeOpacity={0.85}
                    onPress={() => playRecent(r)}
                    onLongPress={() => r.isContext && sharePlaylistSp({ uri: r.uri, name: r.title, images: r.artwork ? [{ url: r.artwork }] : [] })}
                    delayLongPress={350}
                  >
                    {r.artwork ? (
                      <Image source={{ uri: r.artwork }} style={styles.cardArt} contentFit="cover" />
                    ) : (
                      <View style={[styles.cardArt, styles.artPlaceholder]}><Ionicons name="musical-notes" size={28} color={SP_GREEN} /></View>
                    )}
                    <Text style={styles.cardTitle} numberOfLines={2}>{r.title}</Text>
                    {!!r.subtitle && <Text style={styles.cardSub} numberOfLines={1}>{r.subtitle}</Text>}
                  </TouchableOpacity>
                ))}
              </ScrollView>
            </View>
          )}

          {/* Your Playlists */}
          {playlists.length > 0 && (
            <View style={styles.section}>
              <Text style={styles.sectionTitle}>Your Playlists</Text>
              <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.hStrip}>
                {playlists.map((p, i) => (
                  <TouchableOpacity
                    key={p.id || i}
                    style={styles.card}
                    activeOpacity={0.85}
                    onPress={() => playPlaylist(p.uri)}
                    onLongPress={() => sharePlaylistSp(p)}
                    delayLongPress={350}
                  >
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

          <Text style={styles.footer}>Hairpin controls your own Spotify. Premium is required to start/skip playback, and your Spotify app must be the active device.</Text>
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
          {/* Share the now-playing track — the Apple screen has had this; Spotify
              had no share at all, so a shared song could never originate here. */}
          <TouchableOpacity
            onPress={() => {
              Haptics.selectionAsync().catch(() => {});
              setSharePayload({
                kind: "music",
                title: now?.name,
                artist: (now?.artists ?? []).map((a: any) => a?.name).filter(Boolean).join(", "),
                artworkUrl: img(now?.album?.images),
                spotifyUri: now?.uri,
              });
            }}
            hitSlop={8}
            style={{ marginRight: 2 }}
          >
            <Ionicons name="share-outline" size={20} color={ACTION.share} />
          </TouchableOpacity>
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

      {/* Share sheet — shared by the now-playing track and by a held playlist,
          same single-slot pattern as the Apple screen. */}
      <ShareSheet
        visible={!!sharePayload}
        onClose={() => setSharePayload(null)}
        share={sharePayload}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  reauthRow: { flexDirection: "row", alignItems: "center", gap: 8, marginHorizontal: 20, marginBottom: 10,
    paddingVertical: 10, paddingHorizontal: 12, borderRadius: 10,
    borderWidth: 1, borderColor: "rgba(29,185,84,0.35)", backgroundColor: "rgba(29,185,84,0.10)" },
  reauthText: { color: COLORS.text, fontSize: 13, fontWeight: "600", flex: 1 },
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
