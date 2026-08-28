import React, { useEffect, useState, useCallback, useRef } from "react";
import {
  View, Text, StyleSheet, TouchableOpacity, ScrollView, TextInput,
  KeyboardAvoidingView, Platform, Alert, Modal, RefreshControl, Share, Image, Switch,
} from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { SafeAreaView } from "react-native-safe-area-context";
import { LinearGradient } from "expo-linear-gradient";
import * as ImagePicker from "expo-image-picker";
import { useRouter, useLocalSearchParams } from "expo-router";
import { useAuth } from "../../src/auth";
import { EventsSection, EventDetailModal, CreateEventModal, whenText } from "../../src/hubEvents";
import { getEvent, myEvents, discoverEvents, type HubEvent } from "../../src/eventsApi";
import { api, formatErr } from "../../src/api";
import { COLORS } from "../../src/theme";
import Glass, { GlassFill } from "../../src/Glass";
import GlassBackdrop from "../../src/components/GlassBackdrop";
import LogoMenu from "../../src/components/LogoMenu";
import { getGarageImage, getTopDownImage } from "../../src/carImages";
import { fetchClubLeaderboard, getPeerPbs, fmtKm } from "../../src/trips";
import { useSettings, updateSettings } from "../../src/settings";
import { useAccent, useAccentAlpha, useAppSkinColors } from "../../src/appSkin";

type Community = {
  id: string; name: string; description: string; member_count: number;
  pending_count: number; is_admin: boolean; is_member: boolean; is_pending: boolean;
  is_public: boolean; admin_handle?: string; invite_code?: string;
  logo_b64?: string | null;
  banner_b64?: string | null;
  tags?: string[];
  walkie_enabled?: boolean;
  music_enabled?: boolean;
  map_enabled?: boolean;
};

// Curated category chips admins pick from (Velox-style). Kept as a flat list so a
// tapped chip maps 1:1 to a stored tag string.
const CHIPS: [string, string][] = [
  ["going", "Going"], ["all", "All"], ["event", "Meets"], ["cruise", "Cruises"], ["clubs", "Clubs"],
];

const SUGGESTED_TAGS = [
  "Just for Fun", "Meetup", "Weekend Runs", "Cars & Coffee", "Beginner-Friendly",
  "JDM", "Euro", "Domestic", "Trucks", "Track Days", "Show & Shine", "Cruises", "Organization",
];

export default function HubScreen() {
  const { user, logout, refresh } = useAuth();
  const accent = useAccent();
  const skinColors = useAppSkinColors();
  const router = useRouter();
  const [settings] = useSettings();
  // The driver's Garage hero photo (their car) — used as their avatar in the
  // My communities section. Falls back to the showroom image when no car is set.
  const heroImg = getGarageImage(user?.car_make || "", user?.car_model || "", user?.car_color || "");
  const [mine, setMine] = useState<Community[]>([]);
  const [loading, setLoading] = useState(false);
  const [showCreate, setShowCreate] = useState(false);
  const [showSearch, setShowSearch] = useState(false);
  const [showProfile, setShowProfile] = useState(false);
  const [showDetail, setShowDetail] = useState<Community | null>(null);
  // ── CLUB REDESIGN state (2026-08-28) ──────────────────────────────────────
  // ONE chip rail replaces the old two stacked nav rows (Clubs|Events|Cruises
  // pills over a Discover|Mine segment). `chip` is the single taxonomy.
  const [chip, setChip] = useState<"going" | "all" | "event" | "cruise" | "clubs">("all");
  const [feedMine, setFeedMine] = useState<HubEvent[]>([]);
  const [feedAll, setFeedAll] = useState<HubEvent[]>([]);
  const [feedLoading, setFeedLoading] = useState(false);
  const [openEvent, setOpenEvent] = useState<HubEvent | null>(null);
  const [createKind, setCreateKind] = useState<"event" | "cruise" | null>(null);
  const [showCreateSheet, setShowCreateSheet] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try { const { data } = await api.get("/communities/mine"); setMine(data); } catch {}
    setLoading(false);
  }, []);

  // Hub sections (Hub P2): Clubs (the original hub) · Events · Cruises. Each has
  // its own discover/create/mine. Events + Cruises live in src/hubEvents.tsx.
  const [section, setSection] = useState<"clubs" | "events" | "cruises">("clubs");
  // Deep-open an event/cruise from a push notification (hub?event=<id> — set by
  // the notification-response handler in _layout.tsx). We fetch it first to learn
  // its kind so the right section mounts, then hand the id down to auto-open.
  const params = useLocalSearchParams<{ event?: string }>();
  const [openEventId, setOpenEventId] = useState<string | null>(null);
  useEffect(() => {
    const eid = typeof params.event === "string" ? params.event : null;
    if (!eid) return;
    getEvent(eid)
      .then((e) => { setSection(e.kind === "cruise" ? "cruises" : "events"); setOpenEventId(eid); })
      .catch(() => {});
  }, [params.event]);

  // Explore tab — browse PUBLIC clubs (empty search query returns all public).
  const [tab, setTab] = useState<"mine" | "explore">("mine");
  const [explore, setExplore] = useState<Community[]>([]);
  const [exploreLoading, setExploreLoading] = useState(false);
  const loadExplore = useCallback(async () => {
    setExploreLoading(true);
    try { const { data } = await api.get("/communities/search", { params: { q: "" } }); setExplore(data); } catch {}
    setExploreLoading(false);
  }, []);
  const joinCommunity = useCallback(async (c: Community) => {
    try {
      await api.post(`/communities/${c.id}/request`);
      Alert.alert("Request sent", "The admin will review your request.");
      loadExplore();
    } catch (e) { Alert.alert("Failed", formatErr(e)); }
  }, [loadExplore]);
  // Inline Discover search (debounced) — replaces the old Discover action card.
  const [exploreQ, setExploreQ] = useState("");
  const exploreDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const onExploreSearch = (text: string) => {
    setExploreQ(text);
    if (exploreDebounceRef.current) clearTimeout(exploreDebounceRef.current);
    exploreDebounceRef.current = setTimeout(async () => {
      setExploreLoading(true);
      try { const { data } = await api.get("/communities/search", { params: { q: text.trim() } }); setExplore(data); } catch {}
      setExploreLoading(false);
    }, 250);
  };

  useEffect(() => { load(); }, [load]);

  // ── The unified feed. myEvents() returns BOTH kinds; discoverEvents('')
  // returns every public one. They are merged, de-duped (yours wins so the
  // GOING state survives) and sorted by time — kind becomes the card's shape,
  // not a tab you pre-select. Fixes the known gap where pull-to-refresh
  // reloaded clubs but never events.
  const loadFeed = useCallback(async () => {
    setFeedLoading(true);
    try {
      const [m, d] = await Promise.all([
        myEvents().catch(() => [] as HubEvent[]),
        discoverEvents("").catch(() => [] as HubEvent[]),
      ]);
      setFeedMine(m);
      const byId = new Map<string, HubEvent>();
      for (const e of d) byId.set(e.id, e);
      for (const e of m) byId.set(e.id, e);   // mine last: is_attending must win
      setFeedAll([...byId.values()]);
    } finally { setFeedLoading(false); }
  }, []);
  useEffect(() => { loadFeed(); }, [loadFeed]);
  const [fabOpen, setFabOpen] = useState(false);

  // NEXT UP — soonest thing you're attending; else the soonest public thing.
  // Same rule as the widget: an item stays "next" until start_at + 3h.
  const nextUp = React.useMemo(() => {
    const live = (e: HubEvent) => new Date(e.start_at).getTime() + 3 * 3600_000 > Date.now();
    const byTime = (a: HubEvent, b: HubEvent) => +new Date(a.start_at) - +new Date(b.start_at);
    const mineSoon = feedMine.filter((e) => live(e) && e.is_attending).sort(byTime);
    if (mineSoon.length) return mineSoon[0];
    const anySoon = feedAll.filter(live).sort(byTime);
    return anySoon[0] ?? null;
  }, [feedMine, feedAll]);

  // Standings follow the ACTIVE club, falling back to the first one you are in,
  // so a member with one club always sees their board.
  const standingsClubId = settings.activeCommunityId || mine[0]?.id || null;

  const feedShown = React.useMemo(() => {
    const live = (e: HubEvent) => new Date(e.start_at).getTime() + 3 * 3600_000 > Date.now();
    const byTime = (a: HubEvent, b: HubEvent) => +new Date(a.start_at) - +new Date(b.start_at);
    let list = feedAll.filter(live);
    if (chip === "going") list = list.filter((e) => e.is_attending);
    if (chip === "event" || chip === "cruise") list = list.filter((e) => e.kind === chip);
    return list.sort(byTime);
  }, [feedAll, chip]);

  // EMPTY-STATE RULE: a brand-new member with nothing RSVP'd must never be shown
  // their own emptiness. If "Going" would be empty on FIRST load, land on All.
  // First load only — never override a deliberate tap.
  const chipSeeded = useRef(false);
  useEffect(() => {
    if (chipSeeded.current || feedLoading) return;
    if (feedAll.length || feedMine.length) {
      chipSeeded.current = true;
      if (feedMine.some((e) => e.is_attending)) setChip("going");
    }
  }, [feedAll, feedMine, feedLoading]);
  useEffect(() => { if (tab === "explore" && explore.length === 0) loadExplore(); }, [tab, explore.length, loadExplore]);

  return (
    <>
    <SafeAreaView style={styles.c} edges={["top"]}>
      <GlassBackdrop />
      <ScrollView contentContainerStyle={{ padding: 18, paddingBottom: 168 }}
        refreshControl={<RefreshControl refreshing={loading || feedLoading} onRefresh={() => { load(); loadFeed(); }} tintColor={accent} />}>
        <View style={styles.headerRow}>
          <View style={{ flexDirection: "row", alignItems: "center", gap: 4 }}>
            <TouchableOpacity
              testID="hub-back"
              onPress={() => { if (router.canGoBack()) router.back(); else router.push("/(app)/map" as any); }}
              hitSlop={10}
              style={{ padding: 2, marginLeft: -4 }}
            >
              <Ionicons name="chevron-back" size={26} color={COLORS.text} />
            </TouchableOpacity>
            {/* "Club", not "Hub" (Jeff, 2026-08-28). The ROUTE stays /(app)/hub so
                every push deep link, LogoMenu entry and voice intent keeps working. */}
            <Text style={styles.title}>Club</Text>
          </View>
        </View>

        {/* ── DRIVER BAND ────────────────────────────────────────────────────
            Also the only entry point to ProfileModal, which was unreachable:
            setShowProfile(true) was called NOWHERE before this. */}
        <TouchableOpacity testID="hub-profile" onPress={() => setShowProfile(true)} activeOpacity={0.85} style={styles.driverBand}>
          <Image source={getTopDownImage(user?.car_color || "")} style={styles.driverCar} resizeMode="contain" />
          <View style={{ flex: 1 }}>
            <Text style={styles.driverName}>{user?.handle || "Driver"}</Text>
            <Text style={[styles.driverCarTxt, { color: accent }]} numberOfLines={1}>
              {[user?.car_year, user?.car_make, user?.car_model].filter(Boolean).join(" ") || "Set up your Garage"}
            </Text>
          </View>
          <Ionicons name="chevron-forward" size={20} color="#5A5A5E" />
        </TouchableOpacity>

        {/* ── NEXT UP ────────────────────────────────────────────────────────
            Answers "what is my club doing next" with zero taps. Same pick the
            iOS widget already computes (widgetFeed.nextUp) but never showed. */}
        <NextUp
          event={nextUp}
          accent={accent}
          skinColors={skinColors}
          onOpen={(e) => setOpenEvent(e)}
          onPlan={() => { setCreateKind("cruise"); setShowCreateSheet(true); }}
        />

        {/* ── YOUR CLUBS — a rail, so ONE club reads deliberate, not lonely ── */}
        <Text style={styles.sectionLabel}>YOUR CLUBS</Text>
        <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.clubRail}>
          {mine.map((c) => (
            <TouchableOpacity key={c.id} onPress={() => setShowDetail(c)} activeOpacity={0.85} style={styles.railItem}>
              <View style={[styles.railCrest, { borderColor: c.id === settings.activeCommunityId ? accent : "transparent" }]}>
                {c.logo_b64
                  ? <Image source={{ uri: c.logo_b64 }} style={styles.railLogo} />
                  : <Ionicons name="people" size={24} color={accent} />}
              </View>
              <Text style={styles.railName} numberOfLines={1}>{c.name}</Text>
              <Text style={styles.railMeta}>{c.member_count}</Text>
            </TouchableOpacity>
          ))}
          <TouchableOpacity testID="rail-find" onPress={() => { setChip("clubs"); setTab("explore"); }} activeOpacity={0.85} style={styles.railItem}>
            <View style={[styles.railCrest, styles.railCrestDashed]}>
              <Ionicons name="search" size={22} color="#7A7A7E" />
            </View>
            <Text style={styles.railName}>Find</Text>
          </TouchableOpacity>
        </ScrollView>

        {/* ── STANDINGS — promoted out of the detail sheet (Jeff picked A + B's
            standings). Structurally cannot be empty: every member is seeded. */}
        {!!standingsClubId && <ClubStandings communityId={standingsClubId} />}

        {/* ── ONE CHIP RAIL — replaces BOTH old nav rows ─────────────────── */}
        <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.chipRail}>
          {CHIPS.map(([key, label]) => {
            const on = chip === key;
            return (
              <TouchableOpacity key={key} testID={`club-chip-${key}`} onPress={() => setChip(key as any)} activeOpacity={0.85}
                style={[styles.chip, on && { backgroundColor: accent, borderColor: accent }]}>
                <Text style={[styles.chipTxt, on && { color: skinColors.ink, fontWeight: "800" }]}>{label}</Text>
              </TouchableOpacity>
            );
          })}
        </ScrollView>

        {chip === "clubs" ? (
          <ClubsPane
            mine={mine} explore={explore} exploreLoading={exploreLoading} exploreQ={exploreQ}
            tab={tab} setTab={setTab} onSearch={onExploreSearch} onJoin={joinCommunity}
            onOpen={setShowDetail} onCode={() => setShowSearch(true)}
            activeId={settings.activeCommunityId} heroImg={heroImg} accent={accent}
          />
        ) : (
          <FeedList
            events={feedShown} loading={feedLoading} accent={accent}
            onOpen={(e) => setOpenEvent(e)}
            emptyLabel={chip === "going" ? "Nothing you're going to yet — tap All to see what's on."
              : chip === "event" ? "No meets posted yet."
              : chip === "cruise" ? "No cruises planned yet."
              : "Nothing posted near you yet — be the first."}
          />
        )}
      </ScrollView>

      {/* Modals */}
      {/* CREATE is a FAB now, not a permanent full-width row above the content. */}
      <TouchableOpacity testID="club-fab" onPress={() => setFabOpen(true)} activeOpacity={0.9} style={styles.fab}>
        <LinearGradient colors={skinColors.colors as any} locations={skinColors.locations as any} style={StyleSheet.absoluteFill as any} />
        <Ionicons name="add" size={30} color={skinColors.ink} />
      </TouchableOpacity>
      <CreateSheet
        visible={fabOpen} accent={accent}
        onClose={() => setFabOpen(false)}
        onPick={(what) => {
          setFabOpen(false);
          if (what === "club") setShowCreate(true);
          else { setCreateKind(what); setShowCreateSheet(true); }
        }}
      />
      <CreateEventModal
        kind={createKind ?? "event"} visible={showCreateSheet} editing={null}
        onClose={() => setShowCreateSheet(false)}
        onCreated={() => { setShowCreateSheet(false); loadFeed(); }}
      />
      <EventDetailModal
        event={openEvent}
        onClose={() => setOpenEvent(null)}
        onChanged={loadFeed}
        onDeleted={() => { setOpenEvent(null); loadFeed(); }}
        onEdit={() => {}}
      />
      <CreateModal visible={showCreate} onClose={() => setShowCreate(false)} onCreated={() => { setShowCreate(false); load(); }} />
      <SearchModal visible={showSearch} onClose={() => setShowSearch(false)} onChanged={load} />
      <ProfileModal visible={showProfile} onClose={() => setShowProfile(false)} onSignOut={logout} onSaved={async () => { await refresh(); setShowProfile(false); }} />
      <CommunityDetailModal community={showDetail} onClose={() => setShowDetail(null)} onChanged={load} />
    </SafeAreaView>
    <View style={styles.logoBacking}><LogoMenu size={38} align="right" /></View>
    </>
  );
}

