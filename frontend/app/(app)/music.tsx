import React, { useCallback, useState } from "react";
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  ScrollView,
  Linking,
  Platform,
  TextInput,
  ActivityIndicator,
} from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { SafeAreaView } from "react-native-safe-area-context";
import { LinearGradient } from "expo-linear-gradient";
import { Image } from "expo-image";
import { COLORS } from "../../src/theme";
import LogoMenu from "../../src/components/LogoMenu";
import {
  isMusicSupported,
  authorize,
  checkSubscription,
  searchSongs,
  playSong,
  toggle,
  skipNext,
  skipPrev,
  useCurrentSong,
  useIsPlaying,
  type AppleSong,
} from "../../src/applePlayer";

// Apple Music brand red → pink.
const AM_PINK: [string, string] = ["#FB5C74", "#FA2D48"];

/**
 * Deep-link into the Apple Music app — used as a fallback when on-device
 * MusicKit playback isn't available (non-iOS) or the user needs to subscribe.
 * Tries native music:// first, then itms-music://, then the public https URL.
 */
async function openAppleMusic(path?: string): Promise<boolean> {
  const candidates =
    Platform.OS === "ios"
      ? [`music://${path ?? ""}`, `itms-music://${path ?? ""}`, `https://music.apple.com${path ? "/" + path : ""}`]
      : [`https://music.apple.com${path ? "/" + path : ""}`];
  for (const url of candidates) {
    try {
      if (await Linking.canOpenURL(url)) {
        await Linking.openURL(url);
        return true;
      }
    } catch {
      // canOpenURL throws on iOS for unregistered schemes — try the next one.
    }
  }
  try {
    await Linking.openURL(candidates[candidates.length - 1]);
    return true;
  } catch {
    return false;
  }
}

/** Resolve an Apple artwork template/url to a concrete square image URL. */
function artURL(raw?: string, size = 120): string | undefined {
  if (!raw || typeof raw !== "string") return undefined;
  return raw.replace("{w}", String(size)).replace("{h}", String(size)).replace("{f}", "jpg");
}

