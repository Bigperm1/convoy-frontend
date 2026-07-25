import React, { useEffect, useState } from "react";
import { View, Text, StyleSheet, TouchableOpacity, Modal, Platform, ScrollView } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { GlassFill } from "./Glass";
import { Image } from "expo-image";
import { COLORS } from "./theme";
import { getVehiclePngOrDefault } from "./vehicleAssets";
import { api } from "./api";
import { getSettings } from "./settings";
import type { Peer } from "./ConvoyMapbox";

// Who's-on roster, opened from the "N live" pill under the search bar (tester
// request 2026-07-16: "see who's on and choose if I want to talk to someone or
// drive to them"). One row per live convoy member with two actions:
//   👊 YOHB — the same hail push the PeerModal sends (per-row sent state)
//   Drive  — hand the peer to the map's drive-to flow (route drawer + Start)
type Props = {
  visible: boolean;
  onClose: () => void;
  peers: Peer[];
  myCoords?: { lat: number; lng: number } | null;
  onDriveTo: (p: Peer) => void;
};

function haversineKm(a: { lat: number; lng: number }, b: { lat: number; lng: number }): number {
  const R = 6371;
  const toRad = (v: number) => (v * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const x = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(x));
}
const fmtKm = (km: number) => (km < 1 ? `${Math.round(km * 1000)} m` : `${km.toFixed(1)} km`);

