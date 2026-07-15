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
import { EventsSection } from "../../src/hubEvents";
import { getEvent } from "../../src/eventsApi";
import { api, formatErr } from "../../src/api";
import { COLORS } from "../../src/theme";
import Glass, { GlassFill } from "../../src/Glass";
import GlassBackdrop from "../../src/components/GlassBackdrop";
import LogoMenu from "../../src/components/LogoMenu";
import { getGarageImage, getTopDownImage } from "../../src/carImages";
import { useSettings, updateSettings } from "../../src/settings";

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
const SUGGESTED_TAGS = [
  "Just for Fun", "Meetup", "Weekend Runs", "Cars & Coffee", "Beginner-Friendly",
  "JDM", "Euro", "Domestic", "Trucks", "Track Days", "Show & Shine", "Cruises", "Organization",
];

export default function HubScreen() {
  const { user, logout, refresh } = useAuth();
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

  useEffect(() => { load(); }, [load]);
  useEffect(() => { if (tab === "explore" && explore.length === 0) loadExplore(); }, [tab, explore.length, loadExplore]);

  return (
    <>
    <SafeAreaView style={styles.c} edges={["top"]}>
      <GlassBackdrop source={require("../../assets/images/glass-bgt.png")} />
      <ScrollView contentContainerStyle={{ padding: 18, paddingBottom: 110 }}
        refreshControl={<RefreshControl refreshing={loading} onRefresh={load} tintColor={COLORS.primary} />}>
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
            <Text style={styles.title}>Hub</Text>
          </View>
        </View>
        <Text style={styles.sub}>{user?.handle} · {[user?.car_year, user?.car_make, user?.car_model].filter(Boolean).join(" ") || "Tap the car icon to set up your Garage"}</Text>

        {/* Hub section selector — Clubs · Events · Cruises (Hub P2) */}
        <View style={styles.hubTabsRow}>
          {([["clubs", "people", "Clubs"], ["events", "calendar", "Events"], ["cruises", "car-sport", "Cruises"]] as const).map(([key, icon, label]) => (
            <TouchableOpacity key={key} testID={`hub-section-${key}`} onPress={() => setSection(key)} style={[styles.hubTabBtn, section === key && styles.hubTabBtnOn]} activeOpacity={0.85}>
              <Ionicons name={icon as any} size={16} color={section === key ? "#0A1A10" : "#D9D9DE"} />
              <Text style={[styles.hubTabText, section === key && styles.hubTabTextOn]}>{label}</Text>
            </TouchableOpacity>
          ))}
        </View>

        {section === "events" && <EventsSection kind="event" openEventId={openEventId} />}
        {section === "cruises" && <EventsSection kind="cruise" openEventId={openEventId} />}

        {section === "clubs" && (<>
        {/* Action cards */}
        <View style={styles.actionGrid}>
          <ActionCard testID="open-garage" icon="car-sport" label="Garage" onPress={() => router.push("/(app)/garage")} />
          <ActionCard testID="create-community" icon="add-circle" label="Create" onPress={() => setShowCreate(true)} />
          <ActionCard testID="search-community" icon="search" label="Discover" onPress={() => setShowSearch(true)} />
        </View>

        {/* Explore / My Clubs segmented control (Velox-style) */}
        <View style={styles.segment}>
          <TouchableOpacity testID="tab-explore" onPress={() => setTab("explore")} style={[styles.segmentBtn, tab === "explore" && styles.segmentBtnOn]}>
            <Text style={[styles.segmentText, tab === "explore" && styles.segmentTextOn]}>Explore</Text>
          </TouchableOpacity>
          <TouchableOpacity testID="tab-mine" onPress={() => setTab("mine")} style={[styles.segmentBtn, tab === "mine" && styles.segmentBtnOn]}>
            <Text style={[styles.segmentText, tab === "mine" && styles.segmentTextOn]}>My Clubs</Text>
          </TouchableOpacity>
        </View>

        {tab === "mine" ? (
          <>
            {mine.length === 0 && (
              <Glass radius={20}>
                <View style={{ padding: 22, alignItems: "center" }}>
                  <Image source={heroImg} style={styles.emptyHero} resizeMode="cover" />
                  <Text style={styles.emptyTitle}>No clubs yet</Text>
                  <Text style={styles.emptyText}>Create your own crew, or tap Explore to find public clubs to join.</Text>
                </View>
              </Glass>
            )}
            {mine.map((c) => (
              <CommunityCard key={c.id} c={c} active={c.id === settings.activeCommunityId} onPress={() => setShowDetail(c)} />
            ))}
          </>
        ) : (
          <>
            {explore.length === 0 && !exploreLoading && (
              <Text style={styles.emptyText}>No public clubs found yet. Be the first — tap Create.</Text>
            )}
            {explore.map((c) => (
              <CommunityCard key={c.id} c={c} mode="explore" onJoin={joinCommunity} onPress={() => setShowDetail(c)} />
            ))}
          </>
        )}
        </>)}

        <TouchableOpacity testID="logout-btn" style={styles.logoutBtn} onPress={logout} activeOpacity={0.85}>
          {/* Candy-apple-red glossy fill (matches the nav Exit button): a red
              gradient base + red-tinted Liquid Glass on top, white content. */}
          <LinearGradient colors={["#FF3B5C", "#E4002B", "#B00020"]} locations={[0, 0.5, 1]} style={[StyleSheet.absoluteFill, { borderRadius: 14 }]} />
          <GlassFill tintColor="#E4002B" style={{ borderRadius: 14, overflow: "hidden" }} />
          <Ionicons name="log-out" size={18} color="#fff" />
          <Text style={styles.logoutText}>Sign out</Text>
        </TouchableOpacity>
      </ScrollView>

      {/* Modals */}
      <CreateModal visible={showCreate} onClose={() => setShowCreate(false)} onCreated={() => { setShowCreate(false); load(); }} />
      <SearchModal visible={showSearch} onClose={() => setShowSearch(false)} onChanged={load} />
      <ProfileModal visible={showProfile} onClose={() => setShowProfile(false)} onSaved={async () => { await refresh(); setShowProfile(false); }} />
      <CommunityDetailModal community={showDetail} onClose={() => setShowDetail(null)} onChanged={load} />
    </SafeAreaView>
    <View style={styles.logoBacking}><LogoMenu size={38} align="right" /></View>
    </>
  );
}

