// settingsKit.tsx — shared building blocks for the menu-style Settings (the
// Velox-inspired grouped layout). Every Settings sub-page composes these so the
// header, neon backdrop, section cards, and rows stay pixel-identical:
//
//   <SettingsPage title="Map Mode">
//     <SectionLabel>APPEARANCE</SectionLabel>
//     <SettingsCard>
//       <RadioRow ... /> <Divider /> <RadioRow ... />
//     </SettingsCard>
//     <HelpText>…</HelpText>
//   </SettingsPage>
//
// MenuRow = a navigable chevron row (the menu itself). ToggleRow / RadioRow =
// the actual controls that live on the leaf sub-pages.

import React from "react";
import { View, Text, StyleSheet, TouchableOpacity, ScrollView, Switch } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";
import { useRouter } from "expo-router";
import { COLORS } from "../theme";
import { TierLock, useFeature, useFeatureTier, openPaywall } from "../PremiumBadge";
import type { PremiumFeature } from "../entitlements";
import Glass from "../Glass";
import GlassBackdrop from "./GlassBackdrop";

// ---- Page shell: neon backdrop + back-header + scroll body -------------------
export function SettingsPage({
  title,
  children,
  footer,
}: {
  title: string;
  children: React.ReactNode;
  footer?: React.ReactNode;
}) {
  const router = useRouter();
  return (
    <View style={styles.container}>
      <GlassBackdrop />
      <SafeAreaView edges={["top"]} style={styles.headerWrap}>
        <View style={styles.header}>
          <TouchableOpacity onPress={() => router.back()} style={styles.headerBtn} testID="settings-back">
            <Ionicons name="chevron-back" size={26} color={COLORS.text} />
          </TouchableOpacity>
          <Text style={styles.headerTitle} numberOfLines={1}>{title}</Text>
          <View style={styles.headerBtn} />
        </View>
      </SafeAreaView>
      <ScrollView contentContainerStyle={styles.content} showsVerticalScrollIndicator={false}>
        {children}
        <View style={{ height: 120 }} />
      </ScrollView>
      {footer}
    </View>
  );
}

export function SectionLabel({ children }: { children: React.ReactNode }) {
  return <Text style={styles.sectionLabel}>{children}</Text>;
}

export function SettingsCard({ children }: { children: React.ReactNode }) {
  return (
    <Glass radius={16} frost style={styles.card}>
      {children}
    </Glass>
  );
}

export function Divider() {
  return <View style={styles.divider} />;
}

export function HelpText({ children }: { children: React.ReactNode }) {
  return <Text style={styles.helpText}>{children}</Text>;
}

// ---- MenuRow: a navigable row (icon → title → optional value → chevron) ------
export function MenuRow({
  icon,
  iconColor,
  title,
  subtitle,
  value,
  swatch,
  onPress,
  testID,
  destructive,
}: {
  icon: any;
  iconColor: string;
  title: string;
  subtitle?: string;
  value?: string;
  swatch?: string; // a color dot shown before the chevron (e.g. route color)
  onPress: () => void;
  testID?: string;
  destructive?: boolean;
}) {
  return (
    <TouchableOpacity onPress={onPress} activeOpacity={0.7} style={styles.row} testID={testID}>
      <View style={[styles.iconWrap, { backgroundColor: iconColor + "22" }]}>
        <Ionicons name={icon} size={18} color={iconColor} />
      </View>
      <View style={{ flex: 1 }}>
        <Text style={[styles.title, destructive && { color: "#FF453A" }]}>{title}</Text>
        {!!subtitle && <Text style={styles.subtitle}>{subtitle}</Text>}
      </View>
      {!!value && <Text style={styles.rowValue}>{value}</Text>}
      {!!swatch && <View style={[styles.swatch, { backgroundColor: swatch }]} />}
      <Ionicons name="chevron-forward" size={18} color={COLORS.textDim} />
    </TouchableOpacity>
  );
}

// ---- ToggleRow: boolean switch ----------------------------------------------
export function ToggleRow({
  icon,
  iconColor,
  title,
  subtitle,
  value,
  onChange,
  badge,
  feature,
}: {
  icon: any;
  iconColor: string;
  title: string;
  subtitle?: string;
  value: boolean;
  onChange: (v: boolean) => void;
  badge?: string;
  /**
   * Premium-gate this row. When the tier does not cover it the switch is
   * replaced by the tier's H — SILVER for Premium, GOLD for Ultra Premium — and
   * tapping the row opens the paywall instead of toggling.
   *
   * Jeff, 2026-08-23: the H marks are "the visual locks for the Setting toggles
   * that are locked under each Premium service." Passing the FEATURE (not a
   * tier) is deliberate: the metal is derived from the entitlement ladder, so a
   * feature that moves between tiers can never end up wearing the wrong one.
   */
  feature?: PremiumFeature;
}) {
  const unlocked = useFeature(feature ?? "arrow_colors");
  const tier = useFeatureTier(feature ?? "arrow_colors");
  const locked = !!feature && !unlocked;

  const body = (
    <>
      <View style={[styles.iconWrap, { backgroundColor: iconColor + "22" }, locked && styles.iconWrapLocked]}>
        <Ionicons name={icon} size={18} color={locked ? COLORS.textDim : iconColor} />
      </View>
      <View style={{ flex: 1 }}>
        <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
          <Text style={[styles.title, locked && styles.titleLocked]}>{title}</Text>
          {badge && (
            <View style={styles.badge}>
              <Text style={styles.badgeText}>{badge}</Text>
            </View>
          )}
        </View>
        {!!subtitle && <Text style={styles.subtitle}>{subtitle}</Text>}
      </View>
      {locked ? (
        <TierLock tier={tier} size={24} />
      ) : (
        <Switch
          value={value}
          onValueChange={onChange}
          trackColor={{ false: "#3A3A3C", true: COLORS.brand }}
          thumbColor="#FFFFFF"
          ios_backgroundColor="#3A3A3C"
        />
      )}
    </>
  );

  // A locked row is a BUY button, not a dead row — the whole row opens the sheet.
  if (locked) {
    return (
      <TouchableOpacity style={styles.row} activeOpacity={0.7} onPress={() => openPaywall(feature!)}>
        {body}
      </TouchableOpacity>
    );
  }
  return <View style={styles.row}>{body}</View>;
}

