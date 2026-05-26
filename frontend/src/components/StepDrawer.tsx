// StepDrawer.tsx — bottom slide-up turn-by-turn step list.
//
// Pulled out of map.tsx during the June 2025 refactor. Owns:
//   - The drawer's slide animation (translateY driven by Animated.spring)
//   - The drag-down-to-dismiss PanResponder on the top grab pill
//   - The re-summon strip (bottom grab pill, visible when the drawer is hidden)
//
// The PARENT owns the actual route data plus the visibility state — we keep
// the drawer dumb so the parent can also pop it open after auto-select (3s
// peek after polyline tap, see map.tsx ‘handleSelectRoute’).

import React, { useEffect, useImperativeHandle, useRef, forwardRef } from "react";
import {
  View, Text, StyleSheet, ScrollView, Animated, PanResponder, TouchableOpacity,
} from "react-native";
import { Ionicons } from "@expo/vector-icons";

export const DRAWER_HEIGHT = 320;

type Step = { html: string; distance_text: string; maneuver?: string };
type Route = {
  distance_text: string;
  duration_text: string;
  duration_in_traffic_text?: string;
  steps?: Step[];
};

export type StepDrawerHandle = {
  open: () => void;
  close: () => void;
};

type Props = {
  route: Route | null;
  maneuverIcon: (m?: string) => any;
  // Parent observes visibility transitions so it can clear timers etc.
  onVisibilityChange?: (visible: boolean) => void;
};

const StepDrawer = forwardRef<StepDrawerHandle, Props>(function StepDrawer(
  { route, maneuverIcon, onVisibilityChange },
  ref
) {
  // 0 = hidden (below the screen at DRAWER_HEIGHT), 1 = fully visible at y=0.
  const anim = useRef(new Animated.Value(0)).current;
  const [visible, setVisible] = React.useState(false);

  const slideUp = React.useCallback(() => {
    setVisible(true);
    onVisibilityChange?.(true);
    Animated.spring(anim, { toValue: 1, useNativeDriver: true, tension: 65, friction: 11 }).start();
  }, [anim, onVisibilityChange]);

  const slideDown = React.useCallback(() => {
    Animated.timing(anim, { toValue: 0, duration: 280, useNativeDriver: true }).start(({ finished }) => {
      if (finished) {
        setVisible(false);
        onVisibilityChange?.(false);
      }
    });
  }, [anim, onVisibilityChange]);

  useImperativeHandle(ref, () => ({ open: slideUp, close: slideDown }), [slideUp, slideDown]);

  // Drag-down-to-dismiss gesture on the drawer's grab pill. Hold-drag scrubs
  // the open progress live; release > 60px or fling-down kills the drawer.
  const pan = useRef(
    PanResponder.create({
      onMoveShouldSetPanResponder: (_, g) => Math.abs(g.dy) > 5,
      onPanResponderMove: (_, g) => {
        if (g.dy > 0) {
          const progress = Math.max(0, 1 - g.dy / DRAWER_HEIGHT);
          anim.setValue(progress);
        }
      },
      onPanResponderRelease: (_, g) => {
        if (g.dy > 60 || g.vy > 0.5) slideDown();
        else slideUp();
      },
    })
  ).current;

  if (!route) return null;
  const steps = (route.steps ?? []) as Step[];

  return (
    <>
      {!visible && (
        <TouchableOpacity
          testID="step-drawer-handle"
          style={styles.grabHandle}
          onPress={slideUp}
          activeOpacity={0.75}
        >
          <View style={styles.grabPill} />
        </TouchableOpacity>
      )}
      <Animated.View
        pointerEvents={visible ? "auto" : "none"}
        style={[
          styles.drawer,
          {
            transform: [{
              translateY: anim.interpolate({
                inputRange: [0, 1],
                outputRange: [DRAWER_HEIGHT, 0],
              }),
            }],
          },
        ]}
      >
        <View {...pan.panHandlers} style={styles.handle}>
          <View style={styles.grabPill} />
        </View>
        <View style={styles.summary}>
          <Text style={styles.duration}>{route.duration_in_traffic_text ?? route.duration_text}</Text>
          <Text style={styles.distance}>{route.distance_text}</Text>
        </View>
        <ScrollView style={styles.list} showsVerticalScrollIndicator={false}>
          {steps.map((step, i) => (
            <View key={i} style={styles.row}>
              <Ionicons
                name={maneuverIcon(step.maneuver)}
                size={20}
                color="#FFFFFF"
                style={{ marginTop: 2 }}
              />
              <View style={{ flex: 1 }}>
                <Text style={styles.text}>{step.html}</Text>
                <Text style={styles.dist}>{step.distance_text}</Text>
              </View>
            </View>
          ))}
        </ScrollView>
      </Animated.View>
    </>
  );
});

export default StepDrawer;

const styles = StyleSheet.create({
  // Dark glass panel sliding up from `bottom: 72` (above the tab bar).
  drawer: {
    position: "absolute",
    bottom: 72,
    left: 0, right: 0,
    height: DRAWER_HEIGHT,
    backgroundColor: "rgba(18,18,20,0.97)",
    borderTopLeftRadius: 16,
    borderTopRightRadius: 16,
    zIndex: 200,
    paddingBottom: 12,
  },
  // Top of the drawer — area the user grabs to drag down/dismiss.
  handle: {
    alignItems: "center",
    paddingVertical: 10,
  },
  grabPill: {
    width: 36, height: 4,
    borderRadius: 2,
    backgroundColor: "rgba(255,255,255,0.35)",
  },
  // Re-summon strip — sits above the tab bar when the drawer is tucked away.
  grabHandle: {
    position: "absolute",
    bottom: 72,
    left: 0, right: 0,
    alignItems: "center",
    paddingVertical: 8,
    zIndex: 199,
  },
  summary: {
    flexDirection: "row",
    justifyContent: "space-between",
    paddingHorizontal: 18,
    paddingBottom: 10,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: "rgba(255,255,255,0.1)",
  },
  duration: { color: "#fff", fontSize: 20, fontWeight: "700" },
  distance: { color: "rgba(255,255,255,0.55)", fontSize: 14, alignSelf: "flex-end" },
  list: { flex: 1, paddingHorizontal: 18, marginTop: 8 },
  row: {
    flexDirection: "row",
    alignItems: "flex-start",
    paddingVertical: 10,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: "rgba(255,255,255,0.07)",
    gap: 12,
  },
  text: { color: "#fff", fontSize: 14, fontWeight: "500", flexShrink: 1 },
  dist: { color: "rgba(255,255,255,0.45)", fontSize: 12, marginTop: 2 },
});
