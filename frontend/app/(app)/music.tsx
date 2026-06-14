import React, { useCallback, useEffect, useRef, useState } from "react";
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
  Modal,
  Alert,
} from "react-native";
import { Ionicons, MaterialCommunityIcons } from "@expo/vector-icons";
import { SafeAreaView } from "react-native-safe-area-context";
import { useSettings, updateSettings } from "../../src/settings";
import { startLogin, getStoredToken } from "../../src/spotify";
import SpotifyMusic from "../../src/SpotifyMusic";
import { LinearGradient } from "expo-linear-gradient";
import { Image } from "expo-image";
import { COLORS } from "../../src/theme";
import LogoMenu from "../../src/components/LogoMenu";
import * as Haptics from "expo-haptics";
import ShareSheet from "../../src/ShareSheet";
import {
  isMusicSupported,
  authorize,
  checkSubscription,
  searchSongsDiagnostic,
  getUserPlaylists,
  getLibrarySongs,
  getRecentlyPlayed,
  getPlaylistSongs,
  playSong,
  playLibrarySong,
  playLibraryPlaylist,
  playRecentItem,
  toggle,
  skipNext,
  skipPrev,
  setShuffle,
  useCurrentSong,
  useIsPlaying,
  type AppleSong,
  type ApplePlaylist,
  type RecentItem,
} from "../../src/applePlayer";
import { useFocusEffect } from "expo-router";
import { shareInbox } from "../../src/shareInbox";

// Apple Music brand red → pink.
const AM_PINK: [string, string] = ["#FB5C74", "#FA2D48"];
// Spotify brand green.
const SP_GREEN = "#1DB954";

// Segmented switcher to flip the active player directly (Apple Music ⇄ Spotify)
// without going back to the first-run picker. Switching to Spotify when it isn't
// linked yet kicks off its login (the callback flips the source on success).
function SourceSwitcher({ current }: { current: "apple" | "spotify" }) {
  const pill = (key: "apple" | "spotify", label: string, color: string) => {
    const active = current === key;
    return (
      <TouchableOpacity
        key={key}
        activeOpacity={0.85}
        onPress={async () => {
          if (key === current) return;
          if (key === "spotify" && !(await getStoredToken())) { startLogin().catch(() => {}); return; }
          updateSettings({ musicSource: key });
        }}
        style={[swStyles.pill, active && { backgroundColor: color }]}
      >
        <MaterialCommunityIcons name={key === "apple" ? "apple" : "spotify"} size={14} color={active ? "#fff" : COLORS.textDim} />
        <Text style={[swStyles.pillText, active && { color: "#fff" }]}>{label}</Text>
      </TouchableOpacity>
    );
  };
  return (
    <View style={swStyles.wrap}>
      {pill("apple", "Apple Music", "#FA2D48")}
      {pill("spotify", "Spotify", SP_GREEN)}
    </View>
  );
}

const swStyles = StyleSheet.create({
  wrap: { flexDirection: "row", gap: 6, backgroundColor: "rgba(255,255,255,0.06)", borderRadius: 12, padding: 4, alignSelf: "flex-start", marginHorizontal: 20, marginBottom: 6 },
  pill: { flexDirection: "row", alignItems: "center", gap: 5, paddingHorizontal: 12, paddingVertical: 7, borderRadius: 9 },
  pillText: { color: COLORS.textDim, fontSize: 13, fontWeight: "700" },
});

/**
 * Deep-link into the Apple Music app — used as a fallback when on-device
 * MusicKit playback isn't available (non-iOS) or the user needs to subscribe.
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

/**
 * Premium empty-state cover. Apple Music's library API returns no usable
 * artwork for the user's own songs/playlists, so instead of a flat grey note we
 * render a deterministic gradient + initial (à la Apple Music's own auto-
 * generated covers) so the art-less state reads as intentional, not broken.
 */
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
function ArtFallback({ seed, size, radius }: { seed?: string; size: number; radius: number }) {
  const key = seed && seed.trim() ? seed : "?";
  const pair = ART_GRADIENTS[artHashIndex(key)];
  return (
    <LinearGradient
      colors={pair}
      start={{ x: 0, y: 0 }}
      end={{ x: 1, y: 1 }}
      style={{ width: size, height: size, borderRadius: radius, alignItems: "center", justifyContent: "center" }}
    >
      <Text style={{ color: "rgba(255,255,255,0.95)", fontSize: Math.round(size * 0.42), fontWeight: "800", letterSpacing: 0.5 }}>
        {artInitial(key)}
      </Text>
    </LinearGradient>
  );
}