// (The old ActionCard grid — Garage / Create / Discover — was removed when the
// Clubs section adopted the Events/Cruises layout: Garage lives in the logo
// menu, Create is the glass row, Discover is the segment tab.)


/* ═══════════ CLUB REDESIGN COMPONENTS (2026-08-28) ═══════════
   Jeff picked concept A ("Roll Call") with B's standings promoted onto the page.
   Everything below is NEW SHELL only — every modal, card and API call the old
   Hub had is untouched and still mounted, because the audit counted 324 live
   capabilities and a rewrite that re-implements them is how you lose them. */

/** NEXT UP — the one large object on the screen. The empty state is the SAME
 *  shape and weight as the populated one, so the screen never visibly deflates
 *  for a member with nothing on. */
function NextUp({ event: e, accent, skinColors, onOpen, onPlan }: {
  event: HubEvent | null; accent: string; skinColors: any;
  onOpen: (e: HubEvent) => void; onPlan: () => void;
}) {
  const wash = useAccentAlpha(0.28);
  const washMid = useAccentAlpha(0.09);
  const glyph = useAccentAlpha(0.10);
  const when = e ? whenText(e.start_at) : "";
  return (
    <TouchableOpacity
      testID="club-nextup"
      activeOpacity={e ? 0.9 : 1}
      onPress={() => e && onOpen(e)}
      style={styles.heroCard}
    >
      {e?.banner_b64
        ? <Image source={{ uri: e.banner_b64 }} style={StyleSheet.absoluteFill as any} resizeMode="cover" />
        : <LinearGradient colors={[wash, washMid, "rgba(0,0,0,0.96)"]} start={{ x: 0, y: 0 }} end={{ x: 0.9, y: 1 }} style={StyleSheet.absoluteFill} />}
      <Ionicons
        name={e?.kind === "cruise" ? "git-branch" : "location"}
        size={180} color={glyph}
        style={{ position: "absolute", right: -30, top: -10 }}
      />
      {!!e && (
        <View style={[styles.heroCountdown, { backgroundColor: accent }]}>
          <Text style={[styles.heroCountdownTxt, { color: skinColors.ink }]}>{when.toUpperCase()}</Text>
        </View>
      )}
      <View style={styles.heroFoot}>
        <Text style={styles.heroTitle} numberOfLines={1}>{e ? e.title : "Nothing on the calendar yet"}</Text>
        <Text style={styles.heroSub} numberOfLines={1}>
          {e ? (e.venue?.label || "Tap for details") : "Pick a road, set a time — your crew gets the push."}
        </Text>
        <View style={styles.heroRow}>
          {e ? (
            <>
              <Text style={styles.heroGoing}>
                {e.attendee_count} going{e.confirmed_count ? ` · ${e.confirmed_count} confirmed` : ""}
              </Text>
              <View style={{ flex: 1 }} />
              <View style={[styles.heroCta, { backgroundColor: accent }]}>
                <Text style={[styles.heroCtaTxt, { color: skinColors.ink }]}>
                  {e.is_attending ? "You're in" : "Details"}
                </Text>
              </View>
            </>
          ) : (
            <TouchableOpacity onPress={onPlan} activeOpacity={0.9} style={[styles.heroCta, { backgroundColor: accent }]}>
              <Text style={[styles.heroCtaTxt, { color: skinColors.ink }]}>Plan a cruise</Text>
            </TouchableOpacity>
          )}
        </View>
      </View>
    </TouchableOpacity>
  );
}

/** ONE time-ordered list. Meets and cruises interleaved — KIND IS THE ROW'S
 *  SHAPE (a cruise draws a route glyph, a meet draws a place), not a tab you
 *  pre-select. That single move is what deletes both old nav rows. */
function FeedList({ events, loading, accent, onOpen, emptyLabel }: {
  events: HubEvent[]; loading: boolean; accent: string;
  onOpen: (e: HubEvent) => void; emptyLabel: string;
}) {
  const well = useAccentAlpha(0.14);
  const edge = useAccentAlpha(0.35);
  if (loading && events.length === 0) {
    return <View style={styles.sheetList}><Text style={styles.feedEmpty}>Loading…</Text></View>;
  }
  return (
    <View style={styles.sheetList}>
      {events.length === 0 && <Text style={styles.feedEmpty}>{emptyLabel}</Text>}
      {events.map((e, i) => (
        <TouchableOpacity
          key={e.id} testID={`club-feed-${e.id}`} activeOpacity={0.85} onPress={() => onOpen(e)}
          style={[styles.feedRow, i > 0 ? { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: "rgba(255,255,255,0.08)" } : null]}
        >
          <View style={styles.feedGlyph}>
            <Ionicons name={e.kind === "cruise" ? "git-branch" : "location"} size={20} color={accent} />
          </View>
          <View style={{ flex: 1 }}>
            <Text style={styles.feedTitle} numberOfLines={1}>{e.title}</Text>
            <Text style={styles.feedSub} numberOfLines={1}>
              <Text style={{ color: accent, fontWeight: "700" }}>{whenText(e.start_at)}</Text>
              {e.venue?.label ? <Text>{"  ·  " + e.venue.label}</Text> : null}
            </Text>
          </View>
          {e.is_attending
            ? <View style={[styles.goingPill, { backgroundColor: well, borderColor: edge }]}>
                <Text style={[styles.goingTxt, { color: accent }]}>{e.is_confirmed ? "CONFIRMED" : "GOING"}</Text>
              </View>
            : <View style={styles.countWell}><Text style={styles.countTxt}>{e.attendee_count}</Text></View>}
        </TouchableOpacity>
      ))}
    </View>
  );
}

/** STANDINGS, promoted out of the detail sheet onto the page.
 *  ⚠ The PB resolution below is LIFTED VERBATIM from CommunityDetailModal — three
 *  sources (roster profile, the live /users/nearby feed, the local cache) with
 *  tolerant field names, because no single source covers a whole club and a
 *  half-covered board renders as broken rather than empty. Do not "simplify" it. */
function ClubStandings({ communityId }: { communityId: string }) {
  const accent = useAccent();
  const { user } = useAuth();
  const [rows, setRows] = useState<{ userId: string; handle: string; km: number; drives: number; pb: number }[]>([]);
  const [mode, setMode] = useState<"drives" | "pb">("drives");
  const [roster, setRoster] = useState<any[]>([]);
  useEffect(() => {
    let dead = false;
    (async () => {
      try {
        const { data } = await api.get(`/communities/${communityId}`);
        if (!dead) setRoster(data?.members_users || []);
      } catch {}
    })();
    return () => { dead = true; };
  }, [communityId]);
  useEffect(() => {
    let dead = false;
    (async () => {
      const board = await fetchClubLeaderboard(String(communityId));
      if (dead) return;
      const pbCache = await getPeerPbs();
      let pbLive: Record<string, number> = {};
      try {
        const { data } = await api.get("/users/nearby", { params: { radius_km: 20000 } });
        for (const u of (Array.isArray(data) ? data : [])) {
          const v = Number(u?.top_speed_record) || 0;
          if (u?.id && v > 0) pbLive[String(u.id)] = v;
        }
      } catch {}
      if (dead) return;
      const byId = new Map(board.map((r) => [r.userId, { ...r }]));
      for (const m of roster) {
        const id = String(m?.id ?? "");
        if (!id) continue;
        const profilePb =
          Number(m?.top_speed_record) || Number(m?.topSpeed) || Number(m?.top_speed) ||
          Number(m?.pb) || Number(pbLive[id]) || Number(pbCache[id]) || 0;
        const cur = byId.get(id);
        if (cur) {
          cur.pb = Math.max(cur.pb || 0, profilePb);
          if (!cur.handle || cur.handle === "Driver") cur.handle = m?.handle || cur.handle;
        } else {
          byId.set(id, { userId: id, handle: m?.handle || "anon", km: 0, drives: 0, pb: profilePb });
        }
      }
      setRows([...byId.values()].sort((a, b) =>
        mode === "pb" ? (b.pb - a.pb) || (b.km - a.km) : (b.km - a.km) || (b.pb - a.pb)));
    })();
    return () => { dead = true; };
  }, [communityId, mode, roster]);

  if (!rows.length) return null;      // conditional section: never a header over a void
  return (
    <>
      <Text style={styles.sectionLabel}>STANDINGS</Text>
      <View style={styles.standToggle}>
        {(["drives", "pb"] as const).map((m) => (
          <TouchableOpacity key={m} onPress={() => setMode(m)} activeOpacity={0.85}
            style={[styles.standTog, mode === m && { backgroundColor: accent, borderColor: accent }]}>
            <Text style={[styles.standTogTxt, mode === m && { color: "#111" }]}>{m === "drives" ? "Drives" : "Top speed"}</Text>
          </TouchableOpacity>
        ))}
      </View>
      <View style={styles.sheetList}>
        {rows.slice(0, 5).map((r, i) => (
          <View key={r.userId} style={[styles.standRow, i > 0 ? { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: "rgba(255,255,255,0.08)" } : null]}>
            <View style={[styles.standRank, { backgroundColor: i === 0 ? accent : "rgba(255,255,255,0.08)" }]}>
              <Text style={[styles.standRankTxt, { color: i === 0 ? "#111" : "#C7C7CC" }]}>{i + 1}</Text>
            </View>
            <Image source={getTopDownImage("")} style={styles.standCar} resizeMode="contain" />
            <Text style={styles.standName} numberOfLines={1}>
              {r.handle}{r.userId === String(user?.id ?? "") ? " (you)" : ""}
            </Text>
            <Text style={[styles.standVal, { color: accent }]}>
              {mode === "pb" ? (r.pb ? r.pb.toFixed(1) : "—") : fmtKm(r.km)}
              {mode === "pb" && !!r.pb && <Text style={styles.standUnit}> km/h</Text>}
            </Text>
          </View>
        ))}
      </View>
    </>
  );
}