// ---- RadioRow: mutually-exclusive choice ------------------------------------
export function RadioRow({
  icon,
  iconColor,
  title,
  subtitle,
  selected,
  onSelect,
  feature,
}: {
  icon: any;
  iconColor: string;
  title: string;
  subtitle?: string;
  selected: boolean;
  onSelect: () => void;
  /** Premium-gate this choice. Same contract as ToggleRow: the radio is replaced by the
   *  tier's H (silver = Premium, gold = Ultra Premium) and the whole row opens the
   *  paywall instead of selecting. Pass the FEATURE, never a tier — the metal is derived
   *  from the ladder so a feature that moves tiers can't wear the wrong one. */
  feature?: PremiumFeature;
}) {
  const unlocked = useFeature(feature ?? "arrow_colors");
  const tier = useFeatureTier(feature ?? "arrow_colors");
  const locked = !!feature && !unlocked;
  return (
    <TouchableOpacity
      onPress={() => (locked ? openPaywall(feature!) : onSelect())}
      activeOpacity={0.7}
      style={styles.row}
    >
      <View style={[styles.iconWrap, { backgroundColor: iconColor + "22" }, locked && styles.iconWrapLocked]}>
        <Ionicons name={icon} size={20} color={locked ? COLORS.textDim : iconColor} />
      </View>
      <View style={{ flex: 1 }}>
        <Text style={[styles.title, locked && styles.titleLocked]}>{title}</Text>
        {!!subtitle && <Text style={styles.subtitle}>{subtitle}</Text>}
      </View>
      {locked ? (
        <TierLock tier={tier} size={24} />
      ) : (
        <View style={[styles.radioOuter, selected && { borderColor: iconColor }]}>
          {selected && <View style={[styles.radioInner, { backgroundColor: iconColor }]} />}
        </View>
      )}
    </TouchableOpacity>
  );
}

export const settingsStyles = StyleSheet.create({});

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: COLORS.bg },
  headerWrap: { borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: COLORS.hairline },
  header: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", paddingHorizontal: 8, paddingVertical: 8 },
  headerBtn: { width: 44, height: 44, alignItems: "center", justifyContent: "center" },
  headerTitle: { flex: 1, textAlign: "center", color: COLORS.text, fontSize: 17, fontWeight: "600", letterSpacing: -0.3 },
  content: { paddingHorizontal: 16, paddingTop: 12 },
  sectionLabel: {
    color: COLORS.textDim, fontSize: 12, fontWeight: "600",
    letterSpacing: 0.6, marginTop: 18, marginBottom: 8, marginLeft: 4,
  },
  card: { padding: 4 },
  row: { flexDirection: "row", alignItems: "center", padding: 12, gap: 12 },
  iconWrap: { width: 36, height: 36, borderRadius: 10, alignItems: "center", justifyContent: "center" },
  title: { color: COLORS.text, fontSize: 15, fontWeight: "500" },
  subtitle: { color: COLORS.textDim, fontSize: 12, marginTop: 2, lineHeight: 16 },
  rowValue: { color: COLORS.textDim, fontSize: 14, fontWeight: "500", marginRight: 2 },
  swatch: { width: 20, height: 20, borderRadius: 10, borderWidth: 1, borderColor: "rgba(255,255,255,0.3)", marginRight: 2 },
  divider: { height: StyleSheet.hairlineWidth, backgroundColor: COLORS.hairline, marginLeft: 60 },
  helpText: { color: COLORS.textMute || COLORS.textDim, fontSize: 11, lineHeight: 16, paddingHorizontal: 6, paddingTop: 8 },
  iconWrapLocked: { opacity: 0.5 },
  titleLocked: { color: COLORS.textDim },
  badge: {
    backgroundColor: "#2DEC8622", borderColor: "#2DEC8688", borderWidth: 1,
    borderRadius: 6, paddingHorizontal: 6, paddingVertical: 1,
  },
  badgeText: { color: "#2DEC86", fontSize: 9, fontWeight: "700", letterSpacing: 0.5 },
  radioOuter: {
    width: 22, height: 22, borderRadius: 11, borderWidth: 2, borderColor: COLORS.hairline,
    alignItems: "center", justifyContent: "center",
  },
  radioInner: { width: 12, height: 12, borderRadius: 6, backgroundColor: "#00C46A" },
});
