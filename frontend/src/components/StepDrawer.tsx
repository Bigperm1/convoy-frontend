// StepDrawer.tsx — the bottom trip bar during turn-by-turn nav.
//
// Collapsed: a thin summary bar that sits JUST ABOVE the tab bar (so the tab
// bar stays reachable) showing time-remaining · distance · arrival + a red
// round Exit — the "yellow banner" layout the design settled on. Tap the grab
// pill (or the bar) to pull up the full step-by-step list; drag it back down
// (or tap again) to collapse. The parent still owns route data + can drive
// open/close via the ref.

import React, { useImperativeHandle, useRef, forwardRef } from "react";
import {
  View, Text, StyleSheet, ScrollView, Animated, PanResponder, TouchableOpacity, Platform,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";

export const DRAWER_HEIGHT = 300;   // height of the slide-up step list
const TAB_BAR_H = 88;               // matches app/(app)/_layout.tsx tab bar
const BAR_H = 80;                   // approx height of the collapsed summary bar

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
  maneuverIcon: (m?: string, html?: string) => any;
  // Live trip progress (turn-by-turn). When provided, the summary bar shows
  // them in the yellow-banner layout; otherwise it falls back to route totals.
  eta?: string;                 // time remaining, e.g. "12 min"
  distanceRemaining?: string;   // e.g. "8.4 km"
  arrival?: string;             // arrival clock, e.g. "10:42 AM"
  onEnd?: () => void;           // red Exit button
  // Parent observes visibility transitions so it can clear timers etc.
  onVisibilityChange?: (visible: boolean) => void;
};

const StepDrawer = forwardRef<StepDrawerHandle, Props>(function StepDrawer(
  { route, maneuverIcon, eta, distanceRemaining, arrival, onEnd, onVisibilityChange },
  ref
) {
  // 0 = step list hidden (tucked behind the bar), 1 = fully open.
  const anim = useRef(new Animated.Value(0)).current;
  const [expanded, setExpanded] = React.useState(false);
  // Android edge-to-edge draws behind the system nav buttons. Lift the drawer by
  // the real device bottom inset — the SAME value the tab bar adds (see
  // app/(app)/_layout.tsx) — so it stays flush on top of the now-taller tab bar
  // instead of hiding behind the nav buttons. iOS contributes 0 → layout unchanged.
  const insets = useSafeAreaInsets();
  const navInset = Platform.OS === "android" ? insets.bottom : 0;

  const slideUp = React.useCallback(() => {
    setExpanded(true);
    onVisibilityChange?.(true);
    Animated.spring(anim, { toValue: 1, useNativeDriver: true, tension: 65, friction: 11 }).start();
  }, [anim, onVisibilityChange]);

  const slideDown = React.useCallback(() => {
    onVisibilityChange?.(false);
    Animated.timing(anim, { toValue: 0, duration: 240, useNativeDriver: true }).start(({ finished }) => {
      if (finished) setExpanded(false);
    });
  }, [anim, onVisibilityChange]);

  const toggle = React.useCallback(() => {
    if (expanded) slideDown(); else slideUp();
  }, [expanded, slideUp, slideDown]);

  useImperativeHandle(ref, () => ({ open: slideUp, close: slideDown }), [slideUp, slideDown]);

  // Drag-down on the open list to dismiss; fling or > 50px collapses it.
  const pan = useRef(
    PanResponder.create({
      onMoveShouldSetPanResponder: (_, g) => Math.abs(g.dy) > 5,
      onPanResponderRelease: (_, g) => { if (g.dy > 50 || g.vy > 0.5) slideDown(); },
    })
  ).current;

  // Collapsed-bar handle: GRAB and pull UP to open the step list (a downward
  // grab closes it again). A plain tap still toggles as a shortcut.
  const openPan = useRef(
    PanResponder.create({
      onStartShouldSetPanResponder: () => true,
      onMoveShouldSetPanResponder: (_, g) => Math.abs(g.dy) > 4,
      onPanResponderRelease: (_, g) => {
        const moved = Math.abs(g.dy) > 6 || Math.abs(g.dx) > 6;
        if (!moved) { toggle(); return; }               // plain tap → toggle
        if (g.dy < -24 || g.vy < -0.3) slideUp();        // grab + pull up → open
        else if (g.dy > 24 || g.vy > 0.3) slideDown();   // grab + pull down → close
      },
    })
  ).current;

  if (!route) return null;
  const steps = (route.steps ?? []) as Step[];
  const timeLabel = eta ?? route.duration_in_traffic_text ?? route.duration_text;
  // Compact formatting: drop the space ("25 min" → "25min", "6:24 PM" →
  // "6:24pm") to match the tightened nav bar layout.
  const compact = (s?: string) => (s ?? "").replace(/\s+/g, "");

  return (
    <>
      {/* Step list — slides up from behind the summary bar when expanded. */}
      {expanded && (
        <Animated.View
          pointerEvents="auto"
          style={[
            styles.listPanel,
            {
              bottom: TAB_BAR_H + BAR_H - 2 + navInset,
              opacity: anim,
              transform: [{
                translateY: anim.interpolate({ inputRange: [0, 1], outputRange: [DRAWER_HEIGHT, 0] }),
              }],
            },
          ]}
        >
          <View {...pan.panHandlers} style={styles.listHandle}>
            <View style={styles.grabPill} />
          </View>
          <ScrollView style={styles.list} showsVerticalScrollIndicator={false}>
            {steps.map((step, i) => (
              <View key={i} style={styles.row}>
                <Ionicons name={maneuverIcon(step.maneuver, step.html)} size={20} color="#FFFFFF" style={{ marginTop: 2 }} />
                <View style={{ flex: 1 }}>
                  <Text style={styles.text}>{step.html}</Text>
                  <Text style={styles.dist}>{step.distance_text}</Text>
                </View>
              </View>
            ))}
          </ScrollView>
        </Animated.View>
      )}

      {/* Collapsed summary bar — always visible during nav, sits above the tab bar. */}
      <View style={[styles.bar, { bottom: TAB_BAR_H + navInset }]}>
        <View {...openPan.panHandlers} style={styles.barGrabZone} testID="step-drawer-handle">
          <View style={styles.grabPill} />
        </View>
        <View style={styles.barRow}>
          <View style={styles.barTextRow}>
            <Text style={styles.barTime}>{compact(timeLabel)}</Text>
            {!!distanceRemaining && <Text style={styles.barMeta}>{compact(distanceRemaining)}</Text>}
            {!!arrival && <Text style={styles.barMeta}>{compact(arrival).toLowerCase()}</Text>}
          </View>
          {onEnd && (
            <TouchableOpacity onPress={onEnd} style={styles.barExit} activeOpacity={0.85} testID="end-nav">
              <Text style={styles.barExitText}>Exit</Text>
            </TouchableOpacity>
          )}
        </View>
      </View>
    </>
  );
});

