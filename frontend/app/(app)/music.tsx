import React, { useState, useEffect, useRef } from "react";
import { View, Text, StyleSheet, TouchableOpacity, Image, ScrollView, ActivityIndicator, Linking, Platform, Alert } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { SafeAreaView } from "react-native-safe-area-context";
import { LinearGradient } from "expo-linear-gradient";
import { COLORS } from "../../src/theme";
import Glass from "../../src/Glass";
import { startLogin, getStoredToken, logout, spotify, isConfigured } from "../../src/spotify";
import { useAuth } from "../../src/auth";
import { useSettings } from "../../src/settings";
import { api } from "../../src/api";
import { useLatestTier, getMusicBroadcastQuality } from "../../src/proximityAudio";

type Source = "spotify" | "apple" | "soundcloud";

/**
 * Deep-link to a music app on the user's phone.
 *
 * Tries the native URL scheme first (which jumps straight to the installed app
 * with no browser intermediary â fixing the "black Safari blink" the user was
 * seeing in the field), then falls back to the public https URL if the scheme
 * isn't registered (app not installed).
 *
 * Native schemes per platform:
 *   Apple Music (iOS)   â music://             (Music app)
 *   Apple Music (web)   â https://music.apple.com
 *   Spotify  (iOS/Android) â spotify://         (Spotify app)
 *   Spotify  (fallback) â https://open.spotify.com
 *   SoundCloud          â soundcloud://         (SoundCloud app)
 *   SoundCloud (fallback) â https://soundcloud.com
 *
 * Optional `path` param (e.g. a track URI) is appended to the scheme/URL.
 */
async function deepLinkToMusicApp(target: Source, path?: string): Promise<boolean> {
  const candidates: Record<Source, string[]> = {
    apple: Platform.OS === "ios"
      ? [`music://${path ?? ""}`, `itms-music://${path ?? ""}`, `https://music.apple.com${path ? "/" + path : ""}`]
      : [`https://music.apple.com${path ? "/" + path : ""}`],
    spotify: [`spotify://${path ?? ""}`, `https://open.spotify.com${path ? "/" + path : ""}`],
    soundcloud: [`soundcloud://${path ?? ""}`, `https://soundcloud.com${path ? "/" + path : ""}`],
  };
  for (const url of candidates[target]) {
    try {
      const ok = await Linking.canOpenURL(url);
      if (ok) {
        await Linking.openURL(url);
        return true;
      }
    } catch {
      // canOpenURL throws on iOS for unregistered schemes â try next candidate.
    }
  }
  // Last-resort: just try the https fallback even if canOpenURL said no
  // (some Android setups under-report support).
  try {
    await Linking.openURL(candidates[target][candidates[target].length - 1]);
    return true;
  } catch {
    return false;
  }
}