/** The Clubs lens — the directory. Everything the old Discover/My Clubs segment
 *  did, including the invite-code path, which is the ONLY way into a private
 *  club and the ONLY instant join (public joins are approval-gated). */
function ClubsPane({ mine, explore, exploreLoading, exploreQ, tab, setTab, onSearch, onJoin, onOpen, onCode, activeId, heroImg, accent }: any) {
  return (
    <>
      <View style={styles.segment}>
        <TouchableOpacity testID="tab-mine" onPress={() => setTab("mine")} style={[styles.segmentBtn, tab === "mine" && styles.segmentBtnOn]}>
          <Text style={[styles.segmentText, tab === "mine" && styles.segmentTextOn]}>My Clubs</Text>
        </TouchableOpacity>
        <TouchableOpacity testID="tab-explore" onPress={() => setTab("explore")} style={[styles.segmentBtn, tab === "explore" && styles.segmentBtnOn]}>
          <Text style={[styles.segmentText, tab === "explore" && styles.segmentTextOn]}>Discover</Text>
        </TouchableOpacity>
      </View>
      {tab === "mine" ? (
        <>
          {mine.length === 0 && (
            <Glass radius={20}>
              <View style={{ padding: 22, alignItems: "center" }}>
                <Image source={heroImg} style={styles.emptyHero} resizeMode="cover" />
                <Text style={styles.emptyTitle}>No clubs yet</Text>
                <Text style={styles.emptyText}>Find a crew to roll with, or start your own — tap +.</Text>
              </View>
            </Glass>
          )}
          {mine.map((c: any) => (
            <CommunityCard key={c.id} c={c} active={c.id === activeId} onPress={() => onOpen(c)} />
          ))}
        </>
      ) : (
        <>
          <TextInput
            testID="club-search" style={styles.clubSearchInput}
            placeholder="Search public clubs…" placeholderTextColor={COLORS.textMute}
            value={exploreQ} onChangeText={onSearch}
          />
          <TouchableOpacity testID="search-community" onPress={onCode} style={styles.inviteLink}>
            <Ionicons name="key-outline" size={14} color={accent} />
            <Text style={[styles.inviteLinkText, { color: accent }]}>Have an invite code?</Text>
          </TouchableOpacity>
          {explore.length === 0 && !exploreLoading && (
            <Text style={styles.emptyText}>No public clubs found yet. Be the first — tap +.</Text>
          )}
          {explore.map((c: any) => (
            <CommunityCard key={c.id} c={c} mode="explore" onJoin={onJoin} onPress={() => onOpen(c)} />
          ))}
        </>
      )}
    </>
  );
}

/** The FAB's sheet. Create moved off the page: it owned the best real estate for
 *  the rarest action. */
function CreateSheet({ visible, accent, onClose, onPick }: {
  visible: boolean; accent: string; onClose: () => void;
  onPick: (what: "cruise" | "event" | "club") => void;
}) {
  const well = useAccentAlpha(0.14);
  const ROWS: [string, string, "cruise" | "event" | "club"][] = [
    ["git-branch", "Plan a cruise", "cruise"],
    ["location", "Post a meet", "event"],
    ["people", "Start a club", "club"],
  ];
  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose}>
      <TouchableOpacity style={styles.sheetBackdrop} activeOpacity={1} onPress={onClose}>
        <View style={styles.createSheet}>
          {ROWS.map(([icon, label, what], i) => (
            <TouchableOpacity key={what} testID={`create-${what}`} activeOpacity={0.85} onPress={() => onPick(what)}
              style={[styles.createSheetRow, i > 0 ? { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: "rgba(255,255,255,0.10)" } : null]}>
              <View style={[styles.feedGlyph, { backgroundColor: well }]}>
                <Ionicons name={icon as any} size={20} color={accent} />
              </View>
              <Text style={styles.createSheetTxt}>{label}</Text>
            </TouchableOpacity>
          ))}
        </View>
      </TouchableOpacity>
    </Modal>
  );
}

// Velox-style club card: full-width cover banner → logo + name + member count →
// description → category tag chips. `mode` swaps the trailing control: a chevron on
// "My Clubs" (opens detail) vs a Join / Joined / Pending state on "Explore".
function CommunityCard({ c, onPress, active, mode = "mine", onJoin }: {
  c: Community; onPress: () => void; active?: boolean;
  mode?: "mine" | "explore"; onJoin?: (c: Community) => void;
}) {
  const tags = (c.tags || []).slice(0, 4);
  const carGlyph = useAccentAlpha(0.35);
  const accent = useAccent();
  return (
    <TouchableOpacity testID={`community-${c.id}`} onPress={onPress} activeOpacity={0.9} style={{ marginBottom: 14 }}>
      <Glass radius={20}>
        <View style={styles.clubCardInner}>
          {/* Cover banner (falls back to a branded gradient when none is set) */}
          {c.banner_b64 ? (
            <Image source={{ uri: c.banner_b64 }} style={styles.clubBanner} resizeMode="cover" />
          ) : (
            <LinearGradient colors={["#0F2A22", "#12352A", "#0B0B0C"]} start={{ x: 0, y: 0 }} end={{ x: 1, y: 1 }} style={styles.clubBanner}>
              <Ionicons name="car-sport" size={40} color={carGlyph} />
            </LinearGradient>
          )}
          {active && (
            <View style={styles.clubActivePill}>
              <Ionicons name="radio" size={11} color="#0A0A0A" />
              <Text style={styles.clubActivePillText}>ACTIVE</Text>
            </View>
          )}

          <View style={styles.clubBody}>
            <View style={{ flexDirection: "row", alignItems: "center", gap: 10 }}>
              {c.logo_b64 ? (
                <Image source={{ uri: c.logo_b64 }} style={styles.clubLogo} />
              ) : (
                <View style={styles.clubLogoPlaceholder}><Ionicons name="people" size={20} color={accent} /></View>
              )}
              <View style={{ flex: 1 }}>
                <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
                  <Text style={styles.clubName} numberOfLines={1}>{c.name}</Text>
                  {c.is_admin && <View style={styles.adminBadge}><Text style={styles.adminBadgeText}>ADMIN</Text></View>}
                </View>
                <View style={{ flexDirection: "row", alignItems: "center", gap: 4, marginTop: 3 }}>
                  <Ionicons name="people" size={13} color={COLORS.textDim} />
                  <Text style={styles.clubMeta}>{c.member_count} member{c.member_count === 1 ? "" : "s"}{c.pending_count > 0 && c.is_admin ? ` · ${c.pending_count} pending` : ""}</Text>
                </View>
              </View>
              {mode === "explore" ? (
                c.is_member ? (
                  <View style={styles.joinedPill}><Text style={styles.joinedPillText}>Joined</Text></View>
                ) : c.is_pending ? (
                  <View style={styles.pendingPill}><Text style={styles.pendingPillText}>Pending</Text></View>
                ) : (
                  <TouchableOpacity testID={`join-${c.id}`} onPress={() => onJoin?.(c)} style={styles.joinBtn}>
                    <Text style={styles.joinBtnText}>Join</Text>
                  </TouchableOpacity>
                )
              ) : (
                <Ionicons name="chevron-forward" size={20} color={COLORS.textDim} />
              )}
            </View>
            {!!c.description && <Text style={styles.clubDesc} numberOfLines={2}>{c.description}</Text>}
            {tags.length > 0 && (
              <View style={styles.clubTags}>
                {tags.map((t) => (
                  <View key={t} style={styles.clubTag}><Text style={styles.clubTagText}>{t}</Text></View>
                ))}
              </View>
            )}
          </View>
        </View>
      </Glass>
    </TouchableOpacity>
  );
}

function CreateModal({ visible, onClose, onCreated }: any) {
  const skinColors = useAppSkinColors();
  const accent = useAccent();
  const tagTint = useAccentAlpha(0.18);
  const [name, setName] = useState("");
  const [desc, setDesc] = useState("");
  const [isPublic, setIsPublic] = useState(true);
  // Per-community feature toggles. Default ON so existing behaviour is unchanged.
  const [walkie, setWalkie] = useState(true);
  const [music, setMusic] = useState(true);
  const [mapEnabled, setMapEnabled] = useState(true);
  // Optional logo as a base64 data URL (kept tiny — we resize on import).
  const [logo, setLogo] = useState<string | null>(null);
  // Optional wide cover/banner image + category tags (Velox-style card).
  const [banner, setBanner] = useState<string | null>(null);
  const [tags, setTags] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);

  const pickLogo = async () => {
    try {
      const perm = await ImagePicker.requestMediaLibraryPermissionsAsync();
      if (perm.status !== "granted") {
        return Alert.alert("Permission needed", "We need photo access to set a club logo.");
      }
      const res = await ImagePicker.launchImageLibraryAsync({
        mediaTypes: ImagePicker.MediaTypeOptions.Images,
        allowsEditing: true,
        aspect: [1, 1],
        quality: 0.6,
        base64: true,
      });
      if (res.canceled) return;
      const a = res.assets?.[0];
      if (!a?.base64) return;
      const mime = a.mimeType || "image/jpeg";
      setLogo(`data:${mime};base64,${a.base64}`);
    } catch (e) { Alert.alert("Pick failed", formatErr(e)); }
  };

  const pickBanner = async () => {
    try {
      const perm = await ImagePicker.requestMediaLibraryPermissionsAsync();
      if (perm.status !== "granted") return Alert.alert("Permission needed", "We need photo access to set a cover image.");
      const res = await ImagePicker.launchImageLibraryAsync({
        mediaTypes: ImagePicker.MediaTypeOptions.Images,
        allowsEditing: true, aspect: [16, 9], quality: 0.5, base64: true,
      });
      if (res.canceled) return;
      const a = res.assets?.[0];
      if (!a?.base64) return;
      setBanner(`data:${a.mimeType || "image/jpeg"};base64,${a.base64}`);
    } catch (e) { Alert.alert("Pick failed", formatErr(e)); }
  };
  const toggleTag = (t: string) => setTags((prev) => prev.includes(t) ? prev.filter((x) => x !== t) : [...prev, t]);

  const submit = async () => {
    if (!name.trim()) return Alert.alert("Name required");
    try {
      setBusy(true);
      await api.post("/communities", {
        name: name.trim(),
        description: desc,
        is_public: isPublic,
        logo_b64: logo,
        banner_b64: banner,
        tags,
        walkie_enabled: walkie,
        music_enabled: music,
        map_enabled: mapEnabled,
      });
      setName(""); setDesc(""); setLogo(null); setBanner(null); setTags([]);
      setWalkie(true); setMusic(true); setMapEnabled(true);
      onCreated();
    } catch (e) { Alert.alert("Create failed", formatErr(e)); }
    finally { setBusy(false); }
  };

  return (
    <Modal visible={visible} animationType="slide" transparent onRequestClose={onClose}>
      <KeyboardAvoidingView style={styles.modalRoot} behavior={Platform.OS === "ios" ? "padding" : undefined}>
        <View style={styles.sheet}>
          <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={{ paddingBottom: 24 }}>
            <View style={styles.sheetHeader}>
              <Text style={styles.sheetTitle}>Create club</Text>
              <TouchableOpacity onPress={onClose}><Ionicons name="close" size={22} color={COLORS.textDim} /></TouchableOpacity>
            </View>

            {/* Cover image — wide banner across the top of the card. */}
            <TouchableOpacity testID="cc-banner" onPress={pickBanner} activeOpacity={0.85} style={styles.bannerPicker}>
              {banner ? (
                <Image source={{ uri: banner }} style={styles.bannerImg} resizeMode="cover" />
              ) : (
                <View style={styles.bannerPlaceholder}>
                  <Ionicons name="image-outline" size={26} color={COLORS.textDim} />
                  <Text style={styles.logoHint}>Add cover image</Text>
                </View>
              )}
            </TouchableOpacity>

            {/* Logo picker — large round avatar at the top, tappable. */}
            <View style={{ alignItems: "center", marginVertical: 6 }}>
              <TouchableOpacity testID="cc-logo" onPress={pickLogo} activeOpacity={0.85} style={styles.logoPicker}>
                {logo ? (
                  <Image source={{ uri: logo }} style={styles.logoImg} />
                ) : (
                  <View style={styles.logoPlaceholder}>
                    <Ionicons name="image-outline" size={28} color={COLORS.textDim} />
                    <Text style={styles.logoHint}>Add logo</Text>
                  </View>
                )}
              </TouchableOpacity>
            </View>

            <Text style={styles.label}>Name</Text>
            <TextInput testID="cc-name" value={name} onChangeText={setName} style={styles.input} placeholder="Sunday Drivers" placeholderTextColor={COLORS.textMute} />
            <Text style={styles.label}>Description</Text>
            <TextInput testID="cc-desc" value={desc} onChangeText={setDesc} style={[styles.input, { height: 80 }]} multiline placeholder="What's this club about?" placeholderTextColor={COLORS.textMute} />

            <Text style={[styles.label, { marginTop: 14 }]}>Tags</Text>
            <View style={styles.tagWrap}>
              {SUGGESTED_TAGS.map((t) => {
                const on = tags.includes(t);
                return (
                  <TouchableOpacity key={t} onPress={() => toggleTag(t)} style={[styles.tagChip, on && styles.tagChipOn, on && { backgroundColor: tagTint }]}>
                    <Text style={[styles.tagChipText, on && styles.tagChipTextOn]}>{t}</Text>
                  </TouchableOpacity>
                );
              })}
            </View>

            <TouchableOpacity testID="cc-public" onPress={() => setIsPublic((v) => !v)} style={styles.toggleRow}>
              <View style={[styles.toggleBox, isPublic && { backgroundColor: accent, borderColor: accent }]}>
                {isPublic && <Ionicons name="checkmark" size={14} color="#fff" />}
              </View>
              <View style={{ flex: 1 }}>
                <Text style={styles.toggleTitle}>Public</Text>
                <Text style={styles.toggleSub}>Anyone can find this club and request to join</Text>
              </View>
            </TouchableOpacity>

            <Text style={[styles.label, { marginTop: 18 }]}>Connect features</Text>
            <FeatureToggle
              testID="cc-walkie"
              icon="flash" iconColor="#FF6A00"
              title="Walkie-Talkie Connect"
              sub="Enable push-to-talk channel for this club"
              value={walkie} onChange={setWalkie}
            />
            <FeatureToggle
              testID="cc-music"
              icon="musical-notes" iconColor="#FF453A"
              title="Music Connect"
              sub="Members can sync to the admin's Spotify session"
              value={music} onChange={setMusic}
            />
            <FeatureToggle
              testID="cc-map"
              icon="map" iconColor="#0A84FF"
              title="Map Connect"
              sub="Share live location and admin-curated routes on the map"
              value={mapEnabled} onChange={setMapEnabled}
            />

            <TouchableOpacity testID="cc-submit" onPress={submit} disabled={busy} style={styles.btn} activeOpacity={0.85}>
              <LinearGradient colors={skinColors.colors} locations={skinColors.locations} style={styles.btnGrad}>
                <Text style={[styles.btnText, { color: "#1a1a1a" }]}>{busy ? "Creating…" : "Create club"}</Text>
              </LinearGradient>
            </TouchableOpacity>
          </ScrollView>
        </View>
      </KeyboardAvoidingView>
    </Modal>
  );
}

