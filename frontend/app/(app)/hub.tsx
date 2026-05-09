import React, { useEffect, useState, useCallback } from "react";
import {
  View, Text, StyleSheet, TouchableOpacity, ScrollView, TextInput,
  KeyboardAvoidingView, Platform, Alert, Modal, RefreshControl, Share, Image, Switch,
} from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { SafeAreaView } from "react-native-safe-area-context";
import { LinearGradient } from "expo-linear-gradient";
import * as ImagePicker from "expo-image-picker";
import { useRouter } from "expo-router";
import { useAuth } from "../../src/auth";
import { api, formatErr } from "../../src/api";
import { COLORS } from "../../src/theme";
import Glass from "../../src/Glass";

type Community = {
  id: string; name: string; description: string; member_count: number;
  pending_count: number; is_admin: boolean; is_member: boolean; is_pending: boolean;
  is_public: boolean; admin_handle?: string; invite_code?: string;
  logo_b64?: string | null;
  walkie_enabled?: boolean;
  music_enabled?: boolean;
  map_enabled?: boolean;
};

export default function HubScreen() {
  const { user, logout, refresh } = useAuth();
  const router = useRouter();
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

  useEffect(() => { load(); }, [load]);

  return (
    <SafeAreaView style={styles.c} edges={["top"]}>
      <ScrollView contentContainerStyle={{ padding: 18, paddingBottom: 110 }}
        refreshControl={<RefreshControl refreshing={loading} onRefresh={load} tintColor={COLORS.primary} />}>
        <View style={styles.headerRow}>
          <Text style={styles.title}>Hub</Text>
          <TouchableOpacity
            testID="profile-btn"
            onPress={() => router.push("/(app)/garage")}
            style={styles.iconBtn}
          >
            <Ionicons name="car-sport" size={18} color="#FFC700" />
          </TouchableOpacity>
        </View>
        <Text style={styles.sub}>{user?.handle} · {[user?.car_year, user?.car_make, user?.car_model].filter(Boolean).join(" ") || "Tap the car icon to set up your Garage"}</Text>

        {/* Action cards */}
        <View style={styles.actionGrid}>
          <ActionCard testID="open-garage" icon="car-sport" label="Garage" onPress={() => router.push("/(app)/garage")} />
          <ActionCard testID="create-community" icon="add-circle" label="Create" onPress={() => setShowCreate(true)} />
          <ActionCard testID="search-community" icon="search" label="Discover" onPress={() => setShowSearch(true)} />
        </View>

        <Text style={styles.section}>My communities</Text>
        {mine.length === 0 && (
          <Glass radius={20}>
            <View style={{ padding: 22, alignItems: "center" }}>
              <Image source={require("../../assets/images/brand-mark.png")} style={{ width: 64, height: 64, marginBottom: 4, opacity: 0.85 }} resizeMode="contain" />
              <Text style={styles.emptyTitle}>No communities yet</Text>
              <Text style={styles.emptyText}>Create your own crew or search public communities to join the convoy.</Text>
            </View>
          </Glass>
        )}
        {mine.map((c) => (
          <CommunityCard key={c.id} c={c} onPress={() => setShowDetail(c)} />
        ))}

        <TouchableOpacity testID="logout-btn" style={styles.logoutBtn} onPress={logout}>
          <Ionicons name="log-out" size={18} color={COLORS.danger} />
          <Text style={styles.logoutText}>Sign out</Text>
        </TouchableOpacity>
      </ScrollView>

      {/* Modals */}
      <CreateModal visible={showCreate} onClose={() => setShowCreate(false)} onCreated={() => { setShowCreate(false); load(); }} />
      <SearchModal visible={showSearch} onClose={() => setShowSearch(false)} onChanged={load} />
      <ProfileModal visible={showProfile} onClose={() => setShowProfile(false)} onSaved={async () => { await refresh(); setShowProfile(false); }} />
      <CommunityDetailModal community={showDetail} onClose={() => setShowDetail(null)} onChanged={load} />
    </SafeAreaView>
  );
}

function ActionCard({ icon, label, onPress, testID }: any) {
  return (
    <TouchableOpacity testID={testID} onPress={onPress} style={styles.actionCard} activeOpacity={0.85}>
      <Glass radius={18} style={{ flex: 1 }}>
        <View style={{ padding: 18, alignItems: "center" }}>
          <View style={styles.actionIcon}>
            <LinearGradient colors={[COLORS.primary, COLORS.accent]} style={StyleSheet.absoluteFill} />
            <Ionicons name={icon} size={24} color="#fff" />
          </View>
          <Text style={styles.actionLabel}>{label}</Text>
        </View>
      </Glass>
    </TouchableOpacity>
  );
}

