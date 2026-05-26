// FloatingButtons.tsx — right-edge hazard reporting controls.
//
// Two components live here side-by-side because they share the same peek/slide
// affordance: a small leading edge sticks out as a "drawer pull", a tap opens
// the panel, another tap on an icon fires the report. Pulled out of map.tsx
// during the June 2025 refactor.
//
//   HazardDrawer  — Vertical Police + Hazard column on the right edge,
//                   peeked 80% off-screen by default.
//   ReportPeekTab — Toggle FAB above the HazardDrawer (warning ↔ close).

import React, { useEffect, useRef } from "react";
import { View, Text, StyleSheet, Animated, TouchableOpacity, Platform } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { LinearGradient } from "expo-linear-gradient";
import * as Haptics from "expo-haptics";
import Glass from "../Glass";
import { COLORS } from "../theme";

// Drawer geometry shared by HazardDrawer and NavActionDrawer.
export const DRAWER_W = 84;
export const DRAWER_PEEK_TX = DRAWER_W * 0.80;

// Peek tab (the FAB above the drawer).
export const PEEK_W = 56;
export const PEEK_VISIBLE_RATIO = 0.33;
export const PEEK_HIDDEN_TX = PEEK_W * (1 - PEEK_VISIBLE_RATIO);

export function HazardDrawer({
  visible,
  onExpand,
  onCollapse,
  onReport,
}: {
  visible: boolean;
  onExpand: () => void;
  onCollapse: () => void;
  onReport: (kind: string) => void;
}) {
  const tx = useRef(new Animated.Value(visible ? 0 : DRAWER_PEEK_TX)).current;
  useEffect(() => {
    Animated.spring(tx, {
      toValue: visible ? 0 : DRAWER_PEEK_TX,
      useNativeDriver: true,
      friction: 9,
      tension: 80,
    }).start();
  }, [visible, tx]);

  // Auto-collapse after 5s of no interaction. Without this the drawer stays
  // open forever if the driver glances away mid-trip and forgets it.
  useEffect(() => {
    if (!visible) return;
    const t = setTimeout(() => onCollapse(), 5000);
    return () => clearTimeout(t);
  }, [visible, onCollapse]);

  const handle = (kind: string) => {
    if (!visible) {
      onExpand();
      return;
    }
    try { Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium); } catch {}
    onReport(kind);
  };

  return (
    <Animated.View
      style={[styles.drawerWrap, { transform: [{ translateX: tx }] }]}
      testID="report-panel"
    >
      <Glass radius={20}>
        <View style={styles.drawerInner}>
          <TouchableOpacity
            testID="report-police"
            onPress={() => handle("police")}
            activeOpacity={0.85}
            style={[styles.drawerBtn, { backgroundColor: "rgba(10,132,255,0.18)", borderColor: "rgba(10,132,255,0.55)" }]}
          >
            <Ionicons name="shield-checkmark" size={26} color="#0A84FF" />
            <Text style={[styles.drawerBtnText, { color: "#0A84FF" }]}>Police</Text>
          </TouchableOpacity>

          <TouchableOpacity
            testID="report-road"
            onPress={() => handle("road")}
            activeOpacity={0.85}
            style={[styles.drawerBtn, { backgroundColor: "rgba(255,159,10,0.18)", borderColor: "rgba(255,159,10,0.55)" }]}
          >
            <Ionicons name="warning" size={26} color="#FF9F0A" />
            <Text style={[styles.drawerBtnText, { color: "#FF9F0A" }]}>Hazard</Text>
          </TouchableOpacity>
        </View>
      </Glass>
    </Animated.View>
  );
}

export function ReportPeekTab({ active, onPress }: { active: boolean; onPress: () => void }) {
  const tx = useRef(new Animated.Value(active ? 0 : PEEK_HIDDEN_TX)).current;
  useEffect(() => {
    Animated.spring(tx, {
      toValue: active ? 0 : PEEK_HIDDEN_TX,
      useNativeDriver: true,
      friction: 9,
      tension: 90,
    }).start();
  }, [active, tx]);
  return (
    <Animated.View
      pointerEvents="box-none"
      style={[styles.peekWrap, { transform: [{ translateX: tx }] }]}
    >
      <TouchableOpacity
        testID="report-fab"
        onPress={onPress}
        activeOpacity={0.85}
        style={styles.peekBtn}
      >
        <LinearGradient
          colors={active ? ["#FF453A", "#A6201E"] : [COLORS.primary, COLORS.primaryDim]}
          start={{ x: 0, y: 0 }}
          end={{ x: 1, y: 1 }}
          style={StyleSheet.absoluteFill}
        />
        <Ionicons name={active ? "close" : "warning"} size={26} color="#fff" />
      </TouchableOpacity>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  // Slim slide-out hazard drawer — anchored right edge.
  drawerWrap: {
    position: "absolute",
    right: 0,
    bottom: 220,
    zIndex: 8,
  },
  drawerInner: {
    paddingHorizontal: 10,
    paddingVertical: 10,
    gap: 10,
    flexDirection: "column",
  },
  drawerBtn: {
    width: 64,
    height: 64,
    borderRadius: 16,
    alignItems: "center",
    justifyContent: "center",
    borderWidth: StyleSheet.hairlineWidth,
    gap: 2,
  },
  drawerBtnText: { fontSize: 11, fontWeight: "700", letterSpacing: 0.4, marginTop: 2 },

  peekWrap: { position: "absolute", right: 0, bottom: 130, width: 56, height: 56 },
  peekBtn: {
    width: 56, height: 56,
    borderTopLeftRadius: 14, borderBottomLeftRadius: 14,
    borderTopRightRadius: 0, borderBottomRightRadius: 0,
    overflow: "hidden",
    alignItems: "center", justifyContent: "center",
    ...Platform.select({
      ios: { shadowColor: "#000", shadowOpacity: 0.3, shadowRadius: 14, shadowOffset: { width: -2, height: 6 } },
      android: { elevation: 8 },
      web: { boxShadow: "-4px 6px 18px rgba(0,0,0,0.4)" } as any,
    }),
  },
});