// Reusable iOS-style switch row used inside CreateModal.
function FeatureToggle({ testID, icon, iconColor, title, sub, value, onChange }: any) {
  const accent = useAccent();
  return (
    <View style={styles.featureRow}>
      <View style={[styles.featureIco, { backgroundColor: iconColor + "22" }]}>
        <Ionicons name={icon} size={18} color={iconColor} />
      </View>
      <View style={{ flex: 1 }}>
        <Text style={styles.featureTitle}>{title}</Text>
        <Text style={styles.featureSub}>{sub}</Text>
      </View>
      <Switch
        testID={testID}
        value={value}
        onValueChange={onChange}
        trackColor={{ false: "rgba(255,255,255,0.12)", true: accent }}
        thumbColor={value ? "#1a1a1a" : "#999"}
      />
    </View>
  );
}

function SearchModal({ visible, onClose, onChanged }: any) {
  const [q, setQ] = useState("");
  const [results, setResults] = useState<Community[]>([]);
  const [code, setCode] = useState("");

  useEffect(() => {
    if (!visible) return;
    const t = setTimeout(async () => {
      try { const { data } = await api.get("/communities/search", { params: { q } }); setResults(data); } catch {}
    }, 250);
    return () => clearTimeout(t);
  }, [q, visible]);

  const requestJoin = async (c: Community) => {
    try { await api.post(`/communities/${c.id}/request`); onChanged(); Alert.alert("Sent", "Join request sent. The admin will review it."); }
    catch (e) { Alert.alert("Failed", formatErr(e)); }
  };

  const joinByCode = async () => {
    if (!code.trim()) return;
    try {
      await api.post("/communities/join", null, { params: { code: code.trim() } });
      setCode(""); onChanged(); onClose();
      Alert.alert("Joined", "Welcome to the club");
    } catch (e) { Alert.alert("Failed", formatErr(e)); }
  };

  return (
    <Modal visible={visible} animationType="slide" transparent onRequestClose={onClose}>
      <View style={styles.modalRoot}>
        <View style={[styles.sheet, { maxHeight: "85%" }]}>
          <View style={styles.sheetHeader}>
            <Text style={styles.sheetTitle}>Discover clubs</Text>
            <TouchableOpacity onPress={onClose}><Ionicons name="close" size={22} color={COLORS.textDim} /></TouchableOpacity>
          </View>

          <Text style={styles.label}>Have an invite code?</Text>
          <View style={{ flexDirection: "row", gap: 8 }}>
            <TextInput testID="search-code" value={code} onChangeText={setCode} style={[styles.input, { flex: 1 }]} placeholder="Paste code" placeholderTextColor={COLORS.textMute} autoCapitalize="none" />
            <TouchableOpacity testID="search-code-go" onPress={joinByCode} style={styles.smallBtn}>
              <Text style={styles.smallBtnText}>Join</Text>
            </TouchableOpacity>
          </View>

          <Text style={[styles.label, { marginTop: 16 }]}>Search public clubs</Text>
          <TextInput testID="search-q" value={q} onChangeText={setQ} style={styles.input} placeholder="e.g. JDM, mountain, drift" placeholderTextColor={COLORS.textMute} autoCapitalize="none" />

          <ScrollView style={{ marginTop: 12 }} contentContainerStyle={{ paddingBottom: 30 }}>
            {results.length === 0 && <Text style={{ color: COLORS.textMute, textAlign: "center", marginTop: 12 }}>No clubs found</Text>}
            {/* Same Velox club card as Explore / My Clubs (cover banner, logo, tags,
                Join / Joined / Pending) — discovery now matches the rest of the app. */}
            {results.map((c) => (
              <CommunityCard key={c.id} c={c} mode="explore" onJoin={requestJoin} onPress={() => {}} />
            ))}
          </ScrollView>
        </View>
      </View>
    </Modal>
  );
}