export default function LiveRosterSheet({ visible, onClose, peers, myCoords, onDriveTo }: Props) {
  // Per-row hail state: ids currently sending / already sent (sent auto-clears).
  const [hailing, setHailing] = useState<Set<string>>(new Set());
  const [hailed, setHailed] = useState<Set<string>>(new Set());
  useEffect(() => {
    if (!visible) { setHailing(new Set()); setHailed(new Set()); }
  }, [visible]);

  const hail = async (p: Peer) => {
    const id = p.user_id;
    if (!id || hailing.has(id) || hailed.has(id)) return;
    setHailing((s) => new Set(s).add(id));
    try {
      await api.post("/notifications/hail", {
        target_user_id: id,
        community_id: getSettings()?.activeCommunityId ?? undefined,
      });
      setHailed((s) => new Set(s).add(id));
      setTimeout(() => setHailed((s) => { const n = new Set(s); n.delete(id); return n; }), 3000);
    } catch {
      // Best-effort — a failed hail just re-enables the button.
    } finally {
      setHailing((s) => { const n = new Set(s); n.delete(id); return n; });
    }
  };

  // Nearest first — the person you most likely want to link up with.
  const sorted = [...peers].sort((a, b) => {
    if (!myCoords) return 0;
    return haversineKm(myCoords, a) - haversineKm(myCoords, b);
  });

  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      <TouchableOpacity activeOpacity={1} style={styles.backdrop} onPress={onClose}>
        <TouchableOpacity activeOpacity={1} onPress={() => {}} style={styles.sheetWrap}>
          <View style={styles.sheet}>
            {Platform.OS !== "web" ? (
              <GlassFill intensity={80} />
            ) : (
              <View style={[StyleSheet.absoluteFill, { backgroundColor: "rgba(20,20,24,0.94)" }]} />
            )}
            <View style={styles.inner}>
              <View style={styles.header}>
                <View style={styles.liveDot} />
                <Text style={styles.title}>{sorted.length ? `${sorted.length} live now` : "Nobody live"}</Text>
                <TouchableOpacity onPress={onClose} style={styles.closeBtn}>
                  <Ionicons name="close" size={20} color={COLORS.text} />
                </TouchableOpacity>
              </View>
              {sorted.length === 0 && (
                <Text style={styles.empty}>No convoy members are on the map right now.</Text>
              )}
              <ScrollView style={{ maxHeight: 380 }} showsVerticalScrollIndicator={false}>
                {sorted.map((p) => {
                  const id = p.user_id || `${p.lat},${p.lng}`;
                  const distKm = myCoords ? haversineKm(myCoords, p) : null;
                  const sent = !!p.user_id && hailed.has(p.user_id);
                  const busy = !!p.user_id && hailing.has(p.user_id);
                  return (
                    <View key={id} style={styles.row}>
                      <View style={styles.avatar}>
                        <Image
                          source={getVehiclePngOrDefault(p.activeColor ?? p.carColor)}
                          style={styles.avatarImg}
                          contentFit="contain"
                        />
                      </View>
                      <View style={{ flex: 1, minWidth: 0 }}>
                        <Text style={styles.handle} numberOfLines={1}>{p.handle || "Driver"}</Text>
                        <Text style={styles.sub} numberOfLines={1}>
                          {[p.carType, distKm != null ? fmtKm(distKm) : null, p.status === "parked" ? "parked" : null]
                            .filter(Boolean).join(" · ") || "on the map"}
                        </Text>
                      </View>
                      <TouchableOpacity
                        onPress={() => hail(p)}
                        disabled={busy || sent || !p.user_id}
                        style={[styles.actBtn, sent && styles.actBtnSent]}
                        activeOpacity={0.85}
                      >
                        <Ionicons name={sent ? "checkmark" : "radio"} size={16} color={sent ? "#fff" : "#1a1a1a"} />
                        <Text style={[styles.actText, { color: sent ? "#fff" : "#1a1a1a" }]}>
                          {sent ? "Sent" : busy ? "…" : "YOHB"}
                        </Text>
                      </TouchableOpacity>
                      <TouchableOpacity
                        onPress={() => onDriveTo(p)}
                        style={[styles.actBtn, styles.driveBtn]}
                        activeOpacity={0.85}
                      >
                        <Ionicons name="navigate" size={16} color={COLORS.brand} />
                        <Text style={[styles.actText, { color: COLORS.brand }]}>Drive</Text>
                      </TouchableOpacity>
                    </View>
                  );
                })}
              </ScrollView>
            </View>
          </View>
        </TouchableOpacity>
      </TouchableOpacity>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: { flex: 1, backgroundColor: "rgba(0,0,0,0.45)", justifyContent: "flex-end" },
  sheetWrap: { width: "100%" },
  sheet: {
    borderTopLeftRadius: 24, borderTopRightRadius: 24, overflow: "hidden",
    borderWidth: StyleSheet.hairlineWidth, borderColor: "rgba(255,255,255,0.18)",
  },
  inner: { padding: 18, paddingBottom: Platform.OS === "ios" ? 34 : 22 },
  header: { flexDirection: "row", alignItems: "center", gap: 8, marginBottom: 10 },
  liveDot: { width: 8, height: 8, borderRadius: 4, backgroundColor: COLORS.success },
  title: { flex: 1, color: COLORS.text, fontSize: 17, fontWeight: "700", letterSpacing: -0.3 },
  closeBtn: { width: 32, height: 32, borderRadius: 16, alignItems: "center", justifyContent: "center", backgroundColor: "rgba(255,255,255,0.10)" },
  empty: { color: COLORS.textDim, fontSize: 13, paddingVertical: 14 },
  row: { flexDirection: "row", alignItems: "center", gap: 10, paddingVertical: 10, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: "rgba(255,255,255,0.08)" },
  avatar: { width: 42, height: 42, borderRadius: 21, backgroundColor: "rgba(255,255,255,0.08)", alignItems: "center", justifyContent: "center", overflow: "hidden", borderWidth: 1.5, borderColor: "rgba(45,236,134,0.45)" },
  avatarImg: { width: 34, height: 34 },
  handle: { color: COLORS.text, fontSize: 15, fontWeight: "700", letterSpacing: -0.2 },
  // Car · distance · parked — WHITE, not textDim. This line is the reason the
  // roster exists (Jeff, 2026-07-25: the crew car info/distance read grey), and
  // #808080 at 12pt is the least legible thing on the sheet.
  sub: { color: COLORS.text, fontSize: 12, marginTop: 1 },
  actBtn: { flexDirection: "row", alignItems: "center", gap: 5, paddingHorizontal: 11, paddingVertical: 8, borderRadius: 999, backgroundColor: COLORS.brand },
  actBtnSent: { backgroundColor: COLORS.success },
  driveBtn: { backgroundColor: "rgba(45,236,134,0.12)", borderWidth: 1, borderColor: "rgba(45,236,134,0.55)" },
  actText: { fontSize: 12, fontWeight: "700", letterSpacing: 0.2 },
});