export default StepDrawer;

const styles = StyleSheet.create({
  // Collapsed summary bar — dark with a convoy-yellow top accent, floats just
  // above the tab bar so the tabs stay reachable.
  bar: {
    position: "absolute",
    bottom: TAB_BAR_H,
    left: 0, right: 0,
    backgroundColor: "#141416",
    borderTopLeftRadius: 16,
    borderTopRightRadius: 16,
    borderTopWidth: 2,
    borderTopColor: "#2DEC86",
    // Symmetric top/bottom padding so the top headroom matches the gap under
    // the Exit circle (the row's tallest element).
    paddingTop: 10,
    paddingBottom: 10,
    zIndex: 200,
    shadowColor: "#000", shadowOpacity: 0.35, shadowRadius: 10, shadowOffset: { width: 0, height: -3 }, elevation: 12,
  },
  // Grab pill floats at the very top edge (absolute) so it adds NO layout
  // height — that's what keeps the top headroom equal to the bottom gap.
  barGrabZone: { position: "absolute", top: 0, left: 0, right: 0, alignItems: "center", paddingTop: 5, paddingBottom: 8, zIndex: 1 },
  grabPill: { width: 36, height: 4, borderRadius: 2, backgroundColor: "rgba(255,255,255,0.35)" },
  // paddingRight 12 matches the FAB stack's right:12 so the Exit circle lines up
  // vertically with the police / hazard FABs above it.
  barRow: { flexDirection: "row", alignItems: "center", paddingLeft: 16, paddingRight: 12 },
  // Text group shares a BASELINE so the small distance/arrival sit on the same
  // line as the big time instead of floating high against its center.
  barTextRow: { flexDirection: "row", alignItems: "baseline", gap: 12, flexShrink: 1 },
  // Time remaining — big, system green. Distance + arrival sit beside it a notch
  // smaller. No custom fontFamily → renders in the OS system font.
  barTime: { color: "#30D158", fontSize: 24, fontWeight: "800", letterSpacing: -0.4 },
  barMeta: { color: "#808080", fontSize: 16, fontWeight: "600" },
  barExit: {
    marginLeft: "auto",
    width: 60, height: 60, borderRadius: 30,
    backgroundColor: "#B22222",
    borderWidth: 1.5, borderColor: "#000",
    alignItems: "center", justifyContent: "center",
  },
  barExitText: { color: "#F4F4F4", fontSize: 15, fontWeight: "800", letterSpacing: 0.2 },

  // Slide-up step list — sits behind the bar (lower zIndex) so the bar reads as
  // its header when open.
  listPanel: {
    position: "absolute",
    bottom: TAB_BAR_H + BAR_H - 2,
    left: 0, right: 0,
    height: DRAWER_HEIGHT,
    backgroundColor: "rgba(18,18,20,0.98)",
    borderTopLeftRadius: 16,
    borderTopRightRadius: 16,
    zIndex: 199,
    paddingBottom: 12,
  },
  listHandle: { alignItems: "center", paddingVertical: 10 },
  list: { flex: 1, paddingHorizontal: 18 },
  row: {
    flexDirection: "row",
    alignItems: "flex-start",
    paddingVertical: 10,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: "rgba(255,255,255,0.07)",
    gap: 12,
  },
  text: { color: "#F4F4F4", fontSize: 14, fontWeight: "500", flexShrink: 1 },
  dist: { color: "#808080", fontSize: 12, marginTop: 2 },
});