function CommunityDetailModal({ community, onClose, onChanged }: any) {
  const accent = useAccent();
  const activeBtnTint = useAccentAlpha(0.12);
  const activeBtnEdge = useAccentAlpha(0.4);
  const tagTint = useAccentAlpha(0.18);
  const boardTabTint = useAccentAlpha(0.20);
  const boardMeEdge = useAccentAlpha(0.55);
  const [settings] = useSettings();
  const { user } = useAuth();
  const [c, setC] = useState<any>(null);
  // Description-edit state (admin only). The save button only enables when the
  // textarea has actually changed from the canonical server value.
  const [editingDesc, setEditingDesc] = useState(false);
  const [descDraft, setDescDraft] = useState("");
  const [descSaving, setDescSaving] = useState(false);
  // Name-edit + logo state (admin only).
  const [editingName, setEditingName] = useState(false);
  const [nameDraft, setNameDraft] = useState("");
  const [nameSaving, setNameSaving] = useState(false);
  const [logoSaving, setLogoSaving] = useState(false);
  const [bannerSaving, setBannerSaving] = useState(false);
  // ── LEADERBOARD ──────────────────────────────────────────────────────────
  // Ranked by distance recorded on drives tagged to THIS club. The rows come from
  // public.trips, which deliberately holds distance/duration/when and NO coordinates —
  // members compare mileage without publishing where anyone drove. See src/trips.ts.
  const [board, setBoard] = useState<{ userId: string; handle: string; km: number; drives: number; pb: number }[]>([]);
  // Two things members actually care about: how much they've driven, and how fast
  // they've gone. Time windows were dropped (Jeff, 2026-07-28) — a club board is a
  // standing brag, not a rolling report, and PB is a lifetime record either way.
  const [boardMode, setBoardMode] = useState<'drives' | 'pb'>('drives');
  useEffect(() => {
    if (!community?.id) { setBoard([]); return; }
    let dead = false;
    (async () => {
      const rows = await fetchClubLeaderboard(String(community.id));
      if (dead) return;
      // SEED FROM THE ROSTER. Distance only exists for drives recorded since the feature
      // shipped, so a club with real members and real PBs would otherwise show NOTHING —
      // which reads as broken rather than as empty (Jeff, 2026-07-28: "shouldn't the PB
      // activate it since there are PB right now?"). Every member starts on the board at
      // 0 km with the PB already on their profile, and recorded trips overlay on top as
      // they come in. PB here is the LIFETIME profile record; once a member has recorded
      // trips, the higher of the two wins so the number never goes backwards.
      // PBs. Three sources, because no single one covers the whole club:
      //   1. the roster itself (currently omits top_speed_record — hence the rest)
      //   2. /users/nearby, the SAME feed the peer card reads for "PB 174 km/h";
      //      it returns full profiles, so it covers members this phone has never
      //      driven near, which the local cache alone cannot
      //   3. the local cache, as the offline fallback
      // Without 2, only members seen live as peers had a PB and everyone else showed "—".
      const pbCache = await getPeerPbs();
      let pbLive: Record<string, number> = {};
      try {
        const { data } = await api.get("/users/nearby", { params: { radius_km: 20000 } });
        for (const u of (Array.isArray(data) ? data : [])) {
          const v = Number(u?.top_speed_record) || 0;
          if (u?.id && v > 0) pbLive[String(u.id)] = v;
        }
      } catch {}
      if (dead) return;
      const roster: any[] = c?.members_users || [];
      const byId = new Map(rows.map((r) => [r.userId, { ...r }]));
      for (const m of roster) {
        const id = String(m?.id ?? "");
        if (!id) continue;
        // The PB shown on the peer card (e.g. "PB 174 km/h") is top_speed_record. Read it
        // tolerantly: the roster endpoint and the presence payload have historically
        // spelled this differently, and an unrecognised field would silently render an
        // empty PB column rather than an error anyone would notice.
        const profilePb =
          Number(m?.top_speed_record) ||
          Number(m?.topSpeed) ||
          Number(m?.top_speed) ||
          Number(m?.pb) ||
          Number(pbLive[String(m?.id ?? '')]) ||
          Number(pbCache[String(m?.id ?? '')]) || 0;
        const cur = byId.get(id);
        if (cur) {
          cur.pb = Math.max(cur.pb || 0, profilePb);
          if (!cur.handle || cur.handle === "Driver") cur.handle = m?.handle || cur.handle;
        } else {
          byId.set(id, { userId: id, handle: m?.handle || "anon", km: 0, drives: 0, pb: profilePb });
        }
      }
      // PB ranks on top speed; Drives ranks on distance. Each falls back to the other so
      // members with nothing recorded yet still order sensibly instead of clumping.
      const merged = [...byId.values()].sort((a, b) =>
        boardMode === 'pb' ? (b.pb - a.pb) || (b.km - a.km) : (b.km - a.km) || (b.pb - a.pb));
      setBoard(merged);
    })();
    return () => { dead = true; };
  }, [community?.id, boardMode, c?.members_users]);
  useEffect(() => {
    if (!community) { setC(null); setEditingDesc(false); setEditingName(false); return; }
    (async () => {
      try {
        const { data } = await api.get(`/communities/${community.id}`);
        setC(data);
        setDescDraft(data?.description || "");
        setNameDraft(data?.name || "");
      } catch {}
    })();
  }, [community]);

  // Active-convoy state — the community you're actively driving with. Drives
  // map presence broadcast, comms HD proximity tier, and which crew the Comms
  // page surfaces. Reads/writes settings.activeCommunityId (persisted).
  const activeId = settings.activeCommunityId;
  const isActive = !!(c?.id || community?.id) && activeId === (c?.id || community?.id);
  const toggleActive = () => {
    const id = c?.id || community?.id;
    if (!id) return;
    updateSettings({ activeCommunityId: isActive ? null : id });
  };

  // Admin: rename the community (backend PUT accepts `name`).
  const saveName = async () => {
    if (!c?.id || !nameDraft.trim()) return;
    try {
      setNameSaving(true);
      const { data } = await api.put(`/communities/${c.id}`, { name: nameDraft.trim() });
      setC({ ...c, ...data });
      setEditingName(false);
      onChanged();
    } catch (e) { Alert.alert("Failed", formatErr(e)); }
    finally { setNameSaving(false); }
  };

  // Admin: change the community profile pic (backend PUT accepts `logo_b64`).
  const pickAndSaveLogo = async () => {
    try {
      const perm = await ImagePicker.requestMediaLibraryPermissionsAsync();
      if (perm.status !== "granted") return Alert.alert("Permission needed", "We need photo access to set a club logo.");
      const res = await ImagePicker.launchImageLibraryAsync({
        mediaTypes: ImagePicker.MediaTypeOptions.Images,
        allowsEditing: true, aspect: [1, 1], quality: 0.6, base64: true,
      });
      if (res.canceled) return;
      const a = res.assets?.[0];
      if (!a?.base64) return;
      const logo_b64 = `data:${a.mimeType || "image/jpeg"};base64,${a.base64}`;
      setLogoSaving(true);
      const { data } = await api.put(`/communities/${c.id}`, { logo_b64 });
      setC({ ...c, ...data });
      onChanged();
    } catch (e) { Alert.alert("Failed", formatErr(e)); }
    finally { setLogoSaving(false); }
  };

  // Admin: change the wide cover/banner image (backend PUT accepts `banner_b64`).
  const pickAndSaveBanner = async () => {
    try {
      const perm = await ImagePicker.requestMediaLibraryPermissionsAsync();
      if (perm.status !== "granted") return Alert.alert("Permission needed", "We need photo access to set a cover image.");
      const res = await ImagePicker.launchImageLibraryAsync({
        mediaTypes: ImagePicker.MediaTypeOptions.Images, allowsEditing: true, aspect: [16, 9], quality: 0.5, base64: true,
      });
      if (res.canceled) return;
      const a = res.assets?.[0];
      if (!a?.base64) return;
      const banner_b64 = `data:${a.mimeType || "image/jpeg"};base64,${a.base64}`;
      setBannerSaving(true);
      const { data } = await api.put(`/communities/${c.id}`, { banner_b64 });
      setC({ ...c, ...data });
      onChanged();
    } catch (e) { Alert.alert("Failed", formatErr(e)); }
    finally { setBannerSaving(false); }
  };

  // Admin: toggle a category tag, saving immediately.
  const toggleTagSave = async (t: string) => {
    if (!c?.id) return;
    const cur: string[] = c.tags || [];
    const next = cur.includes(t) ? cur.filter((x: string) => x !== t) : [...cur, t];
    try { const { data } = await api.put(`/communities/${c.id}`, { tags: next }); setC({ ...c, ...data }); onChanged(); }
    catch (e) { Alert.alert("Failed", formatErr(e)); }
  };

  const saveDescription = async () => {
    if (!c?.id) return;
    try {
      setDescSaving(true);
      const { data } = await api.put(`/communities/${c.id}`, { description: descDraft });
      setC({ ...c, ...data });
      setEditingDesc(false);
      onChanged();
    } catch (e) { Alert.alert("Failed", formatErr(e)); }
    finally { setDescSaving(false); }
  };

  const approve = async (uid: string) => {
    try { const { data } = await api.post(`/communities/${community.id}/approve/${uid}`); setC({ ...c, ...data, pending_users: c.pending_users.filter((u: any) => u.id !== uid) }); onChanged(); } catch (e) { Alert.alert("Failed", formatErr(e)); }
  };
  const reject = async (uid: string) => {
    try { const { data } = await api.post(`/communities/${community.id}/reject/${uid}`); setC({ ...c, ...data, pending_users: c.pending_users.filter((u: any) => u.id !== uid) }); onChanged(); } catch (e) { Alert.alert("Failed", formatErr(e)); }
  };
  const shareInvite = async () => {
    if (!c?.invite_code) return;
    try { await Share.share({ message: `Join my Hairpin club "${c.name}". Use invite code: ${c.invite_code}` }); }
    catch {}
  };
  const leave = async () => {
    try { await api.post(`/communities/${community.id}/leave`); onChanged(); onClose(); }
    catch (e) { Alert.alert("Failed", formatErr(e)); }
  };
  const remove = async () => {
    Alert.alert("Delete club?", "This cannot be undone.", [
      { text: "Cancel", style: "cancel" },
      { text: "Delete", style: "destructive", onPress: async () => {
        try { await api.delete(`/communities/${community.id}`); onChanged(); onClose(); }
        catch (e) { Alert.alert("Failed", formatErr(e)); }
      }},
    ]);
  };

  // ===== Admin: member + admin management =====
  const refreshDetail = async () => {
    if (!c?.id) return;
    try { const { data } = await api.get(`/communities/${c.id}`); setC(data); } catch {}
  };
  const removeMember = (m: any) => {
    Alert.alert("Remove member?", `Remove ${m.handle || "this member"} from the club?`, [
      { text: "Cancel", style: "cancel" },
      { text: "Remove", style: "destructive", onPress: async () => {
        try { await api.delete(`/communities/${c.id}/members/${m.id}`); await refreshDetail(); onChanged(); }
        catch (e) { Alert.alert("Failed", formatErr(e)); }
      }},
    ]);
  };
  const toggleAdmin = async (m: any) => {
    try {
      if (m.is_admin) await api.delete(`/communities/${c.id}/admins/${m.id}`);
      else await api.post(`/communities/${c.id}/admins/${m.id}`);
      await refreshDetail(); onChanged();
    } catch (e) { Alert.alert("Failed", formatErr(e)); }
  };
  const transfer = (m: any) => {
    Alert.alert("Hand over ownership?", `Make ${m.handle || "this member"} the owner? You'll stay on as a regular member.`, [
      { text: "Cancel", style: "cancel" },
      { text: "Hand over", style: "destructive", onPress: async () => {
        try { await api.post(`/communities/${c.id}/transfer/${m.id}`); await refreshDetail(); onChanged(); }
        catch (e) { Alert.alert("Failed", formatErr(e)); }
      }},
    ]);
  };

  // Global member search (find anyone on Convoy, then add to this community).
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchQ, setSearchQ] = useState("");
  const [searchResults, setSearchResults] = useState<any[]>([]);
  const searchTimer = useRef<any>(null);
  const memberIds: string[] = (c?.members_users || []).map((m: any) => m.id);
  const doSearch = (q: string) => {
    setSearchQ(q);
    if (searchTimer.current) clearTimeout(searchTimer.current);
    if (q.trim().length < 2) { setSearchResults([]); return; }
    searchTimer.current = setTimeout(async () => {
      try { const { data } = await api.get("/users/search", { params: { q } }); setSearchResults(data); }
      catch { setSearchResults([]); }
    }, 250);
  };
  const addMember = async (uid: string) => {
    try { await api.post(`/communities/${c.id}/members/${uid}`); await refreshDetail(); onChanged(); }
    catch (e) { Alert.alert("Failed", formatErr(e)); }
  };

  return (
    <>
    <Modal visible={!!community} animationType="slide" transparent onRequestClose={onClose}>
      <View style={styles.modalRoot}>
        <View style={[styles.sheet, { maxHeight: "85%" }]}>
          <View style={styles.sheetHeader}>
            <Text style={styles.sheetTitle}>{c?.name || community?.name}</Text>
            <TouchableOpacity onPress={onClose}><Ionicons name="close" size={22} color={COLORS.textDim} /></TouchableOpacity>
          </View>
          <ScrollView contentContainerStyle={{ paddingBottom: 24 }}>
            {/* Active-convoy toggle — sets this as the crew you're driving with. */}
            {(c?.is_member || c?.is_admin) && (
              <TouchableOpacity
                testID="set-active-community"
                onPress={toggleActive}
                activeOpacity={0.85}
                style={[styles.activeBtn, { backgroundColor: activeBtnTint, borderColor: activeBtnEdge }, isActive && styles.activeBtnOn]}
              >
                <Ionicons name={isActive ? "radio" : "radio-outline"} size={18} color={isActive ? "#0A0A0A" : accent} />
                <Text style={[styles.activeBtnText, isActive && { color: "#0A0A0A" }]} numberOfLines={1}>
                  {isActive ? "Active convoy — you're driving with this crew" : "Set as active convoy"}
                </Text>
              </TouchableOpacity>
            )}

            {/* Admin identity editor — tappable logo + name. Members see the
                read-only name in the sheet title above. */}
            {c?.is_admin && (
              <View style={styles.adminIdentity}>
                <TouchableOpacity onPress={pickAndSaveLogo} activeOpacity={0.85} style={styles.adminLogoWrap} testID="edit-community-logo">
                  {c?.logo_b64 ? (
                    <Image source={{ uri: c.logo_b64 }} style={styles.adminLogo} />
                  ) : (
                    <View style={styles.adminLogoPlaceholder}><Ionicons name="image-outline" size={22} color={COLORS.textDim} /></View>
                  )}
                  <View style={styles.adminLogoEditBadge}>
                    <Ionicons name={logoSaving ? "hourglass" : "camera"} size={12} color="#0A0A0A" />
                  </View>
                </TouchableOpacity>
                <View style={{ flex: 1 }}>
                  {editingName ? (
                    <View style={{ flexDirection: "row", gap: 8, alignItems: "center" }}>
                      <TextInput
                        testID="edit-community-name"
                        value={nameDraft}
                        onChangeText={setNameDraft}
                        style={[styles.input, { flex: 1, marginTop: 0 }]}
                        placeholder="Club name"
                        placeholderTextColor={COLORS.textMute}
                      />
                      <TouchableOpacity
                        onPress={saveName}
                        disabled={nameSaving || !nameDraft.trim()}
                        style={[styles.smallBtn, { backgroundColor: COLORS.success, opacity: nameSaving || !nameDraft.trim() ? 0.5 : 1 }]}
                      >
                        <Text style={styles.smallBtnText}>{nameSaving ? "…" : "Save"}</Text>
                      </TouchableOpacity>
                    </View>
                  ) : (
                    <TouchableOpacity onPress={() => { setNameDraft(c?.name || ""); setEditingName(true); }} activeOpacity={0.7} style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
                      <Text style={styles.adminIdentityName} numberOfLines={1}>{c?.name}</Text>
                      <Ionicons name="pencil" size={14} color={COLORS.warning} />
                    </TouchableOpacity>
                  )}
                  <Text style={styles.adminIdentityHint}>Tap the photo or name to edit</Text>
                </View>
              </View>
            )}

            {/* Admin: wide cover image + category tags (the Velox-style card). */}
            {c?.is_admin && (
              <View style={{ marginBottom: 14 }}>
                <TouchableOpacity onPress={pickAndSaveBanner} activeOpacity={0.85} style={styles.detailBannerEdit} testID="edit-community-banner">
                  {c?.banner_b64 ? (
                    <Image source={{ uri: c.banner_b64 }} style={styles.detailBannerImg} resizeMode="cover" />
                  ) : (
                    <View style={styles.detailBannerPlaceholder}>
                      <Ionicons name={bannerSaving ? "hourglass" : "image-outline"} size={22} color={COLORS.textDim} />
                      <Text style={styles.logoHint}>Add cover image</Text>
                    </View>
                  )}
                  <View style={styles.detailBannerBadge}><Ionicons name="camera" size={12} color="#0A0A0A" /></View>
                </TouchableOpacity>
                <Text style={[styles.label, { marginTop: 12 }]}>Tags</Text>
                <View style={styles.tagWrap}>
                  {SUGGESTED_TAGS.map((t) => {
                    const on = (c.tags || []).includes(t);
                    return (
                      <TouchableOpacity key={t} onPress={() => toggleTagSave(t)} style={[styles.tagChip, on && styles.tagChipOn, on && { backgroundColor: tagTint }]}>
                        <Text style={[styles.tagChipText, on && styles.tagChipTextOn]}>{t}</Text>
                      </TouchableOpacity>
                    );
                  })}
                </View>
              </View>
            )}

            {/* Description — read-only for members, inline-edit for admin. */}
            {c?.is_admin && editingDesc ? (
              <View style={{ marginBottom: 6 }}>
                <TextInput
                  value={descDraft}
                  onChangeText={setDescDraft}
                  style={[styles.input, { height: 90, marginTop: 0 }]}
                  multiline
                  placeholder="What's this club about?"
                  placeholderTextColor={COLORS.textMute}
                />
                <View style={{ flexDirection: "row", gap: 8, marginTop: 8 }}>
                  <TouchableOpacity
                    onPress={saveDescription}
                    disabled={descSaving || descDraft === (c?.description || "")}
                    style={[styles.smallBtn, { backgroundColor: COLORS.success, opacity: descSaving || descDraft === (c?.description || "") ? 0.5 : 1 }]}
                  >
                    <Text style={styles.smallBtnText}>{descSaving ? "Saving…" : "Save"}</Text>
                  </TouchableOpacity>
                  <TouchableOpacity
                    onPress={() => { setDescDraft(c?.description || ""); setEditingDesc(false); }}
                    style={[styles.smallBtn, { backgroundColor: "rgba(118,118,128,0.4)" }]}
                  >
                    <Text style={styles.smallBtnText}>Cancel</Text>
                  </TouchableOpacity>
                </View>
              </View>
            ) : (
              <TouchableOpacity
                activeOpacity={c?.is_admin ? 0.7 : 1}
                onPress={() => { if (c?.is_admin) setEditingDesc(true); }}
              >
                <Text style={styles.detailDesc}>
                  {c?.description || "No description"}
                  {c?.is_admin && <Text style={{ color: COLORS.warning, fontSize: 12 }}>  ✎ tap to edit</Text>}
                </Text>
              </TouchableOpacity>
            )}
            <Text style={styles.detailMeta}>{c?.member_count} members · Admin: {c?.admin_handle || "—"}</Text>

            {/* ── LEADERBOARD ── Who's actually putting the kilometres in. Hidden until
                someone has recorded a drive, so a new club doesn't show an empty board. */}
            {board.length > 0 && (
              <>
                <View style={styles.boardHead}>
                  <Text style={styles.label}>Leaderboard</Text>
                  <View style={styles.boardToggle}>
                    {([['drives', 'Drives'], ['pb', 'PB']] as const).map(([m, label]) => (
                      <TouchableOpacity
                        key={m}
                        onPress={() => setBoardMode(m)}
                        style={[styles.boardTab, boardMode === m && styles.boardTabOn, boardMode === m && { backgroundColor: boardTabTint }]}
                      >
                        <Text style={[styles.boardTabText, boardMode === m && styles.boardTabTextOn, boardMode === m && { color: accent }]}>
                          {label}
                        </Text>
                      </TouchableOpacity>
                    ))}
                  </View>
                </View>
                {board.slice(0, 10).map((row, i) => {
                  const me = user?.id != null && String(user.id) === row.userId;
                  return (
                    <View key={row.userId} style={[styles.boardRow, me && styles.boardRowMe, me && { borderColor: boardMeEdge }]}>
                      <Text style={[styles.boardRank, i < 3 && styles.boardRankTop, i < 3 && { color: accent }]}>{i + 1}</Text>
                      <Text style={[styles.boardHandle, me && { fontWeight: "800" }]} numberOfLines={1}>
                        {row.handle}{me ? " · you" : ""}
                      </Text>
                      {/* PB = the member's fastest km/h on any drive counted here — a MAX,
                          not a total, so it doesn't grow just by driving more. */}
                      {/* ONE metric per tab (Jeff, 2026-07-28): PB has no business on the
                          Drives board and a 0 km column has none on the PB board. Each tab
                          shows only what it ranks on, so nothing competes with the number
                          the order actually reflects. */}
                      {boardMode === 'pb' ? (
                        <Text style={[styles.boardKm, { color: accent }]}>{row.pb > 0 ? `${Math.round(row.pb)} km/h` : "—"}</Text>
                      ) : (
                        <>
                          <Text style={styles.boardDrives}>{row.drives}{row.drives === 1 ? " drive" : " drives"}</Text>
                          <Text style={[styles.boardKm, { color: accent }]}>{fmtKm(row.km)}</Text>
                        </>
                      )}
                    </View>
                  );
                })}
              </>
            )}

            {/* Member roster — visible to every member. Shows handle + car
                line + an ADMIN pill on the owner so it's clear who runs it. */}
            <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", marginTop: 18 }}>
              <Text style={styles.label}>Members ({c?.members_users?.length || 0})</Text>
              {c?.is_admin && (
                <TouchableOpacity
                  testID="add-member"
                  onPress={() => { setSearchOpen(true); setSearchQ(""); setSearchResults([]); }}
                  style={styles.addMemberBtn}
                >
                  <Ionicons name="person-add" size={15} color={accent} />
                  <Text style={styles.addMemberText}>Add</Text>
                </TouchableOpacity>
              )}
            </View>
            {(!c?.members_users || c.members_users.length === 0) && (
              <Text style={{ color: COLORS.textMute }}>No members yet</Text>
            )}
            {c?.members_users?.map((m: any) => {
              const isSelf = m.id === user?.id;
              // Co-admins can only remove regular members; the owner can act on
              // anyone except themselves. The owner row never shows actions.
              const canRemove = c?.is_admin && !isSelf && !m.is_owner && (c?.is_owner || !m.is_admin);
              return (
                <View key={m.id} style={styles.memberRow}>
                  <Image source={getTopDownImage(m.car_color || "")} style={styles.memberCarAvatar} resizeMode="contain" />
                  <View style={{ flex: 1 }}>
                    <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
                      <Text style={styles.pendingName}>{m.handle || "anon"}{isSelf ? " (you)" : ""}</Text>
                      {m.is_owner ? (
                        <View style={[styles.adminBadge, { backgroundColor: accent + "22" }]}>
                          <Text style={[styles.adminBadgeText, { color: accent }]}>OWNER</Text>
                        </View>
                      ) : m.is_admin ? (
                        <View style={styles.adminBadge}>
                          <Text style={styles.adminBadgeText}>ADMIN</Text>
                        </View>
                      ) : null}
                    </View>
                    {(m.car_make || m.car_model || m.car_color) ? (
                      <Text style={[styles.commMeta, { fontSize: 11 }]} numberOfLines={1}>
                        {[m.car_color, m.car_make, m.car_model].filter(Boolean).join(" ")}
                      </Text>
                    ) : null}
                  </View>
                  {/* Owner-only: promote/demote co-admin (max 2) + hand over ownership. */}
                  {c?.is_owner && !isSelf && !m.is_owner && (
                    <>
                      <TouchableOpacity onPress={() => toggleAdmin(m)} hitSlop={8} style={styles.memberAction} testID={`toggle-admin-${m.id}`}>
                        <Ionicons name={m.is_admin ? "star" : "star-outline"} size={18} color={accent} />
                      </TouchableOpacity>
                      <TouchableOpacity onPress={() => transfer(m)} hitSlop={8} style={styles.memberAction} testID={`transfer-${m.id}`}>
                        <Ionicons name="ribbon-outline" size={18} color={accent} />
                      </TouchableOpacity>
                    </>
                  )}
                  {canRemove && (
                    <TouchableOpacity onPress={() => removeMember(m)} hitSlop={8} style={styles.memberAction} testID={`remove-member-${m.id}`}>
                      <Ionicons name="person-remove-outline" size={18} color={COLORS.danger} />
                    </TouchableOpacity>
                  )}
                </View>
              );
            })}
            {c?.is_owner && (
              <Text style={styles.adminHint}>★ make/remove admin (max 2) · 🎀 hand over ownership · remove member</Text>
            )}

            {c?.is_admin && (
              <>
                <Text style={[styles.label, { marginTop: 18 }]}>Invite code</Text>
                <View style={styles.inviteBox}>
                  <Text testID="invite-code" style={styles.inviteCode}>{c.invite_code}</Text>
                  <TouchableOpacity testID="share-invite" onPress={shareInvite} style={styles.smallBtn}>
                    <Ionicons name="share-outline" size={16} color="#fff" />
                    <Text style={[styles.smallBtnText, { marginLeft: 6 }]}>Share</Text>
                  </TouchableOpacity>
                </View>

                <Text style={[styles.label, { marginTop: 18 }]}>Pending requests ({c?.pending_users?.length || 0})</Text>
                {(!c?.pending_users || c.pending_users.length === 0) && <Text style={{ color: COLORS.textMute }}>No pending requests</Text>}
                {c?.pending_users?.map((u: any) => (
                  <View key={u.id} style={styles.memberRow}>
                    <Image source={getTopDownImage(u.car_color || "")} style={styles.memberCarAvatar} resizeMode="contain" />
                    <Text style={styles.pendingName}>{u.handle || u.email}</Text>
                    <TouchableOpacity testID={`approve-${u.id}`} onPress={() => approve(u.id)} style={[styles.smallBtn, { backgroundColor: COLORS.success }]}>
                      <Text style={styles.smallBtnText}>Approve</Text>
                    </TouchableOpacity>
                    <TouchableOpacity testID={`reject-${u.id}`} onPress={() => reject(u.id)} style={[styles.smallBtn, { backgroundColor: "rgba(118,118,128,0.4)" }]}>
                      <Text style={styles.smallBtnText}>Reject</Text>
                    </TouchableOpacity>
                  </View>
                ))}

                <TouchableOpacity testID="delete-community" onPress={remove} style={styles.dangerBtn}>
                  <Ionicons name="trash" size={16} color={COLORS.danger} />
                  <Text style={styles.dangerText}>Delete club</Text>
                </TouchableOpacity>
              </>
            )}

            {c && !c.is_admin && c.is_member && (
              <TouchableOpacity testID="leave-community" onPress={leave} style={[styles.dangerBtn, { marginTop: 18 }]}>
                <Ionicons name="exit" size={16} color={COLORS.danger} />
                <Text style={styles.dangerText}>Leave club</Text>
              </TouchableOpacity>
            )}
          </ScrollView>
        </View>
      </View>
    </Modal>

    {/* Add-member search — find anyone on Convoy by handle/email and add them. */}
    <Modal visible={searchOpen} animationType="slide" transparent onRequestClose={() => setSearchOpen(false)}>
      <View style={styles.modalRoot}>
        <View style={[styles.sheet, { maxHeight: "80%" }]}>
          <View style={styles.sheetHeader}>
            <Text style={styles.sheetTitle}>Add member</Text>
            <TouchableOpacity onPress={() => setSearchOpen(false)}><Ionicons name="close" size={22} color={COLORS.textDim} /></TouchableOpacity>
          </View>
          <TextInput
            testID="member-search-input"
            value={searchQ}
            onChangeText={doSearch}
            placeholder="Search Hairpin by handle or email"
            placeholderTextColor={COLORS.textMute}
            autoCapitalize="none"
            autoCorrect={false}
            style={[styles.input, { marginTop: 0 }]}
          />
          <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={{ paddingBottom: 24 }}>
            {searchResults.map((r: any) => {
              const already = memberIds.includes(r.id);
              return (
                <View key={r.id} style={styles.memberRow}>
                  <Image source={getTopDownImage(r.car_color || "")} style={styles.memberCarAvatar} resizeMode="contain" />
                  <View style={{ flex: 1 }}>
                    <Text style={styles.pendingName}>{r.handle || "anon"}</Text>
                    {(r.car_make || r.car_model || r.car_color) ? (
                      <Text style={[styles.commMeta, { fontSize: 11 }]} numberOfLines={1}>
                        {[r.car_color, r.car_make, r.car_model].filter(Boolean).join(" ")}
                      </Text>
                    ) : null}
                  </View>
                  {already ? (
                    <Text style={{ color: COLORS.textMute, fontSize: 12 }}>Member</Text>
                  ) : (
                    <TouchableOpacity testID={`add-${r.id}`} onPress={() => addMember(r.id)} style={[styles.smallBtn, { backgroundColor: COLORS.success }]}>
                      <Text style={styles.smallBtnText}>Add</Text>
                    </TouchableOpacity>
                  )}
                </View>
              );
            })}
            {searchQ.trim().length >= 2 && searchResults.length === 0 && (
              <Text style={{ color: COLORS.textMute, marginTop: 16, textAlign: "center" }}>No matches</Text>
            )}
            {searchQ.trim().length < 2 && (
              <Text style={{ color: COLORS.textMute, marginTop: 16, textAlign: "center" }}>Type at least 2 characters.</Text>
            )}
          </ScrollView>
        </View>
      </View>
    </Modal>
    </>
  );
}