export default function MusicScreen() {
  // "Listen Now" date overline — built from arrays rather than
  // toLocaleDateString so it renders identically regardless of Hermes' Intl.
  const d = new Date();
  const DAYS = ["SUNDAY", "MONDAY", "TUESDAY", "WEDNESDAY", "THURSDAY", "FRIDAY", "SATURDAY"];
  const MONTHS = ["JANUARY", "FEBRUARY", "MARCH", "APRIL", "MAY", "JUNE", "JULY", "AUGUST", "SEPTEMBER", "OCTOBER", "NOVEMBER", "DECEMBER"];
  const today = `${DAYS[d.getDay()]}, ${MONTHS[d.getMonth()]} ${d.getDate()}`;

  // Chosen music source ('apple' | 'spotify' | null). null → show the picker.
  const [settings] = useSettings();
  const source = settings.musicSource ?? null;

  const [authorized, setAuthorized] = useState(false);
  // True only during the cold-start silent auth check, so we show a spinner
  // instead of briefly flashing the "Connect Apple Music" hero before the
  // already-granted authorization resolves and the dashboard appears.
  const [initializing, setInitializing] = useState(isMusicSupported);
  const [canPlay, setCanPlay] = useState<boolean | null>(null);
  const [connecting, setConnecting] = useState(false);
  // Apple shuffle is write-only (MusicKit doesn't report it back), so track it
  // locally and toggle optimistically.
  const [appleShuffle, setAppleShuffle] = useState(false);
  const toggleAppleShuffle = () => { const ns = !appleShuffle; setAppleShuffle(ns); setShuffle(ns); };
  // Slide-up "share to members" sheet for the now-playing track.
  const [shareOpen, setShareOpen] = useState(false);
  // Playlist detail sheet — tapping a playlist opens its track list instead of
  // immediately playing the whole playlist.
  const [detailPlaylist, setDetailPlaylist] = useState<ApplePlaylist | null>(null);
  const [detailSongs, setDetailSongs] = useState<AppleSong[]>([]);
  const [detailLoading, setDetailLoading] = useState(false);

  // Search (catalog)
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<AppleSong[]>([]);
  const [searching, setSearching] = useState(false);
  const [searched, setSearched] = useState(false);
  const [searchError, setSearchError] = useState<string | null>(null);

  // Library
  const [libLoading, setLibLoading] = useState(false);
  const [playlists, setPlaylists] = useState<ApplePlaylist[]>([]);
  const [librarySongs, setLibrarySongs] = useState<AppleSong[]>([]);
  const [recent, setRecent] = useState<RecentItem[]>([]);
  const [libErrors, setLibErrors] = useState<{ playlists?: string; songs?: string; recent?: string }>({});

  // Reactive now-playing state from the native player (no-ops off iOS).
  const { song } = useCurrentSong() as { song: any };
  const { isPlaying } = useIsPlaying();

  const loadLibrary = useCallback(async () => {
    setLibLoading(true);
    try {
      const [p, s, r] = await Promise.all([
        getUserPlaylists(50),
        getLibrarySongs(60),
        getRecentlyPlayed(),
      ]);
      setPlaylists(p.playlists);
      setLibrarySongs(s.songs);
      setRecent(r.items);
      setLibErrors({ playlists: p.error, songs: s.error, recent: r.error });
    } finally {
      setLibLoading(false);
    }
  }, []);

  // Silent authorization check on mount — if the user already granted access in
  // a prior session this resolves immediately (no OS prompt) and we load the
  // dashboard straight away. First-ever visit shows the prompt, which is the
  // expected "connect" moment for the Music tab.
  const didInit = useRef(false);
  useEffect(() => {
    if (didInit.current || !isMusicSupported) return;
    didInit.current = true;
    (async () => {
      try {
        const ok = await authorize();
        setAuthorized(ok);
        if (ok) {
          checkSubscription().then((sub) => setCanPlay(sub.canPlay));
          loadLibrary();
        }
      } finally {
        setInitializing(false);
      }
    })();
  }, [loadLibrary]);

  const handleConnect = useCallback(async () => {
    setConnecting(true);
    try {
      const ok = await authorize();
      setAuthorized(ok);
      if (ok) {
        updateSettings({ musicSource: "apple" }); // switch the Music tab to Apple Music
        const sub = await checkSubscription();
        setCanPlay(sub.canPlay);
        loadLibrary();
      }
    } finally {
      setConnecting(false);
    }
  }, [loadLibrary]);

  const runSearch = useCallback(async () => {
    const q = query.trim();
    if (!q) return;
    setSearching(true);
    setSearched(true);
    setSearchError(null);
    try {
      const { songs, error } = await searchSongsDiagnostic(q);
      setResults(songs);
      setSearchError(error ?? null);
    } finally {
      setSearching(false);
    }
  }, [query]);

  const clearSearch = () => {
    setQuery("");
    setResults([]);
    setSearched(false);
    setSearchError(null);
  };

  // Open a playlist's track list (instead of auto-playing the whole playlist).
  // Fetches the playlist's songs via the MusicKit bridge; tapping a song plays
  // it, or "Play all" queues the whole playlist.
  const openPlaylistDetail = useCallback(async (p: ApplePlaylist) => {
    setDetailPlaylist(p);
    setDetailSongs([]);
    setDetailLoading(true);
    try {
      const songs = await getPlaylistSongs(p.id);
      setDetailSongs(songs);
    } finally {
      setDetailLoading(false);
    }
  }, []);

  // ----- Receive a shared song -----
  // A crew member's shared track lands in shareInbox (via ShareToast). When we
  // can play (iOS + authorized) we search the catalog and start the top hit;
  // otherwise we prefill the search box so it's ready once they connect.
  // Consumed once — on the ping if this screen is mounted, else on next focus.
  const applyPendingMusic = useCallback(async () => {
    const m = shareInbox.takeMusic();
    if (!m) return;
    const q = [m.title, m.artist].filter(Boolean).join(" ").trim();
    if (!q) return;
    setQuery(q);
    if (!isMusicSupported || !authorized) return;
    setSearched(true);
    setSearching(true);
    setSearchError(null);
    try {
      const { songs, error } = await searchSongsDiagnostic(q);
      setResults(songs);
      setSearchError(error ?? null);
      if (songs && songs.length > 0) await playSong(songs[0].id);
    } finally {
      setSearching(false);
    }
  }, [authorized]);
  useEffect(() => {
    const fn = () => { applyPendingMusic(); };
    return shareInbox.subscribe(fn);
  }, [applyPendingMusic]);
  useFocusEffect(useCallback(() => { applyPendingMusic(); }, [applyPendingMusic]));

  const nowPlaying = song && (song.title || song.name);
  const showingSearch = searched && query.trim().length > 0;
  const anyLibErr = libErrors.playlists || libErrors.songs || libErrors.recent;

  // ---- Row renderer reused by search results + library songs ----
  const SongRow = (s: AppleSong, i: number, onPress: () => void, last: boolean) => (
    <TouchableOpacity
      key={s.id || String(i)}
      style={[styles.row, last && styles.rowLast]}
      activeOpacity={0.7}
      onPress={onPress}
      testID={`am-song-${i}`}
    >
      {artURL(s.artworkUrl, 100) ? (
        <Image source={{ uri: artURL(s.artworkUrl, 100) }} style={styles.rowArt} contentFit="cover" />
      ) : (
        <ArtFallback seed={s.title ?? s.id} size={48} radius={6} />
      )}
      <View style={{ flex: 1 }}>
        <Text style={styles.rowTitle} numberOfLines={1}>{s.title ?? "Unknown"}</Text>
        <Text style={styles.rowSub} numberOfLines={1}>{s.artistName ?? ""}</Text>
      </View>
      <Ionicons name="play-circle" size={26} color={AM_PINK[1]} />
    </TouchableOpacity>
  );

  // ===== Spotify source — its own view (now-playing + Web API controls) =====
  if (source === "spotify") {
    return (
      <>
      <SafeAreaView style={styles.c} edges={["top"]}>
        <View style={styles.header}>
          <View style={{ flex: 1 }}>
            <Text style={styles.dateOverline}>{today}</Text>
            <Text style={styles.title}>Listen Now</Text>
          </View>
        </View>
        <SourceSwitcher current="spotify" />
        <SpotifyMusic onSwitchSource={() => updateSettings({ musicSource: null })} />
      </SafeAreaView>
      <View style={styles.logoBacking}><LogoMenu size={40} align="right" /></View>
      </>
    );
  }

  return (
    <>
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
        </View>

        {source === "apple" && <SourceSwitcher current="apple" />}

        {/* Cold-start: show a spinner while the silent auth check runs, so the
            Connect hero never flashes before the dashboard resolves. */}
        {isMusicSupported && initializing && (
          <ActivityIndicator color={AM_PINK[0]} style={{ marginTop: 48 }} />
        )}

        {/* ===== Authorized: search + library dashboard ===== */}
        {isMusicSupported && authorized && source === "apple" && (
          <>
            {/* Search bar (catalog) */}
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
                <TouchableOpacity onPress={clearSearch}>
                  <Ionicons name="close-circle" size={18} color={COLORS.textDim} />
                </TouchableOpacity>
              )}
            </View>

            {/* ----- Search mode ----- */}
            {showingSearch ? (
              <>
                {searching && <ActivityIndicator color={AM_PINK[0]} style={{ marginTop: 24 }} />}
                {!searching && !!searchError && (
                  <Text style={styles.empty}>Couldn’t search the catalog right now.</Text>
                )}
                {!searching && !searchError && results.length === 0 && (
                  <Text style={styles.empty}>No songs found. Try another search.</Text>
                )}
                {!searching && results.length > 0 && (
                  <View style={styles.list}>
                    {results.map((s, i) => SongRow(s, i, () => playSong(s.id), i === results.length - 1))}
                  </View>
                )}
              </>
            ) : (
              /* ----- Dashboard mode ----- */
              <>
                {libLoading && playlists.length === 0 && librarySongs.length === 0 && recent.length === 0 && (
                  <ActivityIndicator color={AM_PINK[0]} style={{ marginTop: 30 }} />
                )}

                {/* Recently Played */}
                {recent.length > 0 && (
                  <View style={styles.section}>
                    <Text style={styles.sectionTitle}>Recently Played</Text>
                    <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.hStrip}>
                      {recent.map((it, i) => (
                        <TouchableOpacity
                          key={it.id || String(i)}
                          style={styles.recentCard}
                          activeOpacity={0.8}
                          onPress={() => playRecentItem(it)}
                          testID={`am-recent-${i}`}
                        >
                          {artURL(it.artworkUrl, 200) ? (
                            <Image source={{ uri: artURL(it.artworkUrl, 200) }} style={styles.recentArt} contentFit="cover" />
                          ) : (
                            <ArtFallback seed={it.title ?? it.id} size={130} radius={10} />
                          )}
                          <Text style={styles.cardTitle} numberOfLines={1}>{it.title || "Unknown"}</Text>
                          {!!it.subtitle && <Text style={styles.cardSub} numberOfLines={1}>{it.subtitle}</Text>}
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
                          key={p.id || String(i)}
                          style={styles.playlistCard}
                          activeOpacity={0.8}
                          onPress={() => openPlaylistDetail(p)}
                          testID={`am-playlist-${i}`}
                        >
                          {artURL(p.artworkUrl, 200) ? (
                            <Image source={{ uri: artURL(p.artworkUrl, 200) }} style={styles.playlistArt} contentFit="cover" />
                          ) : (
                            <ArtFallback seed={p.name ?? p.id} size={130} radius={10} />
                          )}
                          <Text style={styles.cardTitle} numberOfLines={2}>{p.name}</Text>
                          {!!p.trackCount && <Text style={styles.cardSub}>{p.trackCount} songs</Text>}
                        </TouchableOpacity>
                      ))}
                    </ScrollView>
                  </View>
                )}

                {/* From Your Library */}
                {librarySongs.length > 0 && (
                  <View style={styles.section}>
                    <Text style={styles.sectionTitle}>From Your Library</Text>
                    <View style={styles.list}>
                      {librarySongs.slice(0, 25).map((s, i) =>
                        SongRow(s, i, () => playLibrarySong(s.id), i === Math.min(librarySongs.length, 25) - 1)
                      )}
                    </View>
                  </View>
                )}

                {/* Empty library (authorized but nothing came back) */}
                {!libLoading && playlists.length === 0 && librarySongs.length === 0 && recent.length === 0 && (
                  <Text style={styles.hint}>
                    Nothing in your Apple Music library yet. Add songs or playlists in Apple Music and they’ll show up here.
                  </Text>
                )}
              </>
            )}
          </>
        )}

        {/* ===== First-time source picker — branded Apple Music + Spotify cards.
            Whichever they connect sets settings.musicSource and switches the
            tab to that player. Keeps Apple Music; adds Spotify (incl. Android). ===== */}
        {source === null && !initializing && (
          <>
            <Text style={styles.pickerLead}>Choose your music</Text>

            {/* Apple Music */}
            <TouchableOpacity
              activeOpacity={0.9}
              onPress={() => { if (isMusicSupported) handleConnect(); else openAppleMusic(); }}
              disabled={connecting}
              testID="pick-apple-music"
              style={styles.heroWrap}
            >
              <LinearGradient colors={AM_PINK} start={{ x: 0, y: 0 }} end={{ x: 1, y: 1 }} style={styles.hero}>
                <View style={styles.heroLogo}><Ionicons name="musical-notes" size={28} color="#fff" /></View>
                <Text style={styles.heroTitle}>Apple Music</Text>
                <Text style={styles.heroSub}>
                  {isMusicSupported
                    ? "Your playlists, library, and recently played — right inside Convoy."
                    : "In-app playback is iPhone-only. Tap to open Apple Music on this device."}
                </Text>
                <View style={styles.heroBtn}>
                  {connecting ? (
                    <ActivityIndicator color={AM_PINK[1]} />
                  ) : (
                    <>
                      <Ionicons name={isMusicSupported ? "link" : "open-outline"} size={16} color={AM_PINK[1]} />
                      <Text style={styles.heroBtnText}>{isMusicSupported ? "Connect Apple Music" : "Open Apple Music"}</Text>
                    </>
                  )}
                </View>
                <Text style={styles.heroNote}>Apple Music subscription required</Text>
              </LinearGradient>
            </TouchableOpacity>

            {/* Spotify */}
            <TouchableOpacity
              activeOpacity={0.9}
              onPress={async () => {
                // Surface failures instead of swallowing them — a silent
                // `.catch(() => {})` here is exactly why a broken login looked
                // like "nothing happens". startLogin opens the Spotify auth page
                // in the browser; the convoy://spotify-callback deep link then
                // lands on app/spotify-callback.tsx to finish sign-in.
                try {
                  await startLogin();
                } catch (e: any) {
                  Alert.alert(
                    "Couldn't open Spotify",
                    e?.message || "Something went wrong starting Spotify sign-in. Please try again.",
                  );
                }
              }}
              testID="pick-spotify"
              style={[styles.heroWrap, { shadowColor: SP_GREEN }]}
            >
              <View style={[styles.hero, { backgroundColor: SP_GREEN }]}>
                <View style={styles.heroLogo}><MaterialCommunityIcons name="spotify" size={32} color="#fff" /></View>
                <Text style={styles.heroTitle}>Spotify</Text>
                <Text style={styles.heroSub}>
                  Control your Spotify and bring your playlists into Convoy — works on Android too.
                </Text>
                <View style={styles.heroBtn}>
                  <MaterialCommunityIcons name="spotify" size={16} color={SP_GREEN} />
                  <Text style={[styles.heroBtnText, { color: SP_GREEN }]}>Log in with Spotify</Text>
                </View>
                <Text style={styles.heroNote}>Spotify Premium required to control playback</Text>
              </View>
            </TouchableOpacity>
          </>
        )}

        {/* ===== Apple reconnect (source = apple but authorization lost) ===== */}
        {source === "apple" && isMusicSupported && !authorized && !initializing && (
          <TouchableOpacity activeOpacity={0.9} onPress={handleConnect} disabled={connecting} testID="apple-music-connect" style={styles.heroWrap}>
            <LinearGradient colors={AM_PINK} start={{ x: 0, y: 0 }} end={{ x: 1, y: 1 }} style={styles.hero}>
              <View style={styles.heroLogo}><Ionicons name="musical-notes" size={30} color="#fff" /></View>
              <Text style={styles.heroTitle}>Apple Music</Text>
              <Text style={styles.heroSub}>Reconnect your Apple Music account to keep listening in Convoy.</Text>
              <View style={styles.heroBtn}>
                {connecting ? <ActivityIndicator color={AM_PINK[1]} /> : (<><Ionicons name="link" size={16} color={AM_PINK[1]} /><Text style={styles.heroBtnText}>Connect Apple Music</Text></>)}
              </View>
              <TouchableOpacity onPress={() => updateSettings({ musicSource: null })} style={{ marginTop: 12 }}>
                <Text style={[styles.heroNote, { textDecorationLine: "underline" }]}>Switch source</Text>
              </TouchableOpacity>
            </LinearGradient>
          </TouchableOpacity>
        )}

        {/* ===== Diagnostics — only renders when something actually failed.
            Temporary: surfaces the real native errors so we can pin down the
            catalog-entitlement issue from a screenshot. ===== */}
        {(searchError || anyLibErr) && (
          <View style={styles.diag}>
            <Text style={styles.diagTitle}>Diagnostics</Text>
            {!!searchError && <Text style={styles.diagLine}>catalog search: {searchError}</Text>}
            {!!libErrors.playlists && <Text style={styles.diagLine}>playlists: {libErrors.playlists}</Text>}
            {!!libErrors.songs && <Text style={styles.diagLine}>library songs: {libErrors.songs}</Text>}
            {!!libErrors.recent && <Text style={styles.diagLine}>recently played: {libErrors.recent}</Text>}
            {canPlay === false && <Text style={styles.diagLine}>subscription: canPlayCatalogContent = false</Text>}
          </View>
        )}

        {source === "apple" && (
          <>
            <Text style={styles.footer}>
              Convoy plays Apple Music through your own subscription. Your library, account, and billing
              stay with Apple Music.
            </Text>
            <TouchableOpacity onPress={() => updateSettings({ musicSource: null })} style={{ alignSelf: "center", marginTop: 10 }} testID="switch-source-apple">
              <Text style={[styles.footer, { color: SP_GREEN, marginTop: 0 }]}>Switch music source</Text>
            </TouchableOpacity>
          </>
        )}
      </ScrollView>

      {/* ===== Now-playing bar ===== */}
      {nowPlaying && (
        <View style={styles.nowBar}>
          {artURL(song?.artworkUrl ?? song?.artwork?.url, 96) ? (
            <Image source={{ uri: artURL(song?.artworkUrl ?? song?.artwork?.url, 96) }} style={styles.nowArt} contentFit="cover" />
          ) : (
            <ArtFallback seed={song?.title ?? song?.name ?? "?"} size={44} radius={8} />
          )}
          <View style={{ flex: 1 }}>
            <Text style={styles.nowTitle} numberOfLines={1}>{song?.title ?? song?.name ?? "Now Playing"}</Text>
            <Text style={styles.nowSub} numberOfLines={1}>{song?.artistName ?? song?.artist ?? ""}</Text>
          </View>
          <TouchableOpacity
            onPress={() => { Haptics.selectionAsync().catch(() => {}); setShareOpen(true); }}
            hitSlop={8}
            testID="am-share"
            style={{ marginRight: 2 }}
          >
            <Ionicons name="share-outline" size={20} color={COLORS.text} />
          </TouchableOpacity>
          <TouchableOpacity onPress={toggleAppleShuffle} hitSlop={8} testID="am-shuffle" style={{ marginRight: 12 }}>
            <Ionicons name="shuffle" size={20} color={appleShuffle ? AM_PINK[1] : COLORS.textDim} />
          </TouchableOpacity>
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

      <ShareSheet
        visible={shareOpen}
        onClose={() => setShareOpen(false)}
        share={
          song
            ? {
                kind: "music",
                title: song?.title ?? song?.name,
                artist: song?.artistName ?? song?.artist,
                artworkUrl: song?.artworkUrl ?? song?.artwork?.url,
                url: song?.url,
              }
            : null
        }
      />

      {/* Playlist detail — tap a playlist to see its songs and pick one. */}
      <Modal
        visible={!!detailPlaylist}
        transparent
        animationType="slide"
        onRequestClose={() => setDetailPlaylist(null)}
      >
        <View style={styles.plRoot}>
          <TouchableOpacity style={styles.plBackdrop} activeOpacity={1} onPress={() => setDetailPlaylist(null)} />
          <View style={styles.plSheet}>
            <View style={styles.plGrabber} />
            <View style={styles.plHeader}>
              {artURL(detailPlaylist?.artworkUrl, 120) ? (
                <Image source={{ uri: artURL(detailPlaylist?.artworkUrl, 120) }} style={styles.plArt} contentFit="cover" />
              ) : (
                <ArtFallback seed={detailPlaylist?.name ?? detailPlaylist?.id} size={56} radius={8} />
              )}
              <View style={{ flex: 1 }}>
                <Text style={styles.plTitle} numberOfLines={1}>{detailPlaylist?.name ?? "Playlist"}</Text>
                <Text style={styles.plSub} numberOfLines={1}>
                  {detailLoading ? "Loading…" : `${detailSongs.length} song${detailSongs.length === 1 ? "" : "s"}`}
                </Text>
              </View>
              <TouchableOpacity onPress={() => setDetailPlaylist(null)} style={styles.plClose} hitSlop={8}>
                <Ionicons name="close" size={20} color={COLORS.text} />
              </TouchableOpacity>
            </View>

            {detailSongs.length > 0 && (
              <TouchableOpacity
                style={styles.plPlayAll}
                activeOpacity={0.85}
                onPress={() => { if (detailPlaylist) playLibraryPlaylist(detailPlaylist.id, -1); setDetailPlaylist(null); }}
              >
                <Ionicons name="play" size={16} color="#fff" />
                <Text style={styles.plPlayAllText}>Play all</Text>
              </TouchableOpacity>
            )}

            {detailLoading ? (
              <ActivityIndicator color={AM_PINK[0]} style={{ marginVertical: 28 }} />
            ) : detailSongs.length === 0 ? (
              <Text style={styles.empty}>No songs in this playlist.</Text>
            ) : (
              <ScrollView style={{ maxHeight: 380 }} showsVerticalScrollIndicator={false}>
                {detailSongs.map((s, i) =>
                  // Play the PLAYLIST starting at this track (not the lone song),
                  // so the queue is the whole playlist — skip forward/back works
                  // and it keeps playing instead of stopping after one song.
                  SongRow(s, i, () => { if (detailPlaylist) playLibraryPlaylist(detailPlaylist.id, i); setDetailPlaylist(null); }, i === detailSongs.length - 1)
                )}
              </ScrollView>
            )}
          </View>
        </View>
      </Modal>
    </SafeAreaView>
    <View style={styles.logoBacking}><LogoMenu size={40} align="right" /></View>
    </>
  );
}

