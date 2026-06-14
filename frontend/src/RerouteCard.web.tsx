// src/RerouteCard.web.tsx
//
// Web fallback for the mid-drive reroute card. Web has no react-native-maps, so
// we render the same card WITHOUT the live map preview (driving reroutes are a
// mobile scenario). Keeps the web bundle free of react-native-maps.

import React from "react";
import { View, Text, StyleSheet, TouchableOpacity, Modal } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { COLORS } from "./theme";
import type { NavRoute } from "./nav";

type Props = {
  visible: boolean;
  route: NavRoute | null;
  title: string;
  subtitle: string;
  onAccept: () => void;
  onDecline: () => void;
};

export default function RerouteCard({ visible, title, subtitle, onAccept, onDecline }: Props) {
  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onDecline}>
      <View style={styles.backdrop}>
        <View style={styles.cardWrap}>
          <View style={styles.card}>
            <View style={styles.headerRow}>
              <Ionicons name="navigate-circle" size={22} color={COLORS.brand} />
              <Text style={styles.title} numberOfLines={1}>{title}</Text>
            </View>
            <Text style={styles.sub} numberOfLines={2}>{subtitle}</Text>
            <View style={styles.btnRow}>
              <TouchableOpacity style={[styles.btn, styles.btnGhost]} onPress={onDecline} activeOpacity={0.85}>
                <Text style={styles.btnGhostText}>No thanks</Text>
              </TouchableOpacity>
              <TouchableOpacity style={[styles.btn, styles.btnTake]} onPress={onAccept} activeOpacity={0.85}>
                <Ionicons name="checkmark" size={18} color="#0B0B0C" />
                <Text style={styles.btnTakeText}>Take it</Text>
              </TouchableOpacity>
            </View>
          </View>
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: { flex: 1, backgroundColor: "rgba(0,0,0,0.55)", justifyContent: "center", alignItems: "center", padding: 20 },
  cardWrap: { width: "100%", maxWidth: 400 },
  card: { borderRadius: 22, padding: 16, backgroundColor: "rgba(18,19,22,0.98)", borderWidth: StyleSheet.hairlineWidth, borderColor: "rgba(255,255,255,0.18)" },
  headerRow: { flexDirection: "row", alignItems: "center", gap: 8 },
  title: { color: COLORS.text, fontSize: 18, fontWeight: "800", letterSpacing: -0.3, flex: 1 },
  sub: { color: COLORS.textDim, fontSize: 13, marginTop: 4, marginBottom: 14 },
  btnRow: { flexDirection: "row", gap: 10 },
  btn: { flex: 1, flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 6, paddingVertical: 13, borderRadius: 13 },
  btnGhost: { backgroundColor: "rgba(255,255,255,0.10)" },
  btnGhostText: { color: COLORS.text, fontSize: 15, fontWeight: "700" },
  btnTake: { backgroundColor: COLORS.brand },
  btnTakeText: { color: "#0B0B0C", fontSize: 15, fontWeight: "800" },
});
