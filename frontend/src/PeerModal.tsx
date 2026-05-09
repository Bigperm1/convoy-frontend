import React from "react";
import { View, Text, StyleSheet, TouchableOpacity, Modal, Platform } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import * as Speech from "expo-speech";
import { BlurView } from "expo-blur";
import { COLORS } from "./theme";
import type { Peer } from "./ConvoyMap";

type Props = {
  peer: (Peer & { online_at?: string; heading?: number }) | null;
  visible: boolean;
  onClose: () => void;
  myCoords?: { lat: number; lng: number } | null;
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

export default function PeerModal({ peer, visible, onClose, myCoords }: Props) {
  if (!peer) return null;
  const distKm = myCoords ? haversineKm(myCoords, { lat: peer.lat, lng: peer.lng }) : null;

  const hail = () => {
    const name = peer.handle || "driver";
    try { Speech.stop(); Speech.speak(`Hailing ${name}.`, { rate: 1.0 }); } catch {}
    onClose();
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
                  <Ionicons name="car-sport" size={28} color="#fff" />
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
                    <Ionicons name="navigate" size={14} color={COLORS.primary} />
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
              </View>

              <TouchableOpacity testID="peer-hail" onPress={hail} style={styles.hailBtn} activeOpacity={0.85}>
                <Ionicons name="radio" size={20} color="#fff" />
                <Text style={styles.hailText}>Hail {peer.handle || "driver"}</Text>
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
  avatar: { width: 56, height: 56, borderRadius: 28, backgroundColor: COLORS.success, alignItems: "center", justifyContent: "center", borderWidth: 2, borderColor: "rgba(255,255,255,0.85)" },
  handle: { color: COLORS.text, fontSize: 18, fontWeight: "700", letterSpacing: -0.3 },
  car: { color: COLORS.textDim, fontSize: 13, marginTop: 2 },
  closeBtn: { width: 32, height: 32, borderRadius: 16, alignItems: "center", justifyContent: "center", backgroundColor: "rgba(255,255,255,0.10)" },
  metaRow: { flexDirection: "row", gap: 8, marginTop: 14, marginBottom: 14, flexWrap: "wrap" },
  metaCell: { flexDirection: "row", alignItems: "center", gap: 5, paddingHorizontal: 10, paddingVertical: 6, borderRadius: 10, backgroundColor: "rgba(255,255,255,0.06)" },
  metaText: { color: COLORS.text, fontSize: 12, fontWeight: "600" },
  liveDot: { width: 7, height: 7, borderRadius: 4, backgroundColor: COLORS.success },
  hailBtn: { flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 8, backgroundColor: COLORS.primary, paddingVertical: 14, borderRadius: 14 },
  hailText: { color: "#fff", fontWeight: "700", fontSize: 15, letterSpacing: 0.2 },
});