export default function MusicScreen() {
  const [source, setSource] = useState<Source>("spotify");

  return (
    <SafeAreaView style={styles.c} edges={["top"]}>
      <View style={styles.header}>
        <Text style={styles.title}>Music</Text>
        <Text style={styles.sub}>Sign in to bring your library on the road</Text>
      </View>

      {/* Service selector â iPhone-home-screen-style app icons rather than
          generic tabs. Selected icon scales up + a small Convoy-gold dot
          appears under its label. Each icon uses the brand color of the
          service (Spotify green, Apple pinkâpurple gradient, SoundCloud
          orange) so it reads instantly at a glance. */}
      <View style={styles.serviceRow}>
        {[
          { id: "spotify",    label: "Spotify",     bg: "#1DB954", grad: null,                    icon: "musical-notes" as const },
          { id: "apple",      label: "Apple Music", bg: null,      grad: ["#FC5C7D", "#6A3093"],   icon: "musical-note"  as const },
          { id: "soundcloud", label: "SoundCloud",  bg: "#FF5500", grad: null,                    icon: "cloud"         as const },
        ].map((svc) => {
          const selected = source === svc.id;
          return (
            <TouchableOpacity
              key={svc.id}
              testID={`music-${svc.id}`}
              onPress={() => setSource(svc.id as Source)}
              style={[styles.serviceIcon, selected && styles.serviceIconSelected]}
              activeOpacity={0.85}
            >
              {svc.grad ? (
                <LinearGradient
                  colors={svc.grad as any}
                  start={{ x: 0, y: 0 }}
                  end={{ x: 1, y: 1 }}
                  style={styles.serviceIconBg}
                >
                  <Ionicons name={svc.icon} size={32} color="#fff" />
                </LinearGradient>
              ) : (
                <View style={[styles.serviceIconBg, { backgroundColor: svc.bg as string }]}>
                  <Ionicons name={svc.icon} size={32} color="#fff" />
                </View>
              )}
              <Text style={[styles.serviceLabel, selected && styles.serviceLabelSelected]}>
                {svc.label}
              </Text>
              {selected && <View style={styles.serviceSelectedDot} />}
            </TouchableOpacity>
          );
        })}
      </View>

      {source === "spotify" && <SpotifyPanel />}
      {source === "apple" && <ComingSoon name="Apple Music" reason="Apple Music sign-in requires the Apple Developer Program ($99/yr) and a server-signed MusicKit JWT." />}
      {source === "soundcloud" && <ComingSoon name="SoundCloud" reason="SoundCloud closed public API registrations in 2021. We'll re-enable when access reopens." />}
    </SafeAreaView>
  );
}

function ComingSoon({ name, reason }: { name: string; reason: string }) {
  // Map the human label back to the Source key used by deepLinkToMusicApp.
  // Deep-link directly to the installed app so the user lands inside Apple
  // Music / SoundCloud immediately rather than a black Safari blink.
  const target: Source | null =
    name === "Apple Music" ? "apple" : name === "SoundCloud" ? "soundcloud" : null;
  const handleOpen = async () => {
    if (!target) return;
    const opened = await deepLinkToMusicApp(target);
    if (!opened) {
      Alert.alert("Couldn't open", `${name} isn't available on this device. Install it from the App Store.`);
    }
  };
  return (
    <View style={styles.comingWrap}>
      <Glass radius={24}>
        <View style={{ padding: 24, alignItems: "center" }}>
          <View style={styles.comingIcon}>
            <Ionicons name="time" size={40} color={COLORS.warning} />
          </View>
          <Text style={styles.comingTitle}>{name}</Text>
          <Text style={styles.comingSub}>{reason}</Text>
          {target && (
            <TouchableOpacity
              testID={`open-${name.toLowerCase().replace(/\s/g, '-')}`}
              onPress={handleOpen}
              style={styles.openBtn}
              activeOpacity={0.85}
            >
              <Ionicons name="open-outline" size={16} color="#fff" />
              <Text style={styles.openBtnText}>Open in {name}</Text>
            </TouchableOpacity>
          )}
        </View>
      </Glass>
    </View>
  );
}