const styles = StyleSheet.create({
  c: { flex: 1, backgroundColor: COLORS.bg },

  header: { flexDirection: "row", alignItems: "center", paddingHorizontal: 20, paddingTop: 10, paddingBottom: 6 },
  dateOverline: { color: "#808080", fontSize: 13, fontWeight: "700", letterSpacing: 0.4 },
  title: { color: COLORS.text, fontSize: 34, fontWeight: "800", letterSpacing: -1, marginTop: 2 },
  logoBtn: { padding: 4 },
  logoBacking: {
    position: 'absolute', top: Platform.OS === 'ios' ? 52 : 28, right: 12, zIndex: 100,
    width: 54, height: 54, borderRadius: 27,
    alignItems: 'center', justifyContent: 'center',
    backgroundColor: 'rgba(20,20,22,0.9)',
    borderWidth: 1.5, borderColor: 'rgba(45,236,134,0.55)',
    shadowColor: '#000', shadowOpacity: 0.35, shadowRadius: 5, shadowOffset: { width: 0, height: 2 },
    elevation: 6,
  },

  // ===== Search =====
  searchWrap: {
    flexDirection: "row", alignItems: "center", gap: 8,
    marginHorizontal: 20, marginTop: 14, paddingHorizontal: 14, height: 44,
    backgroundColor: "rgba(255,255,255,0.08)", borderRadius: 12,
  },
  searchInput: { flex: 1, color: COLORS.text, fontSize: 16, paddingVertical: 0 },
  hint: { color: COLORS.textDim, fontSize: 14, lineHeight: 20, paddingHorizontal: 22, marginTop: 22 },
  empty: { color: COLORS.textDim, fontSize: 15, textAlign: "center", marginTop: 26 },

  // ===== Sections =====
  section: { marginTop: 22 },
  sectionTitle: { color: COLORS.text, fontSize: 22, fontWeight: "800", letterSpacing: -0.5, paddingHorizontal: 20, marginBottom: 12 },
  hStrip: { paddingHorizontal: 20, gap: 14 },

  // Recently played card
  recentCard: { width: 130 },
  recentArt: { width: 130, height: 130, borderRadius: 10, backgroundColor: "rgba(255,255,255,0.06)" },

  // Playlist card
  playlistCard: { width: 130 },
  playlistArt: { width: 130, height: 130, borderRadius: 10, backgroundColor: "rgba(255,255,255,0.06)" },

  cardTitle: { color: COLORS.text, fontSize: 14, fontWeight: "600", marginTop: 8 },
  cardSub: { color: COLORS.textDim, fontSize: 12, marginTop: 2 },

  // ===== Song list (search results + library) =====
  list: {
    marginTop: 4, marginHorizontal: 20,
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
  artPlaceholder: { alignItems: "center", justifyContent: "center" },
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
  heroTitle: { color: "#F4F4F4", fontSize: 26, fontWeight: "800", letterSpacing: -0.6, marginTop: 14 },
  heroSub: { color: "rgba(255,255,255,0.92)", fontSize: 14, lineHeight: 20, marginTop: 6 },
  heroBtn: {
    flexDirection: "row", alignItems: "center", gap: 6, alignSelf: "flex-start",
    backgroundColor: "#fff", paddingVertical: 10, paddingHorizontal: 16, borderRadius: 999, marginTop: 18, minHeight: 40,
  },
  heroBtnText: { color: "#FA2D48", fontSize: 14, fontWeight: "800", letterSpacing: 0.2 },
  heroNote: { color: "rgba(255,255,255,0.85)", fontSize: 12, fontWeight: "600", marginTop: 14 },
  pickerLead: { color: COLORS.text, fontSize: 18, fontWeight: "800", letterSpacing: -0.3, paddingHorizontal: 22, marginTop: 18, marginBottom: 2 },

  // ===== Diagnostics (temporary) =====
  diag: {
    marginHorizontal: 20, marginTop: 22, padding: 12,
    borderRadius: 12, backgroundColor: "rgba(255,69,58,0.08)",
    borderWidth: StyleSheet.hairlineWidth, borderColor: "rgba(255,69,58,0.35)",
  },
  diagTitle: { color: "#FF6961", fontSize: 12, fontWeight: "800", letterSpacing: 0.4, marginBottom: 4 },
  diagLine: { color: "#808080", fontSize: 11, lineHeight: 16 },

  footer: { color: "#808080", fontSize: 12, lineHeight: 18, textAlign: "center", paddingHorizontal: 24, marginTop: 26 },

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

  // ===== Playlist detail sheet =====
  plRoot: { flex: 1, justifyContent: "flex-end" },
  plBackdrop: { ...StyleSheet.absoluteFillObject, backgroundColor: "rgba(0,0,0,0.6)" },
  plSheet: {
    backgroundColor: "#161618",
    borderTopLeftRadius: 22, borderTopRightRadius: 22,
    paddingHorizontal: 16, paddingTop: 10,
    paddingBottom: Platform.OS === "ios" ? 34 : 20,
    borderTopWidth: StyleSheet.hairlineWidth, borderColor: "rgba(255,255,255,0.14)",
  },
  plGrabber: { alignSelf: "center", width: 40, height: 5, borderRadius: 3, backgroundColor: "rgba(255,255,255,0.25)", marginBottom: 12 },
  plHeader: { flexDirection: "row", alignItems: "center", gap: 12, marginBottom: 12 },
  plArt: { width: 56, height: 56, borderRadius: 8, backgroundColor: "rgba(255,255,255,0.06)" },
  plTitle: { color: COLORS.text, fontSize: 18, fontWeight: "800", letterSpacing: -0.3 },
  plSub: { color: COLORS.textDim, fontSize: 13, marginTop: 2 },
  plClose: { width: 32, height: 32, borderRadius: 16, alignItems: "center", justifyContent: "center", backgroundColor: "rgba(255,255,255,0.10)" },
  plPlayAll: {
    flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 8,
    backgroundColor: AM_PINK[1], paddingVertical: 12, borderRadius: 14, marginBottom: 8,
  },
  plPlayAllText: { color: "#F4F4F4", fontWeight: "800", fontSize: 15 },
});
