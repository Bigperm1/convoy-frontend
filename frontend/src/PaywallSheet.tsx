// PaywallSheet — the one upgrade sheet, opened from any locked surface via
// openPaywall(feature). Mounted once in the app tabs layout.
//
// STAGED (build-80 plan): purchase buttons are stubs until RevenueCat rides the
// build-74 native build; prices below are Jeff-pending placeholders. While
// ENTITLEMENTS_ENFORCED is false nothing opens this sheet in production.

import React, { useEffect, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  Modal,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from "react-native";
import { LinearGradient } from "expo-linear-gradient";
import { Ionicons } from "@expo/vector-icons";
import { COLORS } from "./theme";
import { PremiumBadge, subscribePaywall } from "./PremiumBadge";
import { redeemCode, type PremiumFeature } from "./entitlements";

// What the sheet leads with, per feature that opened it.
const FEATURE_HOOKS: Partial<Record<PremiumFeature, string>> = {
  arrow_colors: "Paint your arrow any colour",
  class_marker: "Drive the map as your car class",
  car_3d: "Put your actual car on the map in 3D",
  club_create: "Create clubs, events and cruises",
  top_speed: "Track your Top Cruise Speed",
  map_modes: "Dusk, night and satellite maps",
  route_colors: "Route colours beyond green",
  speed_cameras: "Speed camera alerts",
  road_incidents: "Live road incident alerts",
  voice_extras: "Every Scout voice",
  spoken_extras: "Spoken extras on your drive",
  speed_alert: "Speed alerts",
  comms_handsfree: "Hands-free comms",
  convoy_size: "Convoy with more than 3 cars",
};

const PERKS = [
  "3D garage cars + arrow colours + classes",
  "Unlimited convoy size",
  "Night, dusk and satellite maps",
  "Speed cameras & road incidents",
  "Hands-free comms & every Scout voice",
  "Create clubs, events and cruises",
];

export default function PaywallSheet() {
  const [visible, setVisible] = useState(false);
  const [hook, setHook] = useState<string | null>(null);
  const [code, setCode] = useState("");
  const [redeeming, setRedeeming] = useState(false);
  const [showCode, setShowCode] = useState(false);

  useEffect(
    () =>
      subscribePaywall((feature) => {
        setHook(FEATURE_HOOKS[feature] ?? null);
        setShowCode(false);
        setCode("");
        setVisible(true);
      }),
    []
  );

  const close = () => setVisible(false);

  const buy = (_plan: "monthly" | "yearly") => {
    // RevenueCat purchase lands with build 74.
    Alert.alert("Almost here", "Purchases arrive with the next app update.");
  };

  const submitCode = async () => {
    if (!code.trim() || redeeming) return;
    setRedeeming(true);
    const r = await redeemCode(code);
    setRedeeming(false);
    Alert.alert(r.ok ? "You're in" : "Hmm", r.message);
    if (r.ok) close();
  };

  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={close}>
      <View style={styles.backdrop}>
        <View style={styles.sheet}>
          <TouchableOpacity style={styles.close} onPress={close} hitSlop={12}>
            <Ionicons name="close" size={22} color={COLORS.textDim} />
          </TouchableOpacity>

          <PremiumBadge size="md" style={{ alignSelf: "center" }} />
          <Text style={styles.title}>{hook ?? "Unlock all of Hairpin"}</Text>
          <Text style={styles.sub}>One membership. The whole garage.</Text>

          <View style={styles.perks}>
            {PERKS.map((p) => (
              <View key={p} style={styles.perkRow}>
                <Ionicons name="checkmark-circle" size={16} color={COLORS.brand} />
                <Text style={styles.perkText}>{p}</Text>
              </View>
            ))}
          </View>

          {/* Prices are placeholders until Jeff signs off pricing. */}
          <TouchableOpacity activeOpacity={0.9} onPress={() => buy("yearly")}>
            <LinearGradient
              colors={[COLORS.brand, COLORS.brandDim]}
              start={{ x: 0, y: 0 }}
              end={{ x: 0, y: 1 }}
              style={styles.buyPrimary}
            >
              <Text style={styles.buyPrimaryText}>Yearly — $39.99</Text>
              <Text style={styles.buyPrimarySub}>7 days free · ~$3.33/mo</Text>
            </LinearGradient>
          </TouchableOpacity>
          <TouchableOpacity style={styles.buySecondary} activeOpacity={0.85} onPress={() => buy("monthly")}>
            <Text style={styles.buySecondaryText}>Monthly — $4.99</Text>
          </TouchableOpacity>

          {showCode ? (
            <View style={styles.codeRow}>
              <TextInput
                style={styles.codeInput}
                placeholder="Enter code"
                placeholderTextColor={COLORS.textDim}
                autoCapitalize="characters"
                autoCorrect={false}
                value={code}
                onChangeText={setCode}
                onSubmitEditing={submitCode}
              />
              <TouchableOpacity style={styles.codeGo} onPress={submitCode} disabled={redeeming}>
                {redeeming ? (
                  <ActivityIndicator color="#000" size="small" />
                ) : (
                  <Text style={styles.codeGoText}>Apply</Text>
                )}
              </TouchableOpacity>
            </View>
          ) : (
            <TouchableOpacity onPress={() => setShowCode(true)} hitSlop={8}>
              <Text style={styles.codeLink}>Have a code?</Text>
            </TouchableOpacity>
          )}
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: { flex: 1, backgroundColor: "rgba(0,0,0,0.6)", justifyContent: "flex-end" },
  sheet: {
    backgroundColor: COLORS.bgElev,
    borderTopLeftRadius: 24,
    borderTopRightRadius: 24,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: COLORS.hairlineStrong,
    padding: 22,
    paddingBottom: 40,
    gap: 10,
  },
  close: { position: "absolute", top: 14, right: 14, zIndex: 2 },
  title: { color: COLORS.text, fontSize: 21, fontWeight: "800", textAlign: "center", marginTop: 10 },
  sub: { color: COLORS.textDim, fontSize: 13, textAlign: "center", marginBottom: 6 },
  perks: { gap: 7, marginVertical: 8 },
  perkRow: { flexDirection: "row", alignItems: "center", gap: 8 },
  perkText: { color: COLORS.text, fontSize: 14 },
  buyPrimary: { borderRadius: 14, paddingVertical: 13, alignItems: "center" },
  buyPrimaryText: { color: "#04150B", fontSize: 16, fontWeight: "800" },
  buyPrimarySub: { color: "rgba(0,0,0,0.55)", fontSize: 11, fontWeight: "600", marginTop: 1 },
  buySecondary: {
    borderRadius: 14,
    paddingVertical: 12,
    alignItems: "center",
    borderWidth: 1,
    borderColor: COLORS.hairlineStrong,
    backgroundColor: COLORS.surface2,
  },
  buySecondaryText: { color: COLORS.text, fontSize: 15, fontWeight: "700" },
  codeLink: { color: COLORS.textDim, fontSize: 13, textAlign: "center", marginTop: 8, textDecorationLine: "underline" },
  codeRow: { flexDirection: "row", gap: 8, marginTop: 8 },
  codeInput: {
    flex: 1,
    backgroundColor: COLORS.surface2,
    borderRadius: 12,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: COLORS.hairline,
    color: COLORS.text,
    paddingHorizontal: 14,
    paddingVertical: 10,
    fontSize: 15,
  },
  codeGo: {
    backgroundColor: COLORS.brand,
    borderRadius: 12,
    paddingHorizontal: 18,
    justifyContent: "center",
    alignItems: "center",
  },
  codeGoText: { color: "#04150B", fontWeight: "800", fontSize: 14 },
});