function ProfileModal({ visible, onClose, onSaved, onSignOut }: any) {
  const { user } = useAuth();
  const skinColors = useAppSkinColors();
  const [handle, setHandle] = useState(user?.handle || "");
  const [make, setMake] = useState(user?.car_make || "");
  const [model, setModel] = useState(user?.car_model || "");
  const [year, setYear] = useState(user?.car_year ? String(user.car_year) : "");
  const [color, setColor] = useState(user?.car_color || "");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!visible) return;
    setHandle(user?.handle || ""); setMake(user?.car_make || ""); setModel(user?.car_model || "");
    setYear(user?.car_year ? String(user.car_year) : ""); setColor(user?.car_color || "");
  }, [visible, user]);

  const save = async () => {
    try {
      setBusy(true);
      await api.put("/auth/profile", { handle, car_make: make, car_model: model, car_year: year ? parseInt(year, 10) : null, car_color: color });
      onSaved();
    } catch (e) { Alert.alert("Save failed", formatErr(e)); }
    finally { setBusy(false); }
  };

  return (
    <Modal visible={visible} animationType="slide" transparent onRequestClose={onClose}>
      <KeyboardAvoidingView style={styles.modalRoot} behavior={Platform.OS === "ios" ? "padding" : undefined}>
        <View style={styles.sheet}>
          <View style={styles.sheetHeader}>
            <Text style={styles.sheetTitle}>Your profile</Text>
            <TouchableOpacity onPress={onClose}><Ionicons name="close" size={22} color={COLORS.textDim} /></TouchableOpacity>
          </View>
          <ScrollView contentContainerStyle={{ paddingBottom: 20 }}>
            <ProfileField testID="profile-handle" label="Handle" value={handle} onChange={setHandle} />
            <ProfileField testID="profile-make" label="Make" value={make} onChange={setMake} />
            <ProfileField testID="profile-model" label="Model" value={model} onChange={setModel} />
            <ProfileField testID="profile-year" label="Year" value={year} onChange={setYear} keyboard="number-pad" />
            <ProfileField testID="profile-color" label="Color" value={color} onChange={setColor} />
            <TouchableOpacity testID="profile-save" onPress={save} disabled={busy} style={styles.btn} activeOpacity={0.85}>
              <LinearGradient colors={skinColors.colors as any} locations={skinColors.locations as any} style={styles.btnGrad}>
                <Text style={styles.btnText}>{busy ? "Saving…" : "Save"}</Text>
              </LinearGradient>
            </TouchableOpacity>
            {/* SIGN OUT lives here now. It used to be a full-width saturated red
                button in the middle of the Hub — the most destructive action given
                the most visual weight, and the ONLY colour on an empty tab. */}
            <TouchableOpacity testID="logout-btn" onPress={onSignOut} activeOpacity={0.8} style={styles.signOutRow}>
              <Ionicons name="log-out-outline" size={17} color={COLORS.danger} />
              <Text style={styles.signOutTxt}>Sign out</Text>
            </TouchableOpacity>
          </ScrollView>
        </View>
      </KeyboardAvoidingView>
    </Modal>
  );
}

