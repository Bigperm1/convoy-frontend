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
  View, Text, StyleSheet, ScrollView, Animated, PanResponder, Platform,
  useWindowDimensions,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { GlassFill, drawerTint } from "../Glass";
import { LinearGradient } from "expo-linear-gradient";
import { Ionicons, MaterialCommunityIcons } from "@expo/vector-icons";
import { useAccent } from "../appSkin";
import { COLORS } from "../theme";
import { PressableScale } from "../ui/PressableScale";

export const DRAWER_HEIGHT = 300;   // height of the slide-up step list
// Must match the real tab bar in app/(app)/_layout.tsx EXACTLY: height (86 iOS / 84 Android)
// + (Android-only) bottom safe-area inset. iOS adds NO inset there, so we must not either.
const TAB_BAR_H = Platform.OS === 'ios' ? 86 : 84;
const BAR_H = 80;                   // approx height of the collapsed summary bar

// Parse a formatted distance ("42 km", "800 m", "2.2 mi") to meters for the live
// progress bar. Returns null when it can't be parsed.
function metersFromText(s?: string): number | null {
  if (!s) return null;
  const m = s.match(/([\d.]+)\s*(km|mi|ft|m)\b/i);
  if (!m) return null;
  const v = parseFloat(m[1]); const u = m[2].toLowerCase();
  if (u === "km") return v * 1000;
  if (u === "mi") return v * 1609.34;
  if (u === "ft") return v * 0.3048;
  return v; // m
}

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
  onArrived?: () => void;       // candy-orange Arrived button — declares arrival by hand
  // Phone + head unit only: the written-directions face (CarDriveList) has a
  // "Show map" button, but once the driver was on the map there was no way back
  // (Jeff, 8/21 drive to work). When provided, a "Directions" button sits left
  // of End and returns to the list face.
  onShowList?: () => void;
  // ADD STOP, mid-drive (Olaf, 2026-09-19: "would be nice to have a button that stands out
  // to add a stop on the phone screen … hard to find and end up having to just start a new
  // route"). Long-press on the map has always done it; nothing on screen said so.
  onAddStop?: () => void;
  // Live fraction of the route travelled (0..1). Optional precise override; when
  // omitted it's derived from distanceRemaining vs the route total.
  progress?: number;
  // Parent observes visibility transitions so it can clear timers etc.
  onVisibilityChange?: (visible: boolean) => void;
};