function SpotifyPanel() {
  const { user } = useAuth();
  const [settings] = useSettings();
  const [signedIn, setSignedIn] = useState<boolean>(false);
  const [me, setMe] = useState<any>(null);
  const [tracks, setTracks] = useState<any[]>([]);
  const [playlists, setPlaylists] = useState<any[]>([]);
  const [loading, setLoading] = useState(false);
  // ===== Now-playing + community broadcast =====
  // `currentTrack` powers the broadcast card so the admin sees exactly what
  // they're about to push. It's refreshed every 10s while the panel is
  // mounted (Spotify's currently-playing endpoint is lightweight).
  const [currentTrack, setCurrentTrack] = useState<any>(null);
  const [isAdmin, setIsAdmin] = useState(false);
  const [isBroadcasting, setIsBroadcasting] = useState(false);
  const broadcastInterval = useRef<ReturnType<typeof setInterval> | null>(null);
  const nowPlayingInterval = useRef<ReturnType<typeof setInterval> | null>(null);
  const activeCommunityId = settings.activeCommunityId;
  // Adaptive broadcast quality â derived from how close convoy members are.
  // Pulled from the shared proximity store published by map.tsx, so we never
  // duplicate the Supabase presence subscription here.
  const { tier: proximityTier, peerCount: proximityPeers } = useLatestTier();
  const musicQuality = getMusicBroadcastQuality(proximityTier);

  const refresh = async () => {
    // getStoredToken is now async â must be awaited. Previously the sync call
    // returned `Promise<string|null>` which coerced to truthy via "[object Promise]",
    // which is why the panel briefly entered a signed-in state then crashed.
    const t = await getStoredToken();
    if (!t) { setSignedIn(false); return; }
    setSignedIn(true);
    try {
      setLoading(true);
      const [profile, top, pls] = await Promise.all([
        spotify.me(), spotify.topTracks(), spotify.myPlaylists(),
      ]);
      setMe(profile);
      setTracks(top.items || []);
      setPlaylists(pls.items || []);
    } catch {
      // Token may have been revoked; clear it
      await logout(); setSignedIn(false);
    } finally { setLoading(false); }
  };

  // Currently-playing poll â feeds the admin broadcast card. Pauses when the
  // user isn't signed in to avoid a 401 loop.
  const refreshNowPlaying = async () => {
    try {
      const np = await spotify.currentlyPlaying();
      if (np && np.item) {
        setCurrentTrack({
          name: np.item.name,
          artist: np.item.artists?.map((a: any) => a.name).join(", "),
          albumArt: np.item.album?.images?.[0]?.url,
          uri: np.item.uri,
        });
      } else {
        setCurrentTrack(null);
      }
    } catch {
      setCurrentTrack(null);
    }
  };

  useEffect(() => { refresh(); }, []);

  // Poll currently-playing every 10s while signed in. Cleared on sign-out / unmount.
  useEffect(() => {
    if (!signedIn) {
      if (nowPlayingInterval.current) clearInterval(nowPlayingInterval.current);
      return;
    }
    refreshNowPlaying();
    nowPlayingInterval.current = setInterval(refreshNowPlaying, 10000);
    return () => { if (nowPlayingInterval.current) clearInterval(nowPlayingInterval.current); };
  }, [signedIn]);

  // Resolve admin status â only the community admin can broadcast. Re-checks
  // when the active community changes (user switches convoys in Settings).
  useEffect(() => {
    let cancelled = false;
    (async () => {
      if (!activeCommunityId || !user) { setIsAdmin(false); return; }
      try {
        const { data } = await api.get(`/communities/${activeCommunityId}`);
        if (!cancelled) setIsAdmin(data?.admin_id === user.id);
      } catch { if (!cancelled) setIsAdmin(false); }
    })();
    return () => { cancelled = true; };
  }, [activeCommunityId, user?.id]);

  // Cleanup any in-flight broadcast on unmount.
  useEffect(() => () => {
    if (broadcastInterval.current) clearInterval(broadcastInterval.current);
  }, []);

  // Push the current track to every member of the active community. Repeats
  // every 10s so members who join mid-broadcast still receive it. The
  // backend re-broadcasts on the WebSocket, where the map screen renders a
  // toast (see map.tsx 'music_broadcast' handler).
  const toggleBroadcast = async () => {
    if (!activeCommunityId) return;
    if (isBroadcasting) {
      if (broadcastInterval.current) clearInterval(broadcastInterval.current);
      setIsBroadcasting(false);
      try {
        await api.post("/community/broadcast-music", {
          action: "stop",
          community_id: activeCommunityId,
        });
      } catch {}
      return;
    }
    if (!currentTrack) {
      Alert.alert("Nothing playing", "Start a song on Spotify first, then come back to broadcast.");
      return;
    }
    setIsBroadcasting(true);
    const pushTrack = async () => {
      if (!currentTrack) return;
      try {
        await api.post("/community/broadcast-music", {
          action: "play",
          community_id: activeCommunityId,
          quality: musicQuality,    // 'lossless' | 'high' | 'normal' â set by proximity tier
          track: {
            name: currentTrack.name,
            artist: currentTrack.artist,
            albumArt: currentTrack.albumArt,
            spotifyUri: currentTrack.uri,
            service: "spotify",
            quality: musicQuality,
          },
        });
      } catch {}
    };
    pushTrack();
    broadcastInterval.current = setInterval(pushTrack, 10000);
  };

  const onSignIn = async () => {
    if (Platform.OS !== "web") {
      Alert.alert("Web only", "Spotify sign-in works in the web preview. For native, build an EAS dev client.");
      return;
    }
    if (!isConfigured()) {
      Alert.alert("Not configured", "Add EXPO_PUBLIC_SPOTIFY_CLIENT_ID to .env");
      return;
    }
    try { await startLogin(); }
    catch (e: any) { Alert.alert("Sign-in failed", e?.message || ""); }
  };

  const onSignOut = async () => {
    await logout(); setSignedIn(false); setMe(null); setTracks([]); setPlaylists([]);
    setCurrentTrack(null);
    if (isBroadcasting) {
      if (broadcastInterval.current) clearInterval(broadcastInterval.current);
      setIsBroadcasting(false);
    }
  };

  if (!signedIn) {
    return (
      <View style={styles.signinWrap}>
        <Glass radius={24} style={{ width: "100%", maxWidth: 360 }}>
          <View style={{ padding: 24, alignItems: "center" }}>
            <View style={[styles.comingIcon, { backgroundColor: "#1DB95433" }]}>
              <Ionicons name="musical-notes" size={36} color="#1DB954" />
            </View>
            <Text style={styles.signTitle}>Sign in to Spotify</Text>
            <Text style={styles.signText}>Bring your playlists, top tracks and now-playing into Convoy.</Text>
            <TouchableOpacity testID="spotify-signin" onPress={onSignIn} style={styles.spotifyBtn} activeOpacity={0.85}>
              <LinearGradient colors={["#1DB954", "#159A41"]} style={styles.spotifyGrad}>
                <Ionicons name="logo-rss" size={18} color="#fff" />
                <Text style={styles.spotifyText}>Continue with Spotify</Text>
              </LinearGradient>
            </TouchableOpacity>
          </View>
        </Glass>
      </View>
    );
  }

  return (
    <ScrollView contentContainerStyle={{ padding: 16, paddingBottom: 110 }}>
      <Glass radius={20} style={{ marginBottom: 14 }}>
        <View style={styles.profileRow}>
          {me?.images?.[0]?.url ? (
            <Image source={{ uri: me.images[0].url }} style={styles.profileAvatar} />
          ) : (
            <View style={[styles.profileAvatar, { backgroundColor: "#1DB954", alignItems: "center", justifyContent: "center" }]}>
              <Ionicons name="person" size={22} color="#fff" />
            </View>
          )}
          <View style={{ flex: 1 }}>
            <Text style={styles.profileName}>{me?.display_name || "Spotify user"}</Text>
            <Text style={styles.profileMeta}>
              {me?.product === "premium" ? "Premium" : "Free"} Â· {me?.followers?.total || 0} followers
            </Text>
          </View>
          <TouchableOpacity testID="spotify-signout" onPress={onSignOut}>
            <Ionicons name="log-out" size={22} color={COLORS.textDim} />
          </TouchableOpacity>
        </View>
      </Glass>

      {/* Broadcast card â only the community admin sees this. Push the
          currently-playing track to every member of the active convoy.
          Members see a toast on the map screen with the track + caller name.
          Broadcast repeats every 10s so members who reconnect mid-song still
          pick it up. */}
      {isAdmin && (
        <View style={styles.broadcastCard}>
          <View style={styles.broadcastHeader}>
            <Ionicons name="radio" size={18} color="#FFD60A" />
            <Text style={styles.broadcastTitle}>Broadcast to Community</Text>
            {/* Quality badge â color-coded per tier so the admin sees
                instantly what bitrate the convoy is receiving. Pulls live
                from the proximity store, no extra props needed. */}
            <View style={[
              styles.qualityBadge,
              musicQuality === "lossless" && { backgroundColor: "rgba(52,199,89,0.18)", borderColor: "rgba(52,199,89,0.55)" },
              musicQuality === "high"     && { backgroundColor: "rgba(255,149,0,0.18)", borderColor: "rgba(255,149,0,0.55)" },
              musicQuality === "normal"   && { backgroundColor: "rgba(142,142,147,0.18)", borderColor: "rgba(142,142,147,0.55)" },
            ]}>
              <Ionicons
                name={musicQuality === "lossless" ? "headset" : musicQuality === "high" ? "musical-note" : "radio-outline"}
                size={11}
                color={musicQuality === "lossless" ? "#34C759" : musicQuality === "high" ? "#FF9500" : "#8E8E93"}
              />
              <Text style={[
                styles.qualityBadgeText,
                { color: musicQuality === "lossless" ? "#34C759" : musicQuality === "high" ? "#FF9500" : "#8E8E93" },
              ]}>
                {musicQuality === "lossless" ? "LOSSLESS" : musicQuality === "high" ? "HQ" : "STANDARD"}
              </Text>
            </View>
          </View>
          <Text style={styles.broadcastSub}>
            {currentTrack ? (
              <>
                {proximityPeers} {proximityPeers === 1 ? "car" : "cars"} in convoy
                {" Â· "}
                {musicQuality === "lossless" ? "320 kbps OGG" : musicQuality === "high" ? "160 kbps OGG" : "96 kbps OGG"}
              </>
            ) : (
              "Start playing a track on Spotify, then broadcast it to your convoy"
            )}
          </Text>
          <TouchableOpacity
            testID="music-broadcast-toggle"
            style={[styles.broadcastBtn, isBroadcasting && styles.broadcastBtnActive, !currentTrack && !isBroadcasting && styles.broadcastBtnDisabled]}
            onPress={toggleBroadcast}
            disabled={!currentTrack && !isBroadcasting}
            activeOpacity={0.85}
          >
            <Ionicons
              name={isBroadcasting ? "stop-circle" : "radio"}
              size={20}
              color={isBroadcasting ? "#FF3B30" : "#1C1C1E"}
            />
            <Text style={[styles.broadcastBtnText, isBroadcasting && { color: "#FF3B30" }]}>
              {isBroadcasting ? "Stop Broadcasting" : "Start Broadcasting"}
            </Text>
          </TouchableOpacity>
        </View>
      )}

      {loading && <ActivityIndicator color={COLORS.primary} style={{ marginVertical: 12 }} />}

      <Text style={styles.section}>Your top tracks</Text>
      {tracks.length === 0 && !loading && <Text style={styles.empty}>No top tracks yet â listen to Spotify a bit to build this list.</Text>}
      {tracks.map((t) => (
        <Glass key={t.id} radius={14} style={{ marginBottom: 8 }}>
          <TouchableOpacity
            testID={`track-${t.id}`}
            style={styles.row}
            onPress={() => openSpotifyExternal(t.external_urls?.spotify, t.uri)}
          >
            <Image source={{ uri: t.album?.images?.[2]?.url || t.album?.images?.[0]?.url }} style={styles.thumb} />
            <View style={{ flex: 1 }}>
              <Text style={styles.rowTitle} numberOfLines={1}>{t.name}</Text>
              <Text style={styles.rowSub} numberOfLines={1}>{t.artists?.map((a: any) => a.name).join(", ")}</Text>
            </View>
            <Ionicons name="open-outline" size={18} color={COLORS.textDim} />
          </TouchableOpacity>
        </Glass>
      ))}

      <Text style={styles.section}>Your playlists</Text>
      {playlists.length === 0 && !loading && <Text style={styles.empty}>No playlists yet.</Text>}
      {playlists.map((p) => (
        <Glass key={p.id} radius={14} style={{ marginBottom: 8 }}>
          <TouchableOpacity
            testID={`playlist-${p.id}`}
            style={styles.row}
            onPress={() => openSpotifyExternal(p.external_urls?.spotify, p.uri)}
          >
            <Image source={{ uri: p.images?.[0]?.url }} style={styles.thumb} />
            <View style={{ flex: 1 }}>
              <Text style={styles.rowTitle} numberOfLines={1}>{p.name}</Text>
              <Text style={styles.rowSub} numberOfLines={1}>{p.tracks?.total || 0} songs Â· {p.owner?.display_name}</Text>
            </View>
            <Ionicons name="open-outline" size={18} color={COLORS.textDim} />
          </TouchableOpacity>
        </Glass>
      ))}
    </ScrollView>
  );
}