function ProfileField({ label, value, onChange, keyboard, testID }: any) {
  return (
    <>
      <Text style={styles.label}>{label}</Text>
      <TextInput testID={testID} value={value} onChangeText={onChange} keyboardType={keyboard || "default"} style={styles.input} placeholderTextColor={COLORS.textMute} />
    </>
  );
}

const styles = StyleSheet.create({
  // ── Club redesign (2026-08-28) ──
  sheetBackdrop: { flex: 1, backgroundColor: "rgba(0,0,0,0.6)", justifyContent: "flex-end", paddingBottom: 40, paddingHorizontal: 18 },
  createSheet: { backgroundColor: "#141416", borderRadius: 20, borderWidth: StyleSheet.hairlineWidth, borderColor: "rgba(255,255,255,0.12)", overflow: "hidden" },
  driverBand: { flexDirection: "row", alignItems: "center", gap: 12, paddingVertical: 10, marginBottom: 14 },
  driverCar: { width: 52, height: 40 },
  driverName: { color: "#fff", fontSize: 19, fontWeight: "800" },
  driverCarTxt: { fontSize: 12.5, fontWeight: "600", marginTop: 1 },
  sectionLabel: { color: "#7A7A7E", fontSize: 11, fontWeight: "700", letterSpacing: 1.1, marginBottom: 10, marginTop: 4 },
  clubRail: { gap: 14, paddingBottom: 20, paddingRight: 18 },
  railItem: { alignItems: "center", width: 66 },
  railCrest: { width: 56, height: 56, borderRadius: 18, alignItems: "center", justifyContent: "center", borderWidth: 2, borderColor: "transparent", backgroundColor: "rgba(255,255,255,0.07)", overflow: "hidden" },
  railCrestDashed: { borderColor: "rgba(255,255,255,0.18)", borderStyle: "dashed" },
  railLogo: { width: 52, height: 52, borderRadius: 16 },
  railName: { color: "#EDEDED", fontSize: 11, fontWeight: "700", marginTop: 6 },
  railMeta: { color: "#7A7A7E", fontSize: 10 },
  chipRail: { gap: 8, paddingBottom: 14, paddingRight: 18 },
  chip: { paddingHorizontal: 15, paddingVertical: 9, borderRadius: 999, borderWidth: 1, borderColor: "rgba(255,255,255,0.12)", backgroundColor: "rgba(255,255,255,0.06)" },
  chipTxt: { color: "#C7C7CC", fontSize: 13.5, fontWeight: "600" },
  fab: { position: "absolute", right: 18, bottom: 96, width: 58, height: 58, borderRadius: 29, overflow: "hidden", alignItems: "center", justifyContent: "center",
    ...Platform.select({ ios: { shadowColor: "#000", shadowOpacity: 0.5, shadowRadius: 12, shadowOffset: { width: 0, height: 6 } }, android: { elevation: 8 } }) },
  heroCard: { height: 196, borderRadius: 22, overflow: "hidden", justifyContent: "flex-end", marginBottom: 20 },
  heroCountdown: { position: "absolute", top: 12, left: 12, paddingHorizontal: 10, paddingVertical: 5, borderRadius: 8 },
  heroCountdownTxt: { fontSize: 11, fontWeight: "900", letterSpacing: 0.5 },
  heroFoot: { padding: 14 },
  heroTitle: { color: "#fff", fontSize: 21, fontWeight: "800" },
  heroSub: { color: "#C7C7CC", fontSize: 12.5, marginTop: 2 },
  heroRow: { flexDirection: "row", alignItems: "center", gap: 10, marginTop: 12 },
  heroGoing: { color: "#C7C7CC", fontSize: 12, fontWeight: "600" },
  heroCta: { paddingHorizontal: 18, paddingVertical: 10, borderRadius: 999 },
  heroCtaTxt: { fontSize: 14, fontWeight: "800" },
  sheetList: { backgroundColor: "rgba(20,20,22,0.92)", borderRadius: 20, borderWidth: StyleSheet.hairlineWidth, borderColor: "rgba(255,255,255,0.1)", overflow: "hidden", marginBottom: 22 },
  feedRow: { flexDirection: "row", alignItems: "center", gap: 12, paddingHorizontal: 14, paddingVertical: 13 },
  feedGlyph: { width: 42, height: 42, borderRadius: 13, backgroundColor: "rgba(255,255,255,0.06)", alignItems: "center", justifyContent: "center" },
  feedTitle: { color: "#fff", fontSize: 15, fontWeight: "700" },
  feedSub: { color: "#8A8A8E", fontSize: 12, marginTop: 2 },
  goingPill: { paddingHorizontal: 9, paddingVertical: 4, borderRadius: 7, borderWidth: StyleSheet.hairlineWidth },
  goingTxt: { fontSize: 10, fontWeight: "900", letterSpacing: 0.4 },
  countWell: { minWidth: 30, height: 26, borderRadius: 8, backgroundColor: "rgba(255,255,255,0.07)", alignItems: "center", justifyContent: "center", paddingHorizontal: 7 },
  countTxt: { color: "#C7C7CC", fontSize: 12, fontWeight: "700" },
  feedEmpty: { color: "#8A8A8E", fontSize: 13, textAlign: "center", paddingVertical: 26, paddingHorizontal: 20 },
  standRow: { flexDirection: "row", alignItems: "center", gap: 12, paddingHorizontal: 14, paddingVertical: 11 },
  standRank: { width: 24, height: 24, borderRadius: 8, alignItems: "center", justifyContent: "center" },
  standRankTxt: { fontSize: 12, fontWeight: "800" },
  standCar: { width: 40, height: 30 },
  standName: { flex: 1, color: "#fff", fontSize: 15, fontWeight: "700" },
  standVal: { fontSize: 17, fontWeight: "800" },
  standUnit: { fontSize: 10, color: "#8A8A8E", fontWeight: "600" },
  standToggle: { flexDirection: "row", gap: 6, marginBottom: 10 },
  standTog: { paddingHorizontal: 12, paddingVertical: 6, borderRadius: 999, borderWidth: 1, borderColor: "rgba(255,255,255,0.12)" },
  standTogTxt: { fontSize: 12, fontWeight: "700", color: "#C7C7CC" },
  createSheetRow: { flexDirection: "row", alignItems: "center", gap: 14, paddingVertical: 16, paddingHorizontal: 18 },
  createSheetTxt: { color: "#fff", fontSize: 16, fontWeight: "700" },
  signOutRow: { flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 8, paddingVertical: 16, marginTop: 8, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: "rgba(255,255,255,0.10)" },
  signOutTxt: { color: COLORS.danger, fontSize: 15, fontWeight: "700" },
  c: { flex: 1, backgroundColor: COLORS.bg },
  headerRow: { flexDirection: "row", alignItems: "center", justifyContent: "space-between" },
  title: { color: COLORS.text, fontSize: 34, fontWeight: "700", letterSpacing: -1 },
  sub: { color: COLORS.text, marginTop: 2, fontSize: 13 },
  iconBtn: { width: 38, height: 38, borderRadius: 19, backgroundColor: "rgba(118,118,128,0.24)", alignItems: "center", justifyContent: "center" },
  logoBacking: {
    // Identical to the map's logo button (mapLogoBacking) so it never jumps between tabs.
    position: 'absolute', top: Platform.OS === 'ios' ? 52 : 28, right: 12, zIndex: 100,
    width: 50,
    height: 50,
    borderRadius: 14,
    overflow: 'hidden',
    alignItems: 'center', justifyContent: 'center',
    backgroundColor: 'rgba(20,20,22,0.9)',
    borderWidth: 1, borderColor: 'rgba(255,255,255,0.18)',
    shadowColor: '#000', shadowOpacity: 0.35, shadowRadius: 5, shadowOffset: { width: 0, height: 2 },
    elevation: 6,
  },


  section: { color: COLORS.textDim, marginTop: 24, marginBottom: 10, fontSize: 13, fontWeight: "500" },
  sectionRow: { flexDirection: "row", alignItems: "center", gap: 10, marginTop: 24, marginBottom: 10 },
  userHero: { width: 30, height: 30, borderRadius: 15, borderWidth: 1, borderColor: "rgba(255,255,255,0.18)", backgroundColor: "#000" },
  emptyHero: { width: 72, height: 72, borderRadius: 16, marginBottom: 8, borderWidth: 1, borderColor: "rgba(255,255,255,0.12)", backgroundColor: "#000" },
  emptyTitle: { color: COLORS.text, fontWeight: "600", fontSize: 17, marginTop: 10 },
  emptyText: { color: COLORS.text, textAlign: "center", marginTop: 6, fontSize: 13 },

  commCard: { flexDirection: "row", alignItems: "center", padding: 12, gap: 12 },
  commIcon: { width: 44, height: 44, borderRadius: 14, backgroundColor: "rgba(255,255,255,0.10)", alignItems: "center", justifyContent: "center" },
  commLogo: { width: 44, height: 44, borderRadius: 14 },
  commName: { color: COLORS.text, fontWeight: "600", fontSize: 16 },
  commMeta: { color: COLORS.text, fontSize: 12, marginTop: 2 },
  // Feature pills row inside the community card
  featurePills: { flexDirection: "row", gap: 4, marginTop: 6 },
  featurePill: {
    width: 22, height: 22, borderRadius: 7,
    alignItems: "center", justifyContent: "center",
  },
  adminBadge: { backgroundColor: COLORS.warning + "33", paddingHorizontal: 6, paddingVertical: 2, borderRadius: 6 },
  adminBadgeText: { color: COLORS.warning, fontSize: 9, fontWeight: "700", letterSpacing: 0.5 },
  addMemberBtn: { flexDirection: "row", alignItems: "center", gap: 5, paddingHorizontal: 10, paddingVertical: 5, borderRadius: 8, backgroundColor: "rgba(255,255,255,0.06)", borderWidth: StyleSheet.hairlineWidth, borderColor: "rgba(255,255,255,0.14)" },
  addMemberText: { color: COLORS.text, fontSize: 12, fontWeight: "700" },
  memberAction: { paddingHorizontal: 6, paddingVertical: 4 },
  adminHint: { color: COLORS.textMute, fontSize: 10, marginTop: 8, lineHeight: 14 },
  activeBadge: { backgroundColor: COLORS.success + "33", paddingHorizontal: 6, paddingVertical: 2, borderRadius: 6 },
  activeBadgeText: { color: COLORS.success, fontSize: 9, fontWeight: "700", letterSpacing: 0.5 },

  // Active-convoy toggle button inside the detail sheet.
  activeBtn: {
    flexDirection: "row", alignItems: "center", gap: 10,
    paddingVertical: 13, paddingHorizontal: 14, borderRadius: 14,
    backgroundColor: "rgba(45,236,134,0.12)",
    borderWidth: 1, borderColor: "rgba(45,236,134,0.4)",
    marginBottom: 14,
  },
  activeBtnOn: { backgroundColor: "rgba(255,255,255,0.10)", borderColor: "rgba(255,255,255,0.24)" },
  activeBtnText: { flex: 1, color: COLORS.text, fontWeight: "700", fontSize: 14 },

  // Admin identity editor (logo + name) at the top of the detail sheet.
  adminIdentity: { flexDirection: "row", alignItems: "center", gap: 14, marginBottom: 14 },
  adminLogoWrap: { width: 60, height: 60 },
  adminLogo: { width: 60, height: 60, borderRadius: 16 },
  adminLogoPlaceholder: {
    width: 60, height: 60, borderRadius: 16,
    backgroundColor: "rgba(118,118,128,0.2)",
    alignItems: "center", justifyContent: "center",
    borderWidth: 1, borderColor: COLORS.hairline, borderStyle: "dashed",
  },
  adminLogoEditBadge: {
    position: "absolute", right: -4, bottom: -4,
    width: 22, height: 22, borderRadius: 11,
    backgroundColor: "rgba(255,255,255,0.12)",
    alignItems: "center", justifyContent: "center",
    borderWidth: 2, borderColor: "#1A1A1C",
  },
  adminIdentityName: { color: COLORS.text, fontSize: 18, fontWeight: "700", letterSpacing: -0.3 },
  adminIdentityHint: { color: COLORS.textDim, fontSize: 11, marginTop: 3 },

  logoutBtn: { flexDirection: "row", justifyContent: "center", alignItems: "center", gap: 8, marginTop: 32, padding: 14, borderRadius: 14, overflow: "hidden", backgroundColor: "transparent", borderWidth: 1, borderColor: "rgba(255,90,120,0.9)" },
  logoutText: { color: "#fff", fontWeight: "700", fontSize: 15 },

  modalRoot: { flex: 1, backgroundColor: "rgba(0,0,0,0.5)", justifyContent: "flex-end" },
  sheet: { backgroundColor: "#1A1A1C", borderTopLeftRadius: 22, borderTopRightRadius: 22, padding: 20, maxHeight: "92%" },
  sheetHeader: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", marginBottom: 12 },
  sheetTitle: { color: COLORS.text, fontSize: 20, fontWeight: "700", letterSpacing: -0.4 },

  label: { color: COLORS.textDim, fontSize: 13, marginTop: 12, marginBottom: 6, fontWeight: "500" },
  input: { backgroundColor: "rgba(118,118,128,0.18)", color: COLORS.text, paddingVertical: 12, paddingHorizontal: 14, borderRadius: 12, fontSize: 16 },

  toggleRow: { flexDirection: "row", alignItems: "center", marginTop: 18, gap: 12 },
  toggleBox: { width: 22, height: 22, borderRadius: 6, borderWidth: 2, borderColor: COLORS.hairlineStrong, alignItems: "center", justifyContent: "center" },
  // Logo picker (community avatar)
  logoPicker: { width: 96, height: 96, borderRadius: 48, overflow: "hidden", marginTop: 4, marginBottom: 6 },
  logoImg: { width: "100%", height: "100%" },
  logoPlaceholder: {
    width: "100%", height: "100%",
    backgroundColor: "rgba(118,118,128,0.18)",
    alignItems: "center", justifyContent: "center",
    borderWidth: 1, borderColor: COLORS.hairline, borderStyle: "dashed",
  },
  logoHint: { color: COLORS.textDim, fontSize: 11, marginTop: 4, fontWeight: "500" },
  // Feature toggle row (walkie / music / map)
  featureRow: {
    flexDirection: "row", alignItems: "center",
    paddingVertical: 12, gap: 12,
    borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: COLORS.hairline,
  },
  featureIco: {
    width: 36, height: 36, borderRadius: 10,
    alignItems: "center", justifyContent: "center",
  },
  featureTitle: { color: COLORS.text, fontSize: 15, fontWeight: "600", letterSpacing: -0.1 },
  featureSub: { color: COLORS.text, fontSize: 12, marginTop: 2, lineHeight: 16 },
  toggleTitle: { color: COLORS.text, fontWeight: "500", fontSize: 14 },
  toggleSub: { color: COLORS.text, fontSize: 12, marginTop: 2 },

  btn: { marginTop: 22, borderRadius: 14, overflow: "hidden" },
  btnGrad: { paddingVertical: 14, alignItems: "center" },
  btnText: { color: "#F4F4F4", fontWeight: "600", fontSize: 16 },

  smallBtn: { flexDirection: "row", paddingHorizontal: 14, paddingVertical: 10, borderRadius: 10, backgroundColor: "rgba(255,255,255,0.12)", alignItems: "center" },
  smallBtnText: { color: "#F4F4F4", fontWeight: "600", fontSize: 13 },

  statusBadge: { paddingHorizontal: 10, paddingVertical: 6, borderRadius: 8, backgroundColor: COLORS.success + "33" },
  statusText: { color: COLORS.success, fontSize: 12, fontWeight: "600" },

  detailDesc: { color: COLORS.text, fontSize: 14, marginTop: 6 },
  detailMeta: { color: COLORS.text, fontSize: 12, marginTop: 6 },
  inviteBox: { flexDirection: "row", alignItems: "center", padding: 14, borderRadius: 12, backgroundColor: "rgba(118,118,128,0.18)", gap: 12 },
  inviteCode: { flex: 1, color: COLORS.text, fontFamily: Platform.OS === "ios" ? "Menlo" : "monospace", fontSize: 15, fontWeight: "600", letterSpacing: 1 },

  pendingRow: { flexDirection: "row", alignItems: "center", padding: 10, borderRadius: 12, backgroundColor: "rgba(118,118,128,0.16)", marginTop: 8, gap: 8 },
  pendingAvatar: { width: 32, height: 32, borderRadius: 16, backgroundColor: COLORS.accent, alignItems: "center", justifyContent: "center" },
  // Roster row using the member's top-down CAR MARKER as their avatar (matches the map).
  memberRow: { flexDirection: "row", alignItems: "center", padding: 10, borderRadius: 14, backgroundColor: "rgba(255,255,255,0.05)", borderWidth: StyleSheet.hairlineWidth, borderColor: "rgba(255,255,255,0.08)", marginTop: 8, gap: 10 },
  memberCarAvatar: { width: 42, height: 42, borderRadius: 12, backgroundColor: "rgba(0,0,0,0.35)" },
  pendingName: { flex: 1, color: COLORS.text, fontWeight: "500" },

  dangerBtn: { flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 8, padding: 14, borderRadius: 14, borderWidth: 1, borderColor: "rgba(255,69,58,0.3)", marginTop: 18 },
  dangerText: { color: COLORS.danger, fontWeight: "600" },

  // ===== Velox-style club cards =====
  // Hub section selector (Clubs · Events · Cruises) — pill trio above everything.
  // (hubTab* — "section*" names were already taken by the detail modal's rows.)
  hubTabsRow: { flexDirection: "row", gap: 8, marginTop: 16, marginBottom: 16 },
  hubTabBtn: { flex: 1, flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 6, paddingVertical: 10, borderRadius: 14, backgroundColor: "rgba(255,255,255,0.07)", borderWidth: 1, borderColor: "rgba(255,255,255,0.10)" },
  hubTabBtnOn: { backgroundColor: "rgba(255,255,255,0.14)", borderColor: "rgba(255,255,255,0.28)" },
  hubTabText: { color: "#D9D9DE", fontWeight: "800", fontSize: 13.5 },
  hubTabTextOn: { color: "#0A1A10" },
  // Segment restyled to MATCH the Events/Cruises sections (hubEvents.tsx) so the
  // three Hub tabs read as one system. Sits first in the clubs section now (the
  // action grid is gone), so no top margin.
  segment: { flexDirection: "row", backgroundColor: "rgba(255,255,255,0.06)", borderRadius: 12, padding: 3, marginBottom: 12 },
  // Create-club row + Discover search + invite link (Events-section visual language).
  createClubRow: { flexDirection: "row", alignItems: "center", gap: 12, padding: 14 },
  createClubIcon: { width: 34, height: 34, borderRadius: 10, alignItems: "center", justifyContent: "center" },
  createClubText: { color: COLORS.text, fontWeight: "800", fontSize: 15.5 },
  clubSearchInput: { backgroundColor: "rgba(255,255,255,0.07)", borderRadius: 12, paddingHorizontal: 13, paddingVertical: 11, color: COLORS.text, fontSize: 15 },
  inviteLink: { flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 6, paddingVertical: 10, marginBottom: 4 },
  inviteLinkText: { color: COLORS.text, fontWeight: "700", fontSize: 13 },
  segmentBtn: { flex: 1, paddingVertical: 8, borderRadius: 10, alignItems: "center" },
  segmentBtnOn: { backgroundColor: "rgba(255,255,255,0.12)" },
  segmentText: { color: COLORS.textMute, fontWeight: "700", fontSize: 13.5 },
  segmentTextOn: { color: COLORS.text },

  clubCardInner: { borderRadius: 20, overflow: "hidden" },
  clubBanner: { width: "100%", height: 130, alignItems: "center", justifyContent: "center", backgroundColor: "#0F1512" },
  clubActivePill: { position: "absolute", top: 10, right: 10, flexDirection: "row", alignItems: "center", gap: 4, backgroundColor: "rgba(255,255,255,0.14)", paddingHorizontal: 8, paddingVertical: 3, borderRadius: 8 },
  clubActivePillText: { color: "#0A0A0A", fontSize: 9, fontWeight: "800", letterSpacing: 0.5 },
  clubBody: { padding: 14 },
  clubLogo: { width: 42, height: 42, borderRadius: 12, borderWidth: 1, borderColor: "rgba(255,255,255,0.15)" },
  clubLogoPlaceholder: { width: 42, height: 42, borderRadius: 12, backgroundColor: "rgba(255,255,255,0.10)", alignItems: "center", justifyContent: "center" },
  clubName: { color: COLORS.text, fontWeight: "700", fontSize: 17, letterSpacing: -0.3, flexShrink: 1 },
  // Club CONTENT text is white, not textDim (Jeff, 2026-07-25: "in the hub club
  // the fonts are grey"). #808080 at 12-13pt over the dark card was the least
  // readable copy in the app. Small FORM labels (`label`, `section`) stay dim —
  // those are chrome, and dimming them is what gives the content its hierarchy.
  clubMeta: { color: COLORS.text, fontSize: 12, fontWeight: "500" },
  // ── Club leaderboard ──
  boardHead: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", marginTop: 18 },
  boardToggle: { flexDirection: "row", backgroundColor: "rgba(118,118,128,0.20)", borderRadius: 999, padding: 2 },
  boardTab: { paddingHorizontal: 12, paddingVertical: 4, borderRadius: 999 },
  boardTabOn: { backgroundColor: "rgba(45,236,134,0.20)" },
  boardTabText: { color: COLORS.text, fontSize: 11.5, fontWeight: "600", opacity: 0.75 },
  boardTabTextOn: { color: "#2DEC86", opacity: 1 },
  boardRow: {
    flexDirection: "row", alignItems: "center", gap: 10,
    paddingVertical: 9, paddingHorizontal: 10, marginTop: 6, borderRadius: 10,
    backgroundColor: "rgba(255,255,255,0.05)",
  },
  boardRowMe: { borderWidth: StyleSheet.hairlineWidth, borderColor: "rgba(45,236,134,0.55)" },
  boardRank: { width: 18, color: COLORS.text, opacity: 0.6, fontSize: 12, fontWeight: "800" },
  boardRankTop: { color: "#2DEC86", opacity: 1 },
  boardHandle: { flex: 1, minWidth: 0, color: COLORS.text, fontSize: 13.5, fontWeight: "600" },
  boardDrives: { color: COLORS.text, opacity: 0.7, fontSize: 11.5, fontWeight: "600" },
  boardPb: { color: "#00C46A", fontSize: 11.5, fontWeight: "700" },
  boardKm: { color: "#2DEC86", fontSize: 13.5, fontWeight: "800", minWidth: 72, textAlign: "right" },
  clubDesc: { color: COLORS.text, fontSize: 13, lineHeight: 18, marginTop: 10 },
  clubTags: { flexDirection: "row", flexWrap: "wrap", gap: 7, marginTop: 12 },
  clubTag: { backgroundColor: "rgba(255,255,255,0.08)", borderRadius: 999, paddingHorizontal: 10, paddingVertical: 5 },
  clubTagText: { color: "#D8D8DC", fontSize: 11, fontWeight: "600" },

  joinBtn: { backgroundColor: "rgba(255,255,255,0.12)", paddingHorizontal: 16, paddingVertical: 8, borderRadius: 10 },
  joinBtnText: { color: "#06281A", fontWeight: "800", fontSize: 13 },
  joinedPill: { backgroundColor: COLORS.success + "33", paddingHorizontal: 12, paddingVertical: 7, borderRadius: 10 },
  joinedPillText: { color: COLORS.success, fontWeight: "700", fontSize: 12 },
  pendingPill: { backgroundColor: COLORS.warning + "33", paddingHorizontal: 12, paddingVertical: 7, borderRadius: 10 },
  pendingPillText: { color: COLORS.warning, fontWeight: "700", fontSize: 12 },

  // Create/edit: cover picker + tag chips
  bannerPicker: { width: "100%", height: 120, borderRadius: 16, overflow: "hidden", marginTop: 4, marginBottom: 8 },
  bannerImg: { width: "100%", height: "100%" },
  bannerPlaceholder: { flex: 1, backgroundColor: "rgba(118,118,128,0.18)", alignItems: "center", justifyContent: "center", borderWidth: 1, borderColor: COLORS.hairline, borderStyle: "dashed", borderRadius: 16 },
  tagWrap: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
  tagChip: { backgroundColor: "rgba(118,118,128,0.20)", borderRadius: 999, paddingHorizontal: 12, paddingVertical: 7, borderWidth: 1, borderColor: "transparent" },
  tagChipOn: { backgroundColor: "rgba(255,255,255,0.14)", borderColor: "rgba(255,255,255,0.28)" },
  tagChipText: { color: COLORS.text, fontSize: 12, fontWeight: "600" },
  tagChipTextOn: { color: COLORS.text },

  detailBannerEdit: { width: "100%", height: 120, borderRadius: 16, overflow: "hidden" },
  detailBannerImg: { width: "100%", height: "100%" },
  detailBannerPlaceholder: { flex: 1, backgroundColor: "rgba(118,118,128,0.18)", alignItems: "center", justifyContent: "center", borderWidth: 1, borderColor: COLORS.hairline, borderStyle: "dashed", borderRadius: 16 },
  detailBannerBadge: { position: "absolute", right: 8, bottom: 8, width: 24, height: 24, borderRadius: 12, backgroundColor: "rgba(255,255,255,0.14)", alignItems: "center", justifyContent: "center", borderWidth: 2, borderColor: "#1A1A1C" },
});