const StepDrawer = forwardRef<StepDrawerHandle, Props>(function StepDrawer(
  { route, maneuverIcon, eta, distanceRemaining, arrival, onEnd, onArrived, onShowList, onAddStop, progress, onVisibilityChange },
  ref
) {
  // 0 = step list hidden (tucked behind the bar), 1 = fully open.
  const anim = useRef(new Animated.Value(0)).current;
  const [expanded, setExpanded] = React.useState(false);
  // Match _layout.tsx's tab bar: it adds the bottom safe-area inset on ANDROID ONLY
  // (edge-to-edge nav buttons); iOS bakes the home-indicator room into its fixed 86pt
  // height and adds nothing. Adding insets.bottom on iOS here double-counted the safe
  // area and floated the drawer ~36px above the tab bar (a map sliver showed through).
  const insets = useSafeAreaInsets();
  const navInset = Platform.OS === "android" ? insets.bottom : 0;
  const accent = useAccent();
  // ⛔ EVERY HOOK IN THIS COMPONENT BELONGS ABOVE `if (!route) return null`, which sits a
  // few dozen lines below. This one went under it on 2026-09-20 and the app died two
  // seconds after launch with "Rendered more hooks than during the previous render" —
  // route is null on the first render and not on the next, so the hook count changed.
  // It reads the screen width for the step bar's readout budget (see textBudget).
  const { width: screenW } = useWindowDimensions();

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
  // How many 50pt tiles the right-hand group is about to draw. Two on an ordinary phone
  // drive before Add stop, three after, and four only when a head unit is attached and the
  // driver tapped Show map (that is what hands us onShowList).
  const tileCount = [onAddStop, onShowList, onArrived, onEnd].filter(Boolean).length;
  // WHAT IS LEFT FOR THE READOUTS, in points, from the real style values: barRow's 16+12
  // padding (see styles.barRow) and the tile group's 50n + 10(n−1) (styles.barBtns gap).
  // MEASURED need for the full three — time · distance · arrival: 194pt in SF on iOS,
  // 201dp in Roboto at wght800 on Android (Android is also 18dp poorer to begin with,
  // because its phones are narrower than the 402pt iPhone this was designed on). 200 is
  // that need. Below it the arrival clock steps aside rather than letting BOTH numbers
  // ellipsise into half-numbers — "3.2…" and "10:08…" is worse than one whole readout
  // missing, and the clock is the one you need least at speed (it is on the car screen and
  // the written-directions face anyway). Where it lands: 402pt iPhone keeps all three at
  // three tiles (204) and drops the clock at four (144); a 384dp Android phone (Say Phin,
  // SMSGRC — measured off their own android-auto-canvas rows) drops it at three (186), and
  // so does a 375pt SE/mini (177), which has quietly been overflowing this row for weeks.
  const textBudget = screenW - 28 - (tileCount * 50 + Math.max(0, tileCount - 1) * 10);
  // Compact formatting: drop the space ("25 min" → "25min", "6:24 PM" →
  // "6:24pm") to match the tightened nav bar layout.
  const compact = (s?: string) => (s ?? "").replace(/\s+/g, "");

  // Live trip progress (fraction travelled) for the green progress bar in the
  // collapsed summary. Precise `progress` prop wins; otherwise derive it from the
  // remaining distance vs the route total.
  const totalM = metersFromText(route.distance_text);
  const remM = metersFromText(distanceRemaining);
  const progressFrac =
    progress != null
      ? Math.max(0, Math.min(1, progress))
      : totalM && remM != null && totalM > 0
      ? Math.max(0, Math.min(1, 1 - remM / totalM))
      : null;

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
      <View style={[styles.bar, { bottom: TAB_BAR_H + navInset, borderTopColor: accent }]}>
        {/* Liquid Glass behind the nav bar — clipped to the rounded top. */}
        <GlassFill tintColor={drawerTint()} style={{ borderTopLeftRadius: 16, borderTopRightRadius: 16, overflow: "hidden" }} />
        <View {...openPan.panHandlers} style={styles.barGrabZone} testID="step-drawer-handle">
          <View style={styles.grabPill} />
        </View>
        <View style={styles.barRow}>
          {/* numberOfLines everywhere (2026-09-20): with flexShrink 0 — RN's default, unlike
              the web's — these three could push past their row and render under the tiles on
              a narrow phone. Only the two meta readouts shrink, so the big time-remaining is
              never the thing that truncates. See the width arithmetic on the Add stop tile. */}
          <View style={styles.barTextRow}>
            {/* maxFontSizeMultiplier pins Dynamic Type out of this row (2026-09-20). The
                tiles do not scale with it and barTime deliberately cannot shrink, so at the
                accessibility sizes a 24pt readout would grow until it rendered UNDER them.
                Same lock the pin banner and the new footer buttons use. */}
            <Text style={styles.barTime} numberOfLines={1} maxFontSizeMultiplier={1}>{compact(timeLabel)}</Text>
            {!!distanceRemaining && <Text style={styles.barMeta} numberOfLines={1} maxFontSizeMultiplier={1}>{compact(distanceRemaining)}</Text>}
            {/* The arrival clock steps aside when the row cannot hold all three — see
                textBudget above for the measurement and where it lands on each phone.
                Tiles stay 50x50: that footprint is Jeff's (2026-08-31, matching the logo
                tile), so the text gives ground, not the buttons. */}
            {!!arrival && textBudget >= 200 && <Text style={styles.barMeta} numberOfLines={1} maxFontSizeMultiplier={1}>{compact(arrival).toLowerCase()}</Text>}
          </View>
          {(onShowList || onEnd || onArrived || onAddStop) && (
            /* SIDE BY SIDE (Jeff, 2026-08-31): "place the show map green button to the
               same square and place it right beside the end button." Every tile here is
               mapLogoBacking's exact footprint — 50x50, r14 — so the logo tile and all of
               these read as one family. The row owns marginLeft:auto so they travel
               together against the right edge; previously each button carried its own and
               they fought over the space. Started as a pair; Arrived joined 9/12 and Add
               stop 9/20, which is what the arrival-clock rule above is paying for. */
            <View style={styles.barBtns}>
              {onAddStop && (
                /* ADD STOP — leftmost, so the destructive End stays hard right under the
                   thumb where it has always been. MEASURED on the 16 Pro sim at 3x, not
                   computed: this tile pushes the group's left edge from 282pt to 220pt, so
                   the text budget goes 47pt-of-air → 204pt-for-194pt. It fits, and the
                   fourth tile is what does not — see the arrival-clock rule above, which is
                   where that is paid for. The numberOfLines guards are still the backstop:
                   a long label ellipsises a tail instead of sliding under these tiles. */
                <PressableScale
                  onPress={onAddStop}
                  style={styles.barAddStop}
                  testID="add-stop-nav"
                  hitSlop={6}
                  accessibilityLabel="Add a stop"
                >
                  {/* Candy BLUE, mid-stop COLORS.primary so the app gains no second blue
                      (theme.ts's ACTION discipline: one red, one green). It is the only hue
                      a driver cannot confuse with the green/orange/red beside it — those
                      three are steps along one ramp and are exactly the trio red-green
                      colour blindness collapses. Not a tier colour either (DESIGN.md). */}
                  <LinearGradient
                    colors={["#4AA8FF", COLORS.primary, "#0A4DA0"]}
                    locations={[0, 0.5, 1]}
                    style={[StyleSheet.absoluteFill, { borderRadius: 14 }]}
                  />
                  <GlassFill tintColor={COLORS.primary} style={{ borderRadius: 14, overflow: "hidden" }} />
                  {/* map-marker-plus: a pin with a +, which is literally what the tap does
                      (it arms pin-first Add stop). Verified present in the installed
                      @expo/vector-icons 15.1.1 MaterialCommunityIcons glyphmap. 26 in a
                      50pt tile matches its three neighbours. */}
                  <MaterialCommunityIcons name="map-marker-plus" size={26} color="#04142A" />
                </PressableScale>
              )}
              {onShowList && (
                /* Green twin of End, carrying the classic turn-arrow "directions"
                   glyph — the universal turn-by-turn symbol — so it reads at a glance
                   while driving. Candy green, same three-stop construction as End. */
                <PressableScale
                  onPress={onShowList}
                  style={styles.barTurns}
                  testID="turn-by-turn"
                  hitSlop={6}
                  accessibilityLabel="Turn-by-turn directions"
                >
                  <LinearGradient
                    colors={["#3DFF9A", "#1FC96E", "#0E8F4C"]}
                    locations={[0, 0.5, 1]}
                    style={[StyleSheet.absoluteFill, { borderRadius: 14 }]}
                  />
                  <GlassFill tintColor="#1FC96E" style={{ borderRadius: 14, overflow: "hidden" }} />
                  {/* 26 in a 50pt tile keeps the glyph's optical weight from the 32-in-60
                      circle it replaced (0.52 vs 0.53 of the box). */}
                  <MaterialCommunityIcons name="directions" size={26} color="#04150B" />
                </PressableScale>
              )}
              {onArrived && (
                /* ARRIVED (Jeff, 2026-09-12) — candy ORANGE, between the green directions tile
                   and red End, exactly as he placed it. Same 50x50 r14 candy construction as its
                   two neighbours: bright->deep gradient with a tinted GlassFill refracting it.
                   It exists because arrival DETECTION can miss — on his 09-12 commute the engine
                   never saw him stop, so a 33 km drive ended in silence and he worked around it
                   by parking 60 m short and walking in. This declares it. */
                <PressableScale
                  onPress={onArrived}
                  style={styles.barArrived}
                  testID="arrived-nav"
                  hitSlop={6}
                  accessibilityLabel="I have arrived"
                >
                  <LinearGradient
                    colors={["#FFB03B", "#FF8A00", "#C25E00"]}
                    locations={[0, 0.5, 1]}
                    style={[StyleSheet.absoluteFill, { borderRadius: 14 }]}
                  />
                  <GlassFill tintColor="#FF8A00" style={{ borderRadius: 14, overflow: "hidden" }} />
                  <MaterialCommunityIcons name="flag-checkered" size={26} color="#2A1200" />
                </PressableScale>
              )}
              {onEnd && (
                /* hitSlop 0: End had none, and 10 pt from Arrived a default slop would hand Arrived's
                   right edge to End (the later sibling wins the overlap). Jeff, 2026-09-23: Apple-feel batch 1. */
                <PressableScale onPress={onEnd} style={styles.barExit} hitSlop={0} testID="end-nav">
                  {/* Candy-apple: a glossy red gradient base (bright top -> deep bottom)
                      gives real candy dimension, and a red-tinted GlassFill on top
                      refracts THAT gradient (not the dark map) for a liquid-glass sheen.
                      Both clipped to the tile's r14. */}
                  <LinearGradient
                    colors={["#FF3B5C", "#E4002B", "#B00020"]}
                    locations={[0, 0.5, 1]}
                    style={[StyleSheet.absoluteFill, { borderRadius: 14 }]}
                  />
                  <GlassFill tintColor="#E4002B" style={{ borderRadius: 14, overflow: "hidden" }} />
                  {/* "End", not "Exit" (Jeff, 2026-08-16) — one verb across phone,
                      CarPlay and AA for the same action. */}
                  <Text style={styles.barExitText}>End</Text>
                </PressableScale>
              )}
            </View>
          )}
          </View>
        {progressFrac != null && (
          <View style={styles.progressTrack}>
            <View style={[styles.progressFill, { width: `${progressFrac * 100}%`, backgroundColor: accent }]} />
            <View style={[styles.progressTip, { left: `${progressFrac * 100}%` }]}>
              <Ionicons name="caret-forward" size={16} color={accent} />
            </View>
          </View>
        )}
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
    backgroundColor: "transparent",
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
  // minWidth 0 lets the row actually give ground when the tile group grows; without it
  // a flexShrink parent still reports its content's intrinsic width as the floor.
  barTextRow: { flexDirection: "row", alignItems: "baseline", gap: 12, flexShrink: 1, minWidth: 0 },
  // Time remaining — big, system green. Distance + arrival sit beside it a notch
  // smaller. No custom fontFamily → renders in the OS system font.
  // barTime deliberately carries NO flexShrink: the number you read at speed keeps its
  // width and the two meta readouts give theirs up first.
  barTime: { color: "#30D158", fontSize: 24, fontWeight: "800", letterSpacing: -0.4 },
  barMeta: { color: "#F4F4F4", fontSize: 16, fontWeight: "600", flexShrink: 1 },
  barExit: {
    width: 50, height: 50, borderRadius: 14,
    // Color comes from the candy-red LinearGradient child; keep the container
    // transparent + clip so the gradient + glass render as a clean red circle.
    backgroundColor: "transparent",
    overflow: "hidden",
    borderWidth: 1, borderColor: "rgba(255,90,120,0.9)",
    alignItems: "center", justifyContent: "center",
  },
  // Same footprint as barExit / barTurns / barArrived — the four tiles must read as one
  // family; only the paint and the glyph change.
  barAddStop: {
    width: 50, height: 50, borderRadius: 14,
    backgroundColor: "transparent",
    overflow: "hidden",
    borderWidth: 1, borderColor: "rgba(120,190,255,0.9)",
    alignItems: "center", justifyContent: "center",
  },
  // Same footprint as barExit / barTurns — the three tiles must read as one family.
  barArrived: {
    width: 50, height: 50, borderRadius: 14,
    // Color comes from the candy-ORANGE LinearGradient child; keep the container
    // transparent + clip so the gradient + glass render as one clean tile.
    backgroundColor: "transparent",
    overflow: "hidden",
    borderWidth: 1, borderColor: "rgba(255,190,110,0.95)",
    alignItems: "center", justifyContent: "center",
  },
  barExitText: { color: "#F4F4F4", fontSize: 15, fontWeight: "800", letterSpacing: 0.2 },
  // "Directions" pill left of End — same glass language, green-tinted so it reads
  // as "go somewhere" next to the red stop. Pushed right with the End circle.
  // Turn-by-turn circle left of End — same candy construction in green. It takes
  // the marginLeft:auto so the pair sits flush right; End keeps its own as a
  // no-op when both are present.
  // ── SQUARE, NOT ROUND (Jeff, 2026-08-31) ──────────────────────────────────
  // "make it the same square look as the top logo shape… and place it right beside
  // the end button." 50x50 r14 is not a fresh choice — it is mapLogoBacking's exact
  // footprint (map.tsx), which CarDriveList's End square already copied on 8/16. So
  // all three tiles on the phone are now literally the same object in different
  // paint, which is the whole point of a shape language.
  // marginLeft:auto moved to the ROW that holds both, so the pair travels together
  // instead of the green one shoving the red one around.
  barTurns: {
    width: 50, height: 50, borderRadius: 14,
    backgroundColor: "transparent", overflow: "hidden",
    borderWidth: 1, borderColor: "rgba(120,255,180,0.9)",
    alignItems: "center", justifyContent: "center",
  },
  // Holds the pair, hard right, with the gap between them.
  barBtns: { marginLeft: "auto", flexDirection: "row", alignItems: "center", gap: 10 },

  // Live distance-travelled bar under the summary row: faint full-width track,
  // green fill to the current progress, green arrow tip at the leading edge.
  progressTrack: {
    height: 3, borderRadius: 2,
    backgroundColor: "rgba(255,255,255,0.12)",
    marginTop: 9, marginHorizontal: 16,
    position: "relative",
  },
  progressFill: {
    position: "absolute", left: 0, top: 0, bottom: 0,
    backgroundColor: "#2DEC86", borderRadius: 2,
  },
  progressTip: {
    position: "absolute", top: -7, marginLeft: -8,
    alignItems: "center", justifyContent: "center",
  },

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
  dist: { color: "#E5E5EA", fontSize: 12, marginTop: 2 },
});