export default function MusicScreen() {
  // Apple Music "Listen Now" date overline — built from arrays rather than
  // toLocaleDateString so it renders identically regardless of Hermes' Intl.
  const d = new Date();
  const DAYS = ["SUNDAY", "MONDAY", "TUESDAY", "WEDNESDAY", "THURSDAY", "FRIDAY", "SATURDAY"];
  const MONTHS = ["JANUARY", "FEBRUARY", "MARCH", "APRIL", "MAY", "JUNE", "JULY", "AUGUST", "SEPTEMBER", "OCTOBER", "NOVEMBER", "DECEMBER"];
  const today = `${DAYS[d.getDay()]}, ${MONTHS[d.getMonth()]} ${d.getDate()}`;

  const [authorized, setAuthorized] = useState(false);
  const [canPlay, setCanPlay] = useState<boolean | null>(null);
  const [connecting, setConnecting] = useState(false);

  const [query, setQuery] = useState("");
  const [results, setResults] = useState<AppleSong[]>([]);
  const [searching, setSearching] = useState(false);
  const [searched, setSearched] = useState(false);

  // Reactive now-playing state from the native player (no-ops off iOS).
  const { song } = useCurrentSong() as { song: any };
  const { isPlaying } = useIsPlaying();

  const handleConnect = useCallback(async () => {
    setConnecting(true);
    try {
      const ok = await authorize();
      setAuthorized(ok);
      if (ok) {
        const sub = await checkSubscription();
        setCanPlay(sub.canPlay);
      }
    } finally {
      setConnecting(false);
    }
  }, []);

  const runSearch = useCallback(async () => {
    const q = query.trim();
    if (!q) return;
    setSearching(true);
    setSearched(true);
    try {
      setResults(await searchSongs(q));
    } finally {
      setSearching(false);
    }
  }, [query]);

  const ready = isMusicSupported && authorized && canPlay === true;
  const nowPlaying = song && (song.title || song.name);

  return (
    <SafeAreaView style={styles.c} edges={["top"]}>
      <ScrollView
        contentContainerStyle={{ paddingBottom: nowPlaying ? 200 : 130 }}
        keyboardShouldPersistTaps="handled"
        showsVerticalScrollIndicator={false}
      >
        {/* Header — Apple Music "Listen Now" style. */}
        <View style={styles.header}>
          <View style={{ flex: 1 }}>
            <Text style={styles.dateOverline}>{today}</Text>
            <Text style={styles.title}>Listen Now</Text>
          </View>
          <LogoMenu size={30} style={styles.logoBtn} />
        </View>

        {/* ---- Search + results (only once connected & subscribed) ---- */}
        {ready && (
          <>
            <View style={styles.searchWrap}>
              <Ionicons name="search" size={18} color={COLORS.textDim} />
              <TextInput
                value={query}
                onChangeText={setQuery}
                onSubmitEditing={runSearch}
                returnKeyType="search"
                placeholder="Songs, artists, albums"
                placeholderTextColor={COLORS.textDim}
                style={styles.searchInput}
                autoCorrect={false}
                testID="am-search-input"
              />
              {query.length > 0 && (
                <TouchableOpacity onPress={() => { setQuery(""); setResults([]); setSearched(false); }}>
                  <Ionicons name="close-circle" size={18} color={COLORS.textDim} />
                </TouchableOpacity>
              )}
            </View>

            {searching && <ActivityIndicator color={AM_PINK[0]} style={{ marginTop: 24 }} />}

            {!searching && searched && results.length === 0 && (
              <Text style={styles.empty}>No songs found. Try another search.</Text>
            )}

            {!searching && results.length > 0 && (
              <View style={styles.results}>
                {results.map((s, i) => (
                  <TouchableOpacity
                    key={s.id || String(i)}
                    style={[styles.row, i === results.length - 1 && styles.rowLast]}
                    activeOpacity={0.7}
                    onPress={() => playSong(s.id)}
                    testID={`am-result-${i}`}
                  >
                    {s.artworkUrl ? (
                      <Image source={{ uri: artURL(s.artworkUrl, 100) }} style={styles.rowArt} contentFit="cover" />
                    ) : (
                      <View style={[styles.rowArt, styles.rowArtPlaceholder]}>
                        <Ionicons name="musical-note" size={18} color={COLORS.textDim} />
                      </View>
                    )}
                    <View style={{ flex: 1 }}>
                      <Text style={styles.rowTitle} numberOfLines={1}>{s.title ?? "Unknown"}</Text>
                      <Text style={styles.rowSub} numberOfLines={1}>{s.artistName ?? ""}</Text>
                    </View>
                    <Ionicons name="play-circle" size={26} color={AM_PINK[1]} />
                  </TouchableOpacity>
                ))}
              </View>
            )}

            {!searched && (
              <Text style={styles.hint}>Search Apple Music and tap a song to play it right here.</Text>
            )}
          </>
        )}

        {/* ---- Connect hero (iOS, not yet authorized) ---- */}
        {isMusicSupported && !ready && (
          <TouchableOpacity
            activeOpacity={0.9}
            onPress={authorized && canPlay === false ? () => openAppleMusic() : handleConnect}
            disabled={connecting}
            testID="apple-music-connect"
            style={styles.heroWrap}
          >
            <LinearGradient colors={AM_PINK} start={{ x: 0, y: 0 }} end={{ x: 1, y: 1 }} style={styles.hero}>
              <View style={styles.heroLogo}>
                <Ionicons name="musical-notes" size={30} color="#fff" />
              </View>
              <Text style={styles.heroTitle}>Apple Music</Text>
              <Text style={styles.heroSub}>
                {authorized && canPlay === false
                  ? "You're connected, but an active Apple Music subscription is needed to play full songs."
                  : "Connect your Apple Music account to search and play over 100 million songs right inside Convoy."}
              </Text>
              <View style={styles.heroBtn}>
                {connecting ? (
                  <ActivityIndicator color={AM_PINK[1]} />
                ) : (
                  <>
                    <Ionicons
                      name={authorized && canPlay === false ? "open-outline" : "link"}
                      size={16}
                      color={AM_PINK[1]}
                    />
                    <Text style={styles.heroBtnText}>
                      {authorized && canPlay === false ? "Open Apple Music" : "Connect Apple Music"}
                    </Text>
                  </>
                )}
              </View>
              <Text style={styles.heroNote}>Apple Music subscription required</Text>
            </LinearGradient>
          </TouchableOpacity>
        )}

        {/* ---- Non-iOS fallback: deep-link only ---- */}
        {!isMusicSupported && (
          <TouchableOpacity activeOpacity={0.9} onPress={() => openAppleMusic()} testID="apple-music-open" style={styles.heroWrap}>
            <LinearGradient colors={AM_PINK} start={{ x: 0, y: 0 }} end={{ x: 1, y: 1 }} style={styles.hero}>
              <View style={styles.heroLogo}>
                <Ionicons name="musical-notes" size={30} color="#fff" />
              </View>
              <Text style={styles.heroTitle}>Apple Music</Text>
              <Text style={styles.heroSub}>
                In-app playback is available on iPhone. Tap to open Apple Music on this device.
              </Text>
              <View style={styles.heroBtn}>
                <Ionicons name="open-outline" size={16} color={AM_PINK[1]} />
                <Text style={styles.heroBtnText}>Open Apple Music</Text>
              </View>
              <Text style={styles.heroNote}>Apple Music subscription required</Text>
            </LinearGradient>
          </TouchableOpacity>
        )}

        <Text style={styles.footer}>
          Convoy plays Apple Music through your own subscription. Your library, account, and billing
          stay with Apple Music.
        </Text>
      </ScrollView>

      {/* ---- Now-playing bar ---- */}
      {nowPlaying && (
        <View style={styles.nowBar}>
          {artURL(song?.artworkUrl ?? song?.artwork?.url, 96) ? (
            <Image source={{ uri: artURL(song?.artworkUrl ?? song?.artwork?.url, 96) }} style={styles.nowArt} contentFit="cover" />
          ) : (
            <View style={[styles.nowArt, styles.rowArtPlaceholder]}>
              <Ionicons name="musical-note" size={16} color={COLORS.textDim} />
            </View>
          )}
          <View style={{ flex: 1 }}>
            <Text style={styles.nowTitle} numberOfLines={1}>{song?.title ?? song?.name ?? "Now Playing"}</Text>
            <Text style={styles.nowSub} numberOfLines={1}>{song?.artistName ?? song?.artist ?? ""}</Text>
          </View>
          <TouchableOpacity onPress={() => skipPrev()} hitSlop={8} testID="am-prev">
            <Ionicons name="play-skip-back" size={22} color={COLORS.text} />
          </TouchableOpacity>
          <TouchableOpacity onPress={() => toggle()} hitSlop={8} style={{ marginHorizontal: 14 }} testID="am-toggle">
            <Ionicons name={isPlaying ? "pause" : "play"} size={26} color={COLORS.text} />
          </TouchableOpacity>
          <TouchableOpacity onPress={() => skipNext()} hitSlop={8} testID="am-next">
            <Ionicons name="play-skip-forward" size={22} color={COLORS.text} />
          </TouchableOpacity>
        </View>
      )}
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  c: { flex: 1, backgroundColor: COLORS.bg },

  header: { flexDirection: "row", alignItems: "center", paddingHorizontal: 20, paddingTop: 10, paddingBottom: 6 },
  dateOverline: { color: "rgba(235,235,245,0.5)", fontSize: 13, fontWeight: "700", letterSpacing: 0.4 },
  title: { color: COLORS.text, fontSize: 34, fontWeight: "800", letterSpacing: -1, marginTop: 2 },
  logoBtn: { padding: 4 },

  // ===== Search =====
  searchWrap: {
    flexDirection: "row", alignItems: "center", gap: 8,
    marginHorizontal: 20, marginTop: 14, paddingHorizontal: 14, height: 44,
    backgroundColor: "rgba(255,255,255,0.08)", borderRadius: 12,
  },
  searchInput: { flex: 1, color: COLORS.text, fontSize: 16, paddingVertical: 0 },
  hint: { color: COLORS.textDim, fontSize: 14, lineHeight: 20, paddingHorizontal: 22, marginTop: 18 },
  empty: { color: COLORS.textDim, fontSize: 15, textAlign: "center", marginTop: 26 },

  // ===== Results list =====
  results: {
    marginTop: 18, marginHorizontal: 20,
    backgroundColor: "rgba(255,255,255,0.05)",
    borderRadius: 14, overflow: "hidden",
    borderWidth: StyleSheet.hairlineWidth, borderColor: "rgba(255,255,255,0.08)",
  },
  row: {
    flexDirection: "row", alignItems: "center", gap: 12,
    paddingHorizontal: 12, paddingVertical: 8,
    borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: "rgba(255,255,255,0.08)",
  },
  rowLast: { borderBottomWidth: 0 },
  rowArt: { width: 48, height: 48, borderRadius: 6, backgroundColor: "rgba(255,255,255,0.06)" },
  rowArtPlaceholder: { alignItems: "center", justifyContent: "center" },
  rowTitle: { color: COLORS.text, fontSize: 15, fontWeight: "600" },
  rowSub: { color: COLORS.textDim, fontSize: 13, marginTop: 1 },

  // ===== Apple Music connect hero =====
  heroWrap: {
    marginHorizontal: 20, marginTop: 16, borderRadius: 20, overflow: "hidden",
    shadowColor: "#FA2D48", shadowOpacity: 0.4, shadowRadius: 16, shadowOffset: { width: 0, height: 8 }, elevation: 10,
  },
  hero: { padding: 22 },
  heroLogo: {
    width: 52, height: 52, borderRadius: 14,
    backgroundColor: "rgba(255,255,255,0.18)", alignItems: "center", justifyContent: "center",
  },
  heroTitle: { color: "#fff", fontSize: 26, fontWeight: "800", letterSpacing: -0.6, marginTop: 14 },
  heroSub: { color: "rgba(255,255,255,0.92)", fontSize: 14, lineHeight: 20, marginTop: 6 },
  heroBtn: {
    flexDirection: "row", alignItems: "center", gap: 6, alignSelf: "flex-start",
    backgroundColor: "#fff", paddingVertical: 10, paddingHorizontal: 16, borderRadius: 999, marginTop: 18, minHeight: 40,
  },
  heroBtnText: { color: "#FA2D48", fontSize: 14, fontWeight: "800", letterSpacing: 0.2 },
  heroNote: { color: "rgba(255,255,255,0.85)", fontSize: 12, fontWeight: "600", marginTop: 14 },

  footer: { color: "rgba(235,235,245,0.45)", fontSize: 12, lineHeight: 18, textAlign: "center", paddingHorizontal: 24, marginTop: 26 },

  // ===== Now-playing bar =====
  nowBar: {
    position: "absolute", left: 12, right: 12, bottom: 96,
    flexDirection: "row", alignItems: "center", gap: 12,
    paddingHorizontal: 12, paddingVertical: 10,
    backgroundColor: "rgba(34,35,38,0.98)", borderRadius: 16,
    borderWidth: StyleSheet.hairlineWidth, borderColor: "rgba(255,255,255,0.12)",
    shadowColor: "#000", shadowOpacity: 0.4, shadowRadius: 12, shadowOffset: { width: 0, height: 6 }, elevation: 12,
  },
  nowArt: { width: 44, height: 44, borderRadius: 8, backgroundColor: "rgba(255,255,255,0.06)" },
  nowTitle: { color: COLORS.text, fontSize: 14, fontWeight: "700" },
  nowSub: { color: COLORS.textDim, fontSize: 12, marginTop: 1 },
});