function CommunityCard({ c, onPress }: { c: Community; onPress: () => void }) {
  // Tiny on-row indicators showing which sub-systems this community has enabled.
  const features = [
    { on: c.walkie_enabled !== false, icon: "flash", color: "#FF6A00" },
    { on: c.music_enabled !== false, icon: "musical-notes", color: "#FF453A" },
    { on: c.map_enabled !== false, icon: "map", color: "#0A84FF" },
  ];
  return (
    <TouchableOpacity testID={`community-${c.id}`} onPress={onPress} activeOpacity={0.85} style={{ marginBottom: 8 }}>
      <Glass radius={18}>
        <View style={styles.commCard}>
          {c.logo_b64 ? (
            <Image source={{ uri: c.logo_b64 }} style={styles.commLogo} />
          ) : (
            <View style={styles.commIcon}>
              <Ionicons name="people" size={22} color={COLORS.primary} />
            </View>
          )}
          <View style={{ flex: 1 }}>
            <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
              <Text style={styles.commName}>{c.name}</Text>
              {c.is_admin && <View style={styles.adminBadge}><Text style={styles.adminBadgeText}>ADMIN</Text></View>}
            </View>
            <Text style={styles.commMeta}>{c.member_count} members{c.pending_count > 0 && c.is_admin ? ` · ${c.pending_count} pending` : ""}</Text>
            {/* Feature pills — show only the ones that are ON to keep the row uncluttered */}
            <View style={styles.featurePills}>
              {features.filter((f) => f.on).map((f) => (
                <View key={f.icon} style={[styles.featurePill, { backgroundColor: f.color + "1F" }]}>
                  <Ionicons name={f.icon as any} size={11} color={f.color} />
                </View>
              ))}
            </View>
          </View>
          <Ionicons name="chevron-forward" size={20} color={COLORS.textDim} />
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
  const [busy, setBusy] = useState(false);

  const pickLogo = async () => {
    try {
      const perm = await ImagePicker.requestMediaLibraryPermissionsAsync();
      if (perm.status !== "granted") {
        return Alert.alert("Permission needed", "We need photo access to set a community logo.");
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

  const submit = async () => {
    if (!name.trim()) return Alert.alert("Name required");
    try {
      setBusy(true);
      await api.post("/communities", {
        name: name.trim(),
        description: desc,
        is_public: isPublic,
        logo_b64: logo,
        walkie_enabled: walkie,
        music_enabled: music,
        map_enabled: mapEnabled,
      });
      setName(""); setDesc(""); setLogo(null);
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
              <Text style={styles.sheetTitle}>Create community</Text>
              <TouchableOpacity onPress={onClose}><Ionicons name="close" size={22} color={COLORS.textDim} /></TouchableOpacity>
            </View>

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
            <TextInput testID="cc-desc" value={desc} onChangeText={setDesc} style={[styles.input, { height: 80 }]} multiline placeholder="What's this community about?" placeholderTextColor={COLORS.textMute} />

            <TouchableOpacity testID="cc-public" onPress={() => setIsPublic((v) => !v)} style={styles.toggleRow}>
              <View style={[styles.toggleBox, isPublic && { backgroundColor: COLORS.primary, borderColor: COLORS.primary }]}>
                {isPublic && <Ionicons name="checkmark" size={14} color="#fff" />}
              </View>
              <View style={{ flex: 1 }}>
                <Text style={styles.toggleTitle}>Public</Text>
                <Text style={styles.toggleSub}>Anyone can find this community and request to join</Text>
              </View>
            </TouchableOpacity>

            <Text style={[styles.label, { marginTop: 18 }]}>Connect features</Text>
            <FeatureToggle
              testID="cc-walkie"
              icon="flash" iconColor="#FF6A00"
              title="Walkie-Talkie Connect"
              sub="Enable push-to-talk channel for this community"
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
              <LinearGradient colors={["#FFE45C", "#FFC700", "#FF9F0A"]} style={styles.btnGrad}>
                <Text style={[styles.btnText, { color: "#1a1a1a" }]}>{busy ? "Creating…" : "Create community"}</Text>
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
        trackColor={{ false: "rgba(255,255,255,0.12)", true: "#FFC700" }}
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
      Alert.alert("Joined", "Welcome to the community");
    } catch (e) { Alert.alert("Failed", formatErr(e)); }
  };

  return (
    <Modal visible={visible} animationType="slide" transparent onRequestClose={onClose}>
      <View style={styles.modalRoot}>
        <View style={[styles.sheet, { maxHeight: "85%" }]}>
          <View style={styles.sheetHeader}>
            <Text style={styles.sheetTitle}>Discover communities</Text>
            <TouchableOpacity onPress={onClose}><Ionicons name="close" size={22} color={COLORS.textDim} /></TouchableOpacity>
          </View>

          <Text style={styles.label}>Have an invite code?</Text>
          <View style={{ flexDirection: "row", gap: 8 }}>
            <TextInput testID="search-code" value={code} onChangeText={setCode} style={[styles.input, { flex: 1 }]} placeholder="Paste code" placeholderTextColor={COLORS.textMute} autoCapitalize="none" />
            <TouchableOpacity testID="search-code-go" onPress={joinByCode} style={styles.smallBtn}>
              <Text style={styles.smallBtnText}>Join</Text>
            </TouchableOpacity>
          </View>

          <Text style={[styles.label, { marginTop: 16 }]}>Search public communities</Text>
          <TextInput testID="search-q" value={q} onChangeText={setQ} style={styles.input} placeholder="e.g. JDM, mountain, drift" placeholderTextColor={COLORS.textMute} autoCapitalize="none" />

          <ScrollView style={{ marginTop: 12 }} contentContainerStyle={{ paddingBottom: 30 }}>
            {results.length === 0 && <Text style={{ color: COLORS.textMute, textAlign: "center", marginTop: 12 }}>No communities found</Text>}
            {results.map((c) => (
              <View key={c.id} style={[styles.commCard, { marginBottom: 8, backgroundColor: "rgba(118,118,128,0.16)", borderRadius: 16 }]}>
                <View style={styles.commIcon}><Ionicons name="people" size={20} color={COLORS.primary} /></View>
                <View style={{ flex: 1 }}>
                  <Text style={styles.commName}>{c.name}</Text>
                  <Text style={styles.commMeta} numberOfLines={1}>{c.description || `Admin: ${c.admin_handle || "anon"}`}</Text>
                  <Text style={[styles.commMeta, { fontSize: 11, marginTop: 2 }]}>{c.member_count} members</Text>
                </View>
                {c.is_member ? (
                  <View style={styles.statusBadge}><Text style={styles.statusText}>Joined</Text></View>
                ) : c.is_pending ? (
                  <View style={[styles.statusBadge, { backgroundColor: COLORS.warning + "33" }]}><Text style={[styles.statusText, { color: COLORS.warning }]}>Pending</Text></View>
                ) : (
                  <TouchableOpacity testID={`request-${c.id}`} onPress={() => requestJoin(c)} style={styles.smallBtn}>
                    <Text style={styles.smallBtnText}>Request</Text>
                  </TouchableOpacity>
                )}
              </View>
            ))}
          </ScrollView>
        </View>
      </View>
    </Modal>
  );
}

function CommunityDetailModal({ community, onClose, onChanged }: any) {
  const [c, setC] = useState<any>(null);
  useEffect(() => {
    if (!community) { setC(null); return; }
    (async () => {
      try { const { data } = await api.get(`/communities/${community.id}`); setC(data); } catch {}
    })();
  }, [community]);

  const approve = async (uid: string) => {
    try { const { data } = await api.post(`/communities/${community.id}/approve/${uid}`); setC({ ...c, ...data, pending_users: c.pending_users.filter((u: any) => u.id !== uid) }); onChanged(); } catch (e) { Alert.alert("Failed", formatErr(e)); }
  };
  const reject = async (uid: string) => {
    try { const { data } = await api.post(`/communities/${community.id}/reject/${uid}`); setC({ ...c, ...data, pending_users: c.pending_users.filter((u: any) => u.id !== uid) }); onChanged(); } catch (e) { Alert.alert("Failed", formatErr(e)); }
  };
  const shareInvite = async () => {
    if (!c?.invite_code) return;
    try { await Share.share({ message: `Join my Convoy community "${c.name}". Use invite code: ${c.invite_code}` }); }
    catch {}
  };
  const leave = async () => {
    try { await api.post(`/communities/${community.id}/leave`); onChanged(); onClose(); }
    catch (e) { Alert.alert("Failed", formatErr(e)); }
  };
  const remove = async () => {
    Alert.alert("Delete community?", "This cannot be undone.", [
      { text: "Cancel", style: "cancel" },
      { text: "Delete", style: "destructive", onPress: async () => {
        try { await api.delete(`/communities/${community.id}`); onChanged(); onClose(); }
        catch (e) { Alert.alert("Failed", formatErr(e)); }
      }},
    ]);
  };

  return (
    <Modal visible={!!community} animationType="slide" transparent onRequestClose={onClose}>
      <View style={styles.modalRoot}>
        <View style={[styles.sheet, { maxHeight: "85%" }]}>
          <View style={styles.sheetHeader}>
            <Text style={styles.sheetTitle}>{c?.name || community?.name}</Text>
            <TouchableOpacity onPress={onClose}><Ionicons name="close" size={22} color={COLORS.textDim} /></TouchableOpacity>
          </View>
          <ScrollView contentContainerStyle={{ paddingBottom: 24 }}>
            <Text style={styles.detailDesc}>{c?.description || "No description"}</Text>
            <Text style={styles.detailMeta}>{c?.member_count} members · Admin: {c?.admin_handle}</Text>

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
                  <View key={u.id} style={styles.pendingRow}>
                    <View style={styles.pendingAvatar}><Ionicons name="person" size={16} color="#fff" /></View>
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
                  <Text style={styles.dangerText}>Delete community</Text>
                </TouchableOpacity>
              </>
            )}

            {c && !c.is_admin && c.is_member && (
              <TouchableOpacity testID="leave-community" onPress={leave} style={[styles.dangerBtn, { marginTop: 18 }]}>
                <Ionicons name="exit" size={16} color={COLORS.danger} />
                <Text style={styles.dangerText}>Leave community</Text>
              </TouchableOpacity>
            )}
          </ScrollView>
        </View>
      </View>
    </Modal>
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

  actionGrid: { flexDirection: "row", gap: 10, marginTop: 18 },
  actionCard: { flex: 1 },
  actionIcon: { width: 56, height: 56, borderRadius: 18, alignItems: "center", justifyContent: "center", overflow: "hidden", marginBottom: 10 },
  actionLabel: { color: COLORS.text, fontWeight: "600", fontSize: 14 },

  section: { color: COLORS.textDim, marginTop: 24, marginBottom: 10, fontSize: 13, fontWeight: "500" },
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

  logoutBtn: { flexDirection: "row", justifyContent: "center", alignItems: "center", gap: 8, marginTop: 32, padding: 14, borderRadius: 14, borderWidth: 1, borderColor: "rgba(255,69,58,0.3)" },
  logoutText: { color: COLORS.danger, fontWeight: "600", fontSize: 15 },

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
  btnText: { color: "#fff", fontWeight: "600", fontSize: 16 },

  smallBtn: { flexDirection: "row", paddingHorizontal: 14, paddingVertical: 10, borderRadius: 10, backgroundColor: COLORS.primary, alignItems: "center" },
  smallBtnText: { color: "#fff", fontWeight: "600", fontSize: 13 },

  statusBadge: { paddingHorizontal: 10, paddingVertical: 6, borderRadius: 8, backgroundColor: COLORS.success + "33" },
  statusText: { color: COLORS.success, fontSize: 12, fontWeight: "600" },

  detailDesc: { color: COLORS.text, fontSize: 14, marginTop: 6 },
  detailMeta: { color: COLORS.textDim, fontSize: 12, marginTop: 6 },
  inviteBox: { flexDirection: "row", alignItems: "center", padding: 14, borderRadius: 12, backgroundColor: "rgba(118,118,128,0.18)", gap: 12 },
  inviteCode: { flex: 1, color: COLORS.primary, fontFamily: Platform.OS === "ios" ? "Menlo" : "monospace", fontSize: 15, fontWeight: "600", letterSpacing: 1 },

  pendingRow: { flexDirection: "row", alignItems: "center", padding: 10, borderRadius: 12, backgroundColor: "rgba(118,118,128,0.16)", marginTop: 8, gap: 8 },
  pendingAvatar: { width: 32, height: 32, borderRadius: 16, backgroundColor: COLORS.accent, alignItems: "center", justifyContent: "center" },
  pendingName: { flex: 1, color: COLORS.text, fontWeight: "500" },

  dangerBtn: { flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 8, padding: 14, borderRadius: 14, borderWidth: 1, borderColor: "rgba(255,69,58,0.3)", marginTop: 18 },
  dangerText: { color: COLORS.danger, fontWeight: "600" },
});