function ActionCard({ icon, label, onPress, testID }: any) {
  return (
    <TouchableOpacity testID={testID} onPress={onPress} style={styles.actionCard} activeOpacity={0.85}>
      <Glass radius={18} style={{ flex: 1 }}>
        <View style={{ padding: 18, alignItems: "center" }}>
          <View style={styles.actionIcon}>
            <LinearGradient colors={["#7DF0B0", "#2DEC86", "#00C46A"]} style={StyleSheet.absoluteFill} />
            <Ionicons name={icon} size={24} color="#fff" />
          </View>
          <Text style={styles.actionLabel}>{label}</Text>
        </View>
      </Glass>
    </TouchableOpacity>
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
  return (
    <TouchableOpacity testID={`community-${c.id}`} onPress={onPress} activeOpacity={0.9} style={{ marginBottom: 14 }}>
      <Glass radius={20}>
        <View style={styles.clubCardInner}>
          {/* Cover banner (falls back to a branded gradient when none is set) */}
          {c.banner_b64 ? (
            <Image source={{ uri: c.banner_b64 }} style={styles.clubBanner} resizeMode="cover" />
          ) : (
            <LinearGradient colors={["#0F2A22", "#12352A", "#0B0B0C"]} start={{ x: 0, y: 0 }} end={{ x: 1, y: 1 }} style={styles.clubBanner}>
              <Ionicons name="car-sport" size={40} color="rgba(45,236,134,0.35)" />
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
                <View style={styles.clubLogoPlaceholder}><Ionicons name="people" size={20} color={COLORS.primary} /></View>
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
                  <TouchableOpacity key={t} onPress={() => toggleTag(t)} style={[styles.tagChip, on && styles.tagChipOn]}>
                    <Text style={[styles.tagChipText, on && styles.tagChipTextOn]}>{t}</Text>
                  </TouchableOpacity>
                );
              })}
            </View>

            <TouchableOpacity testID="cc-public" onPress={() => setIsPublic((v) => !v)} style={styles.toggleRow}>
              <View style={[styles.toggleBox, isPublic && { backgroundColor: COLORS.primary, borderColor: COLORS.primary }]}>
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
              <LinearGradient colors={["#7DF0B0", "#2DEC86", "#00C46A"]} style={styles.btnGrad}>
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
        trackColor={{ false: "rgba(255,255,255,0.12)", true: "#2DEC86" }}
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
                style={[styles.activeBtn, isActive && styles.activeBtnOn]}
              >
                <Ionicons name={isActive ? "radio" : "radio-outline"} size={18} color={isActive ? "#0A0A0A" : COLORS.primary} />
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
                      <TouchableOpacity key={t} onPress={() => toggleTagSave(t)} style={[styles.tagChip, on && styles.tagChipOn]}>
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
                  <Ionicons name="person-add" size={15} color={COLORS.primary} />
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
                        <View style={[styles.adminBadge, { backgroundColor: "#2DEC8622" }]}>
                          <Text style={[styles.adminBadgeText, { color: "#2DEC86" }]}>OWNER</Text>
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
                        <Ionicons name={m.is_admin ? "star" : "star-outline"} size={18} color="#2DEC86" />
                      </TouchableOpacity>
                      <TouchableOpacity onPress={() => transfer(m)} hitSlop={8} style={styles.memberAction} testID={`transfer-${m.id}`}>
                        <Ionicons name="ribbon-outline" size={18} color={COLORS.primary} />
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

function ProfileModal({ visible, onClose, onSaved }: any) {
  const { user } = useAuth();
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
              <LinearGradient colors={[COLORS.primary, COLORS.primaryDim]} style={styles.btnGrad}>
                <Text style={styles.btnText}>{busy ? "Saving…" : "Save"}</Text>
              </LinearGradient>
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
  c: { flex: 1, backgroundColor: COLORS.bg },
  headerRow: { flexDirection: "row", alignItems: "center", justifyContent: "space-between" },
  title: { color: COLORS.text, fontSize: 34, fontWeight: "700", letterSpacing: -1 },
  sub: { color: COLORS.textDim, marginTop: 2, fontSize: 13 },
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

  actionGrid: { flexDirection: "row", gap: 10, marginTop: 18 },
  actionCard: { flex: 1 },
  actionIcon: { width: 56, height: 56, borderRadius: 18, alignItems: "center", justifyContent: "center", overflow: "hidden", marginBottom: 10 },
  actionLabel: { color: COLORS.text, fontWeight: "600", fontSize: 14 },

  section: { color: COLORS.textDim, marginTop: 24, marginBottom: 10, fontSize: 13, fontWeight: "500" },
  sectionRow: { flexDirection: "row", alignItems: "center", gap: 10, marginTop: 24, marginBottom: 10 },
  userHero: { width: 30, height: 30, borderRadius: 15, borderWidth: 1, borderColor: "rgba(255,255,255,0.18)", backgroundColor: "#000" },
  emptyHero: { width: 72, height: 72, borderRadius: 16, marginBottom: 8, borderWidth: 1, borderColor: "rgba(255,255,255,0.12)", backgroundColor: "#000" },
  emptyTitle: { color: COLORS.text, fontWeight: "600", fontSize: 17, marginTop: 10 },
  emptyText: { color: COLORS.textDim, textAlign: "center", marginTop: 6, fontSize: 13 },

  commCard: { flexDirection: "row", alignItems: "center", padding: 12, gap: 12 },
  commIcon: { width: 44, height: 44, borderRadius: 14, backgroundColor: COLORS.primary + "22", alignItems: "center", justifyContent: "center" },
  commLogo: { width: 44, height: 44, borderRadius: 14 },
  commName: { color: COLORS.text, fontWeight: "600", fontSize: 16 },
  commMeta: { color: COLORS.textDim, fontSize: 12, marginTop: 2 },
  // Feature pills row inside the community card
  featurePills: { flexDirection: "row", gap: 4, marginTop: 6 },
  featurePill: {
    width: 22, height: 22, borderRadius: 7,
    alignItems: "center", justifyContent: "center",
  },
  adminBadge: { backgroundColor: COLORS.warning + "33", paddingHorizontal: 6, paddingVertical: 2, borderRadius: 6 },
  adminBadgeText: { color: COLORS.warning, fontSize: 9, fontWeight: "700", letterSpacing: 0.5 },
  addMemberBtn: { flexDirection: "row", alignItems: "center", gap: 5, paddingHorizontal: 10, paddingVertical: 5, borderRadius: 8, backgroundColor: "rgba(255,255,255,0.06)", borderWidth: StyleSheet.hairlineWidth, borderColor: "rgba(255,255,255,0.14)" },
  addMemberText: { color: COLORS.primary, fontSize: 12, fontWeight: "700" },
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
  activeBtnOn: { backgroundColor: COLORS.primary, borderColor: COLORS.primary },
  activeBtnText: { flex: 1, color: COLORS.primary, fontWeight: "700", fontSize: 14 },

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
    backgroundColor: COLORS.primary,
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
  featureSub: { color: COLORS.textDim, fontSize: 12, marginTop: 2, lineHeight: 16 },
  toggleTitle: { color: COLORS.text, fontWeight: "500", fontSize: 14 },
  toggleSub: { color: COLORS.textDim, fontSize: 12, marginTop: 2 },

  btn: { marginTop: 22, borderRadius: 14, overflow: "hidden" },
  btnGrad: { paddingVertical: 14, alignItems: "center" },
  btnText: { color: "#F4F4F4", fontWeight: "600", fontSize: 16 },

  smallBtn: { flexDirection: "row", paddingHorizontal: 14, paddingVertical: 10, borderRadius: 10, backgroundColor: COLORS.primary, alignItems: "center" },
  smallBtnText: { color: "#F4F4F4", fontWeight: "600", fontSize: 13 },

  statusBadge: { paddingHorizontal: 10, paddingVertical: 6, borderRadius: 8, backgroundColor: COLORS.success + "33" },
  statusText: { color: COLORS.success, fontSize: 12, fontWeight: "600" },

  detailDesc: { color: COLORS.text, fontSize: 14, marginTop: 6 },
  detailMeta: { color: COLORS.textDim, fontSize: 12, marginTop: 6 },
  inviteBox: { flexDirection: "row", alignItems: "center", padding: 14, borderRadius: 12, backgroundColor: "rgba(118,118,128,0.18)", gap: 12 },
  inviteCode: { flex: 1, color: COLORS.primary, fontFamily: Platform.OS === "ios" ? "Menlo" : "monospace", fontSize: 15, fontWeight: "600", letterSpacing: 1 },

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
  hubTabBtnOn: { backgroundColor: COLORS.primary, borderColor: COLORS.primary },
  hubTabText: { color: "#D9D9DE", fontWeight: "800", fontSize: 13.5 },
  hubTabTextOn: { color: "#0A1A10" },
  segment: { flexDirection: "row", backgroundColor: "rgba(118,118,128,0.20)", borderRadius: 12, padding: 4, marginTop: 22, marginBottom: 14 },
  segmentBtn: { flex: 1, paddingVertical: 9, borderRadius: 9, alignItems: "center" },
  segmentBtnOn: { backgroundColor: COLORS.primary },
  segmentText: { color: COLORS.textDim, fontWeight: "700", fontSize: 14 },
  segmentTextOn: { color: "#06281A" },

  clubCardInner: { borderRadius: 20, overflow: "hidden" },
  clubBanner: { width: "100%", height: 130, alignItems: "center", justifyContent: "center", backgroundColor: "#0F1512" },
  clubActivePill: { position: "absolute", top: 10, right: 10, flexDirection: "row", alignItems: "center", gap: 4, backgroundColor: COLORS.primary, paddingHorizontal: 8, paddingVertical: 3, borderRadius: 8 },
  clubActivePillText: { color: "#0A0A0A", fontSize: 9, fontWeight: "800", letterSpacing: 0.5 },
  clubBody: { padding: 14 },
  clubLogo: { width: 42, height: 42, borderRadius: 12, borderWidth: 1, borderColor: "rgba(255,255,255,0.15)" },
  clubLogoPlaceholder: { width: 42, height: 42, borderRadius: 12, backgroundColor: COLORS.primary + "22", alignItems: "center", justifyContent: "center" },
  clubName: { color: COLORS.text, fontWeight: "700", fontSize: 17, letterSpacing: -0.3, flexShrink: 1 },
  clubMeta: { color: COLORS.textDim, fontSize: 12, fontWeight: "500" },
  clubDesc: { color: COLORS.textDim, fontSize: 13, lineHeight: 18, marginTop: 10 },
  clubTags: { flexDirection: "row", flexWrap: "wrap", gap: 7, marginTop: 12 },
  clubTag: { backgroundColor: "rgba(255,255,255,0.08)", borderRadius: 999, paddingHorizontal: 10, paddingVertical: 5 },
  clubTagText: { color: "#D8D8DC", fontSize: 11, fontWeight: "600" },

  joinBtn: { backgroundColor: COLORS.primary, paddingHorizontal: 16, paddingVertical: 8, borderRadius: 10 },
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
  tagChipOn: { backgroundColor: "rgba(45,236,134,0.18)", borderColor: COLORS.primary },
  tagChipText: { color: COLORS.textDim, fontSize: 12, fontWeight: "600" },
  tagChipTextOn: { color: COLORS.primary },

  detailBannerEdit: { width: "100%", height: 120, borderRadius: 16, overflow: "hidden" },
  detailBannerImg: { width: "100%", height: "100%" },
  detailBannerPlaceholder: { flex: 1, backgroundColor: "rgba(118,118,128,0.18)", alignItems: "center", justifyContent: "center", borderWidth: 1, borderColor: COLORS.hairline, borderStyle: "dashed", borderRadius: 16 },
  detailBannerBadge: { position: "absolute", right: 8, bottom: 8, width: 24, height: 24, borderRadius: 12, backgroundColor: COLORS.primary, alignItems: "center", justifyContent: "center", borderWidth: 2, borderColor: "#1A1A1C" },
});
