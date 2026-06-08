// NavigationPanel.tsx — right-edge turn-by-turn action drawer.
//
// Sits ABOVE the HazardDrawer in the right-side stack and reuses the same
// peek pattern: an Animated.View slides on translateX with a friction spring.
//
// Peeked state: only the maneuver-icon glyph sticks out as a "drawer pull".
// Open state: glassy card with:
//   - Big maneuver arrow + distance to next turn
//   - Truncated step instruction
//   - Mute toggle
//   - End-nav red button
//
// Pulled out of map.tsx during the June 2025 refactor.

import React, { useEffect, useRef } from "react";
import { View, Text, StyleSheet, Animated, TouchableOpacity } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import Glass from "../Glass";
import { COLORS } from "../theme";
import { DRAWER_PEEK_TX } from "./FloatingButtons";

export default function NavigationPanel({
  visible,
  onExpand,
  onCollapse,
  maneuverIcon,
  distance,
  instruction,
  muted,
  onToggleMute,
  onEnd,
}: {
  visible: boolean;
  onExpand: () => void;
  onCollapse: () => void;
  maneuverIcon: any;
  distance: string;
  instruction: string;
  muted: boolean;
  onToggleMute: () => void;
  onEnd: () => void;
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

  // 5s auto-collapse — same pattern as HazardDrawer. The driver shouldn't
  // have to dig out of an open nav overlay if they bumped it accidentally.
  useEffect(() => {
    if (!visible) return;
    const t = setTimeout(() => onCollapse(), 5000);
    return () => clearTimeout(t);
  }, [visible, onCollapse]);

  if (!visible) {
    return (
      <Animated.View
        style={[styles.wrap, { transform: [{ translateX: tx }] }]}
        testID="nav-drawer"
      >
        <TouchableOpacity onPress={onExpand} activeOpacity={0.85}>
          <Glass radius={20}>
            <View style={styles.peek}>
              <Ionicons name={maneuverIcon} size={26} color="#fff" />
            </View>
          </Glass>
        </TouchableOpacity>
      </Animated.View>
    );
  }
  return (
    <Animated.View
      style={[styles.wrap, { transform: [{ translateX: tx }] }]}
      testID="nav-drawer-open"
    >
      <Glass radius={20}>
        <View style={styles.open}>
          <TouchableOpacity onPress={onCollapse} activeOpacity={0.85} style={styles.header}>
            <Ionicons name={maneuverIcon} size={28} color="#fff" />
            <Text style={styles.dist}>{distance}</Text>
          </TouchableOpacity>
          <Text style={styles.inst} numberOfLines={3}>{instruction}</Text>
          <TouchableOpacity testID="nav-mute" onPress={onToggleMute} style={styles.btn} activeOpacity={0.85}>
            <Ionicons name={muted ? "volume-mute" : "volume-high"} size={18} color="#fff" />
            <Text style={styles.btnText}>{muted ? "Muted" : "Sound"}</Text>
          </TouchableOpacity>
          <TouchableOpacity testID="end-nav" onPress={onEnd} style={[styles.btn, styles.endBtn]} activeOpacity={0.85}>
            <Ionicons name="close" size={18} color="#fff" />
            <Text style={styles.btnText}>End</Text>
          </TouchableOpacity>
        </View>
      </Glass>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  wrap: {
    position: "absolute",
    right: 0,
    bottom: 360,
    zIndex: 9,
  },
  peek: {
    width: 64,
    height: 64,
    alignItems: "center",
    justifyContent: "center",
  },
  open: {
    width: 180,
    paddingHorizontal: 14,
    paddingVertical: 12,
    gap: 10,
  },
  header: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
  },
  dist: { color: "#F4F4F4", fontWeight: "800", fontSize: 18, letterSpacing: -0.3 },
  inst: { color: COLORS.text, fontSize: 13, lineHeight: 18 },
  btn: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 6,
    paddingHorizontal: 10,
    paddingVertical: 8,
    borderRadius: 12,
    backgroundColor: "rgba(255,255,255,0.10)",
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: "rgba(255,255,255,0.18)",
  },
  endBtn: {
    backgroundColor: "#FF3B30",
    borderColor: "rgba(255,255,255,0)",
  },
  btnText: { color: "#F4F4F4", fontSize: 12, fontWeight: "700", letterSpacing: 0.4 },
});
