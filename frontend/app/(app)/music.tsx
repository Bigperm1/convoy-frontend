import React, { useState, useEffect } from "react";
import { View, Text, StyleSheet, TouchableOpacity, Image, ScrollView, ActivityIndicator, Linking, Platform, Alert } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { SafeAreaView } from "react-native-safe-area-context";
import { LinearGradient } from "expo-linear-gradient";
import { COLORS } from "../../src/theme";
import Glass from "../../src/Glass";
import { startLogin, getStoredToken, logout, spotify, isConfigured } from "../../src/spotify";

type Source = "spotify" | "apple" | "soundcloud";

/**
 * Deep-link to a music app on the user's phone.
 *
 * Tries the native URL scheme first (which jumps straight to the installed app
 * with no browser intermediary — fixing the "black Safari blink" the user was
 * seeing in the field), then falls back to the public https URL if the scheme
 * isn't registered (app not installed).
 *
 * Native schemes per platform:
 *   Apple Music (iOS)   → music://             (Music app)
 *   Apple Music (web)   → https://music.apple.com
 *   Spotify  (iOS/Android) → spotify://         (Spotify app)
 *   Spotify  (fallback) → https://open.spotify.com
 *   SoundCloud          → soundcloud://         (SoundCloud app)
 *   SoundCloud (fallback) → https://soundcloud.com
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
      // canOpenURL throws on iOS for unregistered schemes — try next candidate.
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

      <View style={styles.tabs}>
        {(["spotify", "apple", "soundcloud"] as Source[]).map((s) => (
          <TouchableOpacity key={s} testID={`music-${s}`} style={[styles.tab, source === s && styles.tabActive]} onPress={() => setSource(s)}>
            <Ionicons
              name={s === "spotify" ? "musical-note" : s === "apple" ? "logo-apple" : "cloud"}
              size={16}
              color={source === s ? "#fff" : COLORS.text}
            />
            <Text style={[styles.tabText, source === s && { color: "#fff", fontWeight: "600" }]}>
              {s === "soundcloud" ? "SoundCloud" : s === "apple" ? "Apple Music" : "Spotify"}
            </Text>
          </TouchableOpacity>
        ))}
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
  const [signedIn, setSignedIn] = useState<boolean>(false);
  const [me, setMe] = useState<any>(null);
  const [tracks, setTracks] = useState<any[]>([]);
  const [playlists, setPlaylists] = useState<any[]>([]);
  const [loading, setLoading] = useState(false);

  const refresh = async () => {
    const t = getStoredToken();
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
    } catch (e: any) {
      // Token may have been revoked; clear it
      logout(); setSignedIn(false);
    } finally { setLoading(false); }
  };

  useEffect(() => { refresh(); }, []);

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

  const onSignOut = () => {
    logout(); setSignedIn(false); setMe(null); setTracks([]); setPlaylists([]);
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
              {me?.product === "premium" ? "Premium" : "Free"} · {me?.followers?.total || 0} followers
            </Text>
          </View>
          <TouchableOpacity testID="spotify-signout" onPress={onSignOut}>
            <Ionicons name="log-out" size={22} color={COLORS.textDim} />
          </TouchableOpacity>
        </View>
      </Glass>

      {loading && <ActivityIndicator color={COLORS.primary} style={{ marginVertical: 12 }} />}

      <Text style={styles.section}>Your top tracks</Text>
      {tracks.length === 0 && !loading && <Text style={styles.empty}>No top tracks yet — listen to Spotify a bit to build this list.</Text>}
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
              <Text style={styles.rowSub} numberOfLines={1}>{p.tracks?.total || 0} songs · {p.owner?.display_name}</Text>
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
  // Convert "spotify:track:abc" → "track/abc" for both the deep-link path and
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
      // ignore — try next
    }
  }
  // Final fallback — best-effort https
  try { await Linking.openURL(candidates[1] || "https://open.spotify.com"); } catch {}
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
});
