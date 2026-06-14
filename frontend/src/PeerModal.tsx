import React, { useEffect, useState } from "react";
import { View, Text, StyleSheet, TouchableOpacity, Modal, Platform } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { BlurView } from "expo-blur";
import { Image } from "expo-image";
import { COLORS } from "./theme";
import { getVehiclePngOrDefault } from "./vehicleAssets";
import { api } from "./api";
import { getSettings } from "./settings";
import type { Peer } from "./ConvoyMap";

type Props = {
  peer: (Peer & { online_at?: string; heading?: number; topSpeed?: number }) | null;
  visible: boolean;
  onClose: () => void;
  myCoords?: { lat: number; lng: number } | null;
  // The hailing user's OWN personal-best cruise speed (km/h), shown on the YOHB
  // button as a flex when you fist-bump a peer. Live max-of(persisted, session).
  myTopSpeed?: number;
};

function haversineKm(a: { lat: number; lng: number }, b: { lat: number; lng: number }): number {
  const R = 6371;
  const toRad = (v: number) => (v * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);
  const x = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(x));
}
const lastSeen = (iso?: string) => {
  if (!iso) return "";
  const sec = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
  if (sec < 30) return "just now";
  if (sec < 60) return `${Math.round(sec)}s ago`;
  if (sec < 3600) return `${Math.round(sec / 60)}m ago`;
  return `${Math.round(sec / 3600)}h ago`;
};

