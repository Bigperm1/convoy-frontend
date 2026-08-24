// Garage Consent — the read-and-acknowledge gate between the Ultra pitch and the
// camera. Jeff's workflow, 2026-08-23: pay -> "they read the requirements and the
// disclaimer that there can be errors and will not be an exact replica of their
// car. and that they get 2 tries to finalize. if they choose a 2nd render they
// loose the first try" -> once checked, the photo sequence starts.
//
// This is a deliberate wall, not a formality. Photogrammetry from four phone
// photos WILL get details wrong, and a customer who paid for "my actual car"
// without being told that is a refund and a bad review. The second-attempt rule
// is destructive, so it is stated before the first photo rather than discovered
// at the moment it bites.

import React, { useCallback, useEffect, useState } from "react";
import {
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { LinearGradient } from "expo-linear-gradient";
import { Ionicons } from "@expo/vector-icons";
import * as Haptics from "expo-haptics";
import { router } from "expo-router";

import { COLORS } from "../../src/theme";
import { CandyCta } from "../../src/components/CandyCta";
import { TierTitle } from "../../src/PremiumBadge";
import { skin } from "../../src/tierTheme";
import { getSettings, updateSettings } from "../../src/settings";
import { SCAN_SHOTS, SCAN_RULES, MAX_SCAN_ATTEMPTS } from "../../src/carScan";

// This is an ULTRA PREMIUM page — gold, not brand green (Jeff 8/23).
const ULTRA = skin("ultra");

export default function GarageConsentScreen() {
  const [agreed, setAgreed] = useState(false);
  const [used, setUsed] = useState(0);
  const [hasCar, setHasCar] = useState(false);

  useEffect(() => {
    (async () => {
      const s = await getSettings();
      setUsed(s.carScanAttemptsUsed ?? 0);
      setHasCar(!!s.carScanModelUrl);
    })();
  }, []);

  const remaining = Math.max(0, MAX_SCAN_ATTEMPTS - used);
  const isSecond = used >= 1;
  const exhausted = remaining === 0;

  const proceed = useCallback(async () => {
    Haptics.selectionAsync();
    await updateSettings({ carScanConsentAt: new Date().toISOString() });
    router.push("/(app)/garage-capture" as any);
  }, []);

  return (
    <SafeAreaView style={styles.safe}>
      <View style={styles.headerRow}>
        <TouchableOpacity onPress={() => router.back()} style={styles.backBtn} hitSlop={10}>
          <Ionicons name="chevron-back" size={24} color={COLORS.text} />
        </TouchableOpacity>
        <Text style={styles.headerTitle}>Before you start</Text>
        <View style={styles.backBtn} />
      </View>

      <ScrollView contentContainerStyle={styles.scroll} showsVerticalScrollIndicator={false}>
        <TierTitle tier="ultra" style={styles.tierTitle} />

        {/* ── attempts ───────────────────────────────────────────────────── */}
        <View style={[styles.attemptCard, isSecond && styles.attemptCardWarn]}>
          <Ionicons
            name={exhausted ? "lock-closed" : isSecond ? "warning" : "sparkles"}
            size={19}
            color={isSecond ? COLORS.warning : ULTRA.accent}
          />
          <View style={{ flex: 1 }}>
            <Text style={[styles.attemptTitle, isSecond && styles.attemptTitleWarn]}>
              {exhausted
                ? "No renders left"
                : `${remaining} of ${MAX_SCAN_ATTEMPTS} render${remaining === 1 ? "" : "s"} left`}
            </Text>
            <Text style={styles.attemptBody}>
              {exhausted
                ? "Both renders have been used. Your current car stays as it is."
                : isSecond && hasCar
                  ? "This is your final render. The car you have now will be REPLACED and cannot be brought back — even if you like it more."
                  : "You get two renders. The second one replaces the first, so the first is gone for good once you use it."}
            </Text>
          </View>
        </View>

        {/* ── the honest part ────────────────────────────────────────────── */}
        <Text style={styles.sectionLabel}>What to expect</Text>
        <View style={styles.card}>
          <Row
            icon="alert-circle"
            title="It will not be an exact replica"
            body="Your car is rebuilt from four photos. Badges, grilles, wheel spokes and trim can come out wrong or simplified. It will read as your car — it will not survive a close inspection."
          />
          <Divider />
          <Row
            icon="sunny"
            title="Light decides the result"
            body="Open shade or overcast is best. Hard sun bakes glare and shadows into the paint, and a parkade bakes reflections in as fake dents. The same car shot in bad light comes back visibly worse."
          />
          <Divider />
          <Row
            icon="car-sport"
            title="Shoot it clean and closed"
            body="Doors and windows shut, wheels straight, nothing leaning on it, nobody in frame. Anything touching the car may be modelled into it."
          />
        </View>

        {/* ── requirements ───────────────────────────────────────────────── */}
        <Text style={styles.sectionLabel}>The {SCAN_SHOTS.length} photos</Text>
        <View style={styles.card}>
          {SCAN_SHOTS.map((s, i) => (
            <View key={s.id}>
              {i > 0 && <Divider />}
              <View style={styles.shotRow}>
                <View style={styles.shotNum}>
                  <LinearGradient
                    colors={ULTRA.colors}
                    locations={ULTRA.locations}
                    style={StyleSheet.absoluteFill}
                  />
                  <Text style={styles.shotNumText}>{i + 1}</Text>
                </View>
                <View style={{ flex: 1 }}>
                  <Text style={styles.shotLabel}>{s.label}</Text>
                  <Text style={styles.shotHint}>{s.hint}</Text>
                </View>
              </View>
            </View>
          ))}
        </View>

        <View style={styles.rulesBox}>
          {SCAN_RULES.map((r) => (
            <View key={r} style={styles.ruleRow}>
              <Text style={styles.ruleDot}>·</Text>
              <Text style={styles.ruleText}>{r}</Text>
            </View>
          ))}
        </View>

        {/* ── acknowledge ────────────────────────────────────────────────── */}
        {!exhausted && (
          <TouchableOpacity
            style={styles.checkRow}
            activeOpacity={0.8}
            onPress={() => {
              Haptics.selectionAsync();
              setAgreed((v) => !v);
            }}
          >
            <View style={[styles.checkbox, agreed && styles.checkboxOn]}>
              {agreed && (
                <>
                  <LinearGradient
                    colors={ULTRA.colors}
                    locations={ULTRA.locations}
                    style={StyleSheet.absoluteFill}
                  />
                  <Ionicons name="checkmark" size={16} color={ULTRA.ink} />
                </>
              )}
            </View>
            <Text style={styles.checkText}>
              I understand my car will not be an exact replica, and that
              {isSecond ? " this render replaces the one I have now." : ` I get ${MAX_SCAN_ATTEMPTS} renders and the second replaces the first.`}
            </Text>
          </TouchableOpacity>
        )}

        {exhausted ? (
          <TouchableOpacity style={styles.secondary} onPress={() => router.back()} activeOpacity={0.85}>
            <Text style={styles.secondaryText}>Go back</Text>
          </TouchableOpacity>
        ) : (
          <CandyCta
            label="Start the photo sequence"
            icon="camera"
            onPress={proceed}
            disabled={!agreed}
            tier="ultra"
          />
        )}
      </ScrollView>
    </SafeAreaView>
  );
}

function Row({ icon, title, body }: { icon: any; title: string; body: string }) {
  return (
    <View style={styles.row}>
      <Ionicons name={icon} size={18} color={ULTRA.accent} style={{ marginTop: 1 }} />
      <View style={{ flex: 1 }}>
        <Text style={styles.rowTitle}>{title}</Text>
        <Text style={styles.rowBody}>{body}</Text>
      </View>
    </View>
  );
}

const Divider = () => <View style={styles.divider} />;

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: COLORS.bg },
  tierTitle: { marginTop: 2, marginBottom: 12 },
  scroll: { paddingHorizontal: 18, paddingBottom: 44 },

  headerRow: { flexDirection: "row", alignItems: "center", paddingHorizontal: 12, paddingBottom: 8 },
  backBtn: { padding: 6, width: 46 },
  headerTitle: { flex: 1, color: COLORS.text, fontSize: 17, fontWeight: "700", textAlign: "center" },

  attemptCard: {
    flexDirection: "row",
    gap: 12,
    alignItems: "flex-start",
    backgroundColor: "rgba(224,169,62,0.09)",
    borderWidth: 1,
    borderColor: "rgba(224,169,62,0.34)",
    borderRadius: 16,
    padding: 14,
    marginTop: 6,
  },
  attemptCardWarn: {
    backgroundColor: "rgba(255,159,10,0.08)",
    borderColor: "rgba(255,159,10,0.34)",
  },
  attemptTitle: { color: ULTRA.accent, fontSize: 15, fontWeight: "800", marginBottom: 3 },
  attemptTitleWarn: { color: COLORS.warning },
  attemptBody: { color: COLORS.textDim, fontSize: 13, lineHeight: 19 },

  sectionLabel: {
    color: "#808080",
    fontSize: 12.5,
    fontWeight: "700",
    letterSpacing: 0.8,
    textTransform: "uppercase",
    marginTop: 24,
    marginBottom: 9,
  },
  card: { backgroundColor: "#0F0F0F", borderRadius: 16, borderWidth: 1, borderColor: "#1C1C1C" },
  divider: { height: 1, backgroundColor: "#1A1A1A", marginHorizontal: 14 },

  row: { flexDirection: "row", gap: 11, padding: 14 },
  rowTitle: { color: COLORS.text, fontSize: 14.5, fontWeight: "700", marginBottom: 3 },
  rowBody: { color: COLORS.textDim, fontSize: 13, lineHeight: 19 },

  shotRow: { flexDirection: "row", gap: 11, padding: 13, alignItems: "center" },
  shotNum: {
    width: 26,
    height: 26,
    borderRadius: 13,
    borderWidth: 1,
    borderColor: ULTRA.rim,
    alignItems: "center",
    justifyContent: "center",
    overflow: "hidden",
  },
  shotNumText: { color: ULTRA.ink, fontSize: 12.5, fontWeight: "800" },
  shotLabel: { color: COLORS.text, fontSize: 14.5, fontWeight: "700" },
  shotHint: { color: COLORS.textDim, fontSize: 12.5, marginTop: 1 },

  rulesBox: { marginTop: 12, gap: 7, paddingHorizontal: 2 },
  ruleRow: { flexDirection: "row", gap: 8 },
  ruleDot: { color: ULTRA.accent, fontSize: 13, lineHeight: 19 },
  ruleText: { flex: 1, color: COLORS.textDim, fontSize: 12.5, lineHeight: 19 },

  checkRow: { flexDirection: "row", gap: 11, alignItems: "flex-start", marginTop: 26, marginBottom: 16 },
  checkbox: {
    width: 24,
    height: 24,
    borderRadius: 7,
    borderWidth: 1.5,
    borderColor: "#3A3A3A",
    alignItems: "center",
    justifyContent: "center",
    overflow: "hidden",
  },
  checkboxOn: { borderColor: ULTRA.rim },
  checkText: { flex: 1, color: COLORS.text, fontSize: 13.5, lineHeight: 20 },

  cta: {
    height: 54,
    borderRadius: 16,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 9,
  },
  ctaText: { color: "#04150B", fontSize: 16.5, fontWeight: "800" },
  ctaTextOff: { color: "#4A4A4A" },

  secondary: {
    height: 52,
    borderRadius: 16,
    borderWidth: 1,
    borderColor: "#2A2A2A",
    alignItems: "center",
    justifyContent: "center",
    marginTop: 24,
  },
  secondaryText: { color: COLORS.textDim, fontSize: 16, fontWeight: "700" },
});