/**
 * Open a Spotify entity (track / playlist) in the native Spotify app first,
 * fall back to https://open.spotify.com.
 *
 * Spotify URIs look like  spotify:track:abc123  or  spotify:playlist:xyz789.
 * Tapping a https://open.spotify.com URL on iOS shows a black Safari blink
 * before the Universal Link kicks in (and sometimes never does on Expo Go).
 * Calling spotify://<uri-tail> opens the app instantly when installed.
 */
async function openSpotifyExternal(httpsUrl?: string, uri?: string) {
  // Convert "spotify:track:abc" â "track/abc" for both the deep-link path and
  // the https fallback (open.spotify.com/track/abc).
  let pathTail = "";
  if (uri && uri.startsWith("spotify:")) {
    const parts = uri.split(":"); // ["spotify", "track", "abc"]
    if (parts.length >= 3) pathTail = `${parts[1]}/${parts.slice(2).join(":")}`;
  } else if (httpsUrl) {
    // Strip the https://open.spotify.com/ prefix to get the same tail shape.
    pathTail = httpsUrl.replace(/^https?:\/\/open\.spotify\.com\//, "");
  }

  const candidates = [
    pathTail ? `spotify://${pathTail}` : `spotify://`,
    httpsUrl || (pathTail ? `https://open.spotify.com/${pathTail}` : "https://open.spotify.com"),
  ];
  for (const url of candidates) {
    if (!url) continue;
    try {
      const ok = await Linking.canOpenURL(url);
      if (ok) {
        await Linking.openURL(url);
        return;
      }
    } catch {
      // ignore â try next
    }
  }
  // Final fallback â best-effort https
  try { await Linking.openURL(candidates[1] || "https://open.spotify.com"); } catch {}
}

const styles = StyleSheet.create({
  comingSub: { color: '#8E8E93', fontSize: 13, textAlign: 'center', marginTop: 4 },
  c: { flex: 1, backgroundColor: COLORS.bg },
  header: { paddingHorizontal: 18, paddingTop: 8 },
  title: { color: COLORS.text, fontSize: 34, fontWeight: "700", letterSpacing: -1 },
  sub: { color: COLORS.textDim, marginTop: 2, fontSize: 13 },
  tabs: { flexDirection: "row", paddingHorizontal: 16, paddingTop: 14, gap: 8 },
  tab: { flex: 1, flexDirection: "row", justifyContent: "center", alignItems: "center", padding: 12, borderRadius: 12, backgroundColor: "rgba(118,118,128,0.18)", gap: 6 },
  tabActive: { backgroundColor: COLORS.primary },
  tabText: { color: COLORS.text, fontSize: 13, fontWeight: "500" },

  signinWrap: { flex: 1, alignItems: "center", justifyContent: "center", padding: 24 },
  signTitle: { color: COLORS.text, fontSize: 22, fontWeight: "700", letterSpacing: -0.4, marginTop: 14 },
  signText: { color: COLORS.textDim, textAlign: "center", marginTop: 8, fontSize: 14, lineHeight: 20 },
  spotifyBtn: { marginTop: 20, borderRadius: 14, overflow: "hidden", alignSelf: "stretch" },
  spotifyGrad: { paddingVertical: 14, alignItems: "center", justifyContent: "center", flexDirection: "row", gap: 10 },
  spotifyText: { color: "#fff", fontWeight: "700", fontSize: 16 },

  comingWrap: { flex: 1, alignItems: "center", justifyContent: "center", padding: 24 },
  comingIcon: { width: 76, height: 76, borderRadius: 38, backgroundColor: COLORS.warning + "22", alignItems: "center", justifyContent: "center", marginBottom: 14 },
  comingTitle: { color: COLORS.text, fontSize: 22, fontWeight: "700", letterSpacing: -0.4 },
  openBtn: { flexDirection: "row", alignItems: "center", gap: 6, marginTop: 14, backgroundColor: COLORS.primary, paddingVertical: 10, paddingHorizontal: 18, borderRadius: 12 },
  openBtnText: { color: "#fff", fontWeight: "600", fontSize: 14 },
  comingText: { color: COLORS.textDim, textAlign: "center", marginTop: 8, fontSize: 14, lineHeight: 20 },

  profileRow: { flexDirection: "row", alignItems: "center", padding: 14, gap: 12 },
  profileAvatar: { width: 48, height: 48, borderRadius: 24 },
  profileName: { color: COLORS.text, fontWeight: "600", fontSize: 16 },
  profileMeta: { color: COLORS.textDim, fontSize: 12, marginTop: 2 },

  section: { color: COLORS.textDim, marginTop: 18, marginBottom: 8, fontSize: 13, fontWeight: "500", paddingHorizontal: 4 },
  empty: { color: COLORS.textMute, fontSize: 13, paddingHorizontal: 4 },
  row: { flexDirection: "row", alignItems: "center", padding: 10, gap: 12 },
  thumb: { width: 48, height: 48, borderRadius: 8, backgroundColor: "#222" },
  rowTitle: { color: COLORS.text, fontWeight: "500" },
  rowSub: { color: COLORS.textDim, fontSize: 12, marginTop: 2 },

  // ===== App-icon-style service selector =====
  serviceRow: {
    flexDirection: 'row',
    justifyContent: 'center',
    gap: 24,
    marginTop: 20,
    marginBottom: 28,
  },
  serviceIcon: { alignItems: 'center', gap: 8 },
  serviceIconBg: {
    width: 72, height: 72,
    borderRadius: 16,   // iPhone-style "squircle" feel
    alignItems: 'center', justifyContent: 'center',
    shadowColor: '#000', shadowOpacity: 0.35, shadowRadius: 8, shadowOffset: { width: 0, height: 4 },
    elevation: 6,
  },
  serviceIconSelected: { transform: [{ scale: 1.08 }] },
  serviceLabel: { color: 'rgba(255,255,255,0.55)', fontSize: 12, fontWeight: '500' },
  serviceLabelSelected: { color: '#FFFFFF', fontWeight: '700' },
  serviceSelectedDot: {
    width: 5, height: 5,
    borderRadius: 2.5,
    backgroundColor: '#FFD60A',   // Convoy gold dot under the active label
  },

  // ===== Admin broadcast card =====
  broadcastCard: {
    marginBottom: 14, padding: 16,
    backgroundColor: 'rgba(255,255,255,0.06)',
    borderRadius: 16,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: 'rgba(255,214,10,0.3)',
  },
  broadcastHeader: { flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 6 },
  broadcastTitle: { color: '#FFD60A', fontSize: 15, fontWeight: '700', flex: 1 },
  // Tier-color quality pill that lives in the broadcast card header.
  qualityBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 8,
    borderWidth: StyleSheet.hairlineWidth,
  },
  qualityBadgeText: {
    fontSize: 10,
    fontWeight: '800',
    letterSpacing: 0.6,
  },
  broadcastSub: { color: 'rgba(255,255,255,0.5)', fontSize: 13, marginBottom: 14 },
  broadcastBtn: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center',
    gap: 8, backgroundColor: '#FFD60A',
    paddingVertical: 12, borderRadius: 12,
  },
  broadcastBtnActive: { backgroundColor: 'rgba(255,59,48,0.15)', borderWidth: 1, borderColor: '#FF3B30' },
  broadcastBtnDisabled: { opacity: 0.45 },
  broadcastBtnText: { color: '#1C1C1E', fontSize: 15, fontWeight: '700' },
});