export default function PeerModal({ peer, visible, onClose, myCoords, myTopSpeed }: Props) {
  // ===== Hail state =====
  //
  // Three phases:
  //   idle    — show "Hail <driver>" with radio icon
  //   sending — show "Hailing..." with spinner-ish ellipsis, disable taps
  //   sent    — show "Hailed! ✓" with checkmark for 3s, then re-enable
  //
  // Auto-reset when the modal is closed/reopened so a re-hail starts fresh.
  const [hailing, setHailing] = useState(false);
  const [hailSent, setHailSent] = useState(false);
  useEffect(() => {
    if (!visible) {
      setHailing(false);
      setHailSent(false);
    }
  }, [visible]);

  if (!peer) return null;
  const distKm = myCoords ? haversineKm(myCoords, { lat: peer.lat, lng: peer.lng }) : null;
  // Hail button content (icon+text) color: dark glyphs on the yellow idle/
  // sending state for contrast, white on the green "sent" state.
  const hailContent = hailSent ? "#fff" : "#1a1a1a";

  const hail = async () => {
    if (hailing || hailSent) return;
    setHailing(true);
    try {
      // Best-effort grab of the current convoy context — used by the backend
      // to enrich the push payload (not for the share-check; that lives on
      // the Mongo `communities` collection).
      const s = await Promise.resolve().then(() => getSettings()).catch(() => null as any);
      await api.post("/notifications/hail", {
        target_user_id: peer.user_id,
        community_id: s?.activeCommunityId ?? undefined,
      });
      setHailSent(true);
      // Auto-reset the confirmation after 3s so the user can hail again.
      setTimeout(() => setHailSent(false), 3000);
    } catch (e: any) {
      // 403 = "must share a community" — surface as inline state without
      // tearing the modal. Other errors are just logged.
      if (__DEV__) console.warn("Hail failed:", e?.response?.data || e);
    } finally {
      setHailing(false);
    }
  };

  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose}>
      <TouchableOpacity activeOpacity={1} style={styles.backdrop} onPress={onClose}>
        <TouchableOpacity activeOpacity={1} onPress={() => {}} style={styles.cardWrap}>
          <View style={styles.card}>
            {Platform.OS !== "web" ? (
              <BlurView tint="dark" intensity={70} style={StyleSheet.absoluteFill} />
            ) : (
              <View style={[StyleSheet.absoluteFill, { backgroundColor: "rgba(20,20,24,0.92)" }]} />
            )}
            <View style={styles.inner}>
              <View style={styles.header}>
                <View style={styles.avatar}>
                  <Image
                    source={getVehiclePngOrDefault(peer.activeColor ?? peer.carColor)}
                    style={styles.avatarImg}
                    contentFit="contain"
                  />
                </View>
                <View style={{ flex: 1 }}>
                  <Text style={styles.handle}>{peer.handle || "Driver"}</Text>
                  {!!peer.carType && <Text style={styles.car}>{peer.carType}</Text>}
                </View>
                <TouchableOpacity onPress={onClose} style={styles.closeBtn} testID="peer-modal-close">
                  <Ionicons name="close" size={20} color={COLORS.text} />
                </TouchableOpacity>
              </View>

              <View style={styles.metaRow}>
                {distKm != null && (
                  <View style={styles.metaCell}>
                    <Ionicons name="navigate" size={14} color={COLORS.brand} />
                    <Text style={styles.metaText}>
                      {distKm < 1 ? `${Math.round(distKm * 1000)} m` : `${distKm.toFixed(1)} km`}
                    </Text>
                  </View>
                )}
                {peer.online_at && (
                  <View style={styles.metaCell}>
                    <View style={styles.liveDot} />
                    <Text style={styles.metaText}>{lastSeen(peer.online_at)}</Text>
                  </View>
                )}
                {/* Personal-best top speed — ALWAYS shown on the YOHB hail card,
                    even when the peer hasn't broadcast a record yet (older build
                    or no speed clocked), so it never disappears. Placeholder "—"
                    keeps the chip in place until a real PB comes through. */}
                <View testID="peer-top-speed" style={[styles.metaCell, styles.metaCellAccent]}>
                  <Ionicons name="speedometer" size={14} color="#FFC700" />
                  <Text style={[styles.metaText, { color: "#FFC700" }]}>
                    {typeof peer.topSpeed === "number" && peer.topSpeed > 0
                      ? `PB ${Math.round(peer.topSpeed)} km/h`
                      : "PB —"}
                  </Text>
                </View>
              </View>

              <TouchableOpacity
                testID="peer-hail"
                onPress={hail}
                disabled={hailing || hailSent}
                style={[
                  styles.hailBtn,
                  hailSent && styles.hailBtnSent,
                  hailing && styles.hailBtnSending,
                ]}
                activeOpacity={0.85}
              >
                <Ionicons
                  name={hailSent ? "checkmark-circle" : "radio"}
                  size={20}
                  color={hailContent}
                />
                <View style={{ alignItems: "center" }}>
                  <Text style={[styles.hailText, { color: hailContent }]}>
                    {hailing
                      ? "YOHB… 👊"
                      : hailSent
                        ? `YOHB'd ${peer.handle || "driver"} 👊`
                        : `YOHB ${peer.handle || "driver"} 👊`}
                  </Text>
                  {/* Your PB — always visible on the hail button (never hidden). */}
                  <Text style={[styles.hailSubText, { color: hailContent }]}>
                    Your PB · {typeof myTopSpeed === "number" && myTopSpeed > 0 ? `${Math.round(myTopSpeed)} km/h` : "—"}
                  </Text>
                </View>
              </TouchableOpacity>
            </View>
          </View>
        </TouchableOpacity>
      </TouchableOpacity>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: { flex: 1, backgroundColor: "rgba(0,0,0,0.55)", justifyContent: "center", alignItems: "center", padding: 20 },
  cardWrap: { width: "100%", maxWidth: 380 },
  card: {
    borderRadius: 22, overflow: "hidden",
    borderWidth: StyleSheet.hairlineWidth, borderColor: "rgba(255,255,255,0.18)",
  },
  inner: { padding: 18 },
  header: { flexDirection: "row", alignItems: "center", gap: 12 },
  avatar: { width: 56, height: 56, borderRadius: 28, backgroundColor: "rgba(255,255,255,0.08)", alignItems: "center", justifyContent: "center", overflow: "hidden", borderWidth: 2, borderColor: "rgba(255,214,10,0.55)" },
  avatarImg: { width: 46, height: 46 },
  handle: { color: COLORS.text, fontSize: 18, fontWeight: "700", letterSpacing: -0.3 },
  car: { color: COLORS.textDim, fontSize: 13, marginTop: 2 },
  closeBtn: { width: 32, height: 32, borderRadius: 16, alignItems: "center", justifyContent: "center", backgroundColor: "rgba(255,255,255,0.10)" },
  metaRow: { flexDirection: "row", gap: 8, marginTop: 14, marginBottom: 14, flexWrap: "wrap" },
  metaCell: { flexDirection: "row", alignItems: "center", gap: 5, paddingHorizontal: 10, paddingVertical: 6, borderRadius: 10, backgroundColor: "rgba(255,255,255,0.06)" },
  metaCellAccent: { backgroundColor: "rgba(255,199,0,0.12)", borderWidth: StyleSheet.hairlineWidth, borderColor: "rgba(255,199,0,0.45)" },
  metaText: { color: COLORS.text, fontSize: 12, fontWeight: "600" },
  liveDot: { width: 7, height: 7, borderRadius: 4, backgroundColor: COLORS.success },
  hailBtn: { flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 8, backgroundColor: COLORS.brand, paddingVertical: 14, borderRadius: 14 },
  hailBtnSending: { opacity: 0.75 },
  hailBtnSent: { backgroundColor: COLORS.success },
  hailText: { color: "#fff", fontWeight: "700", fontSize: 15, letterSpacing: 0.2 },
  hailSubText: { fontWeight: "600", fontSize: 11, letterSpacing: 0.2, opacity: 0.85, marginTop: 1 },
});
