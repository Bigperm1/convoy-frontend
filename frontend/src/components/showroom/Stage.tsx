// showroom/Stage.tsx — the Showroom stage (2026-09-22; the approved design, "The Showroom").
//
// A dark stage with a soft overhead light, a light cone and an oval turntable, all in the page's metal;
// today's car turns on it and the member's other cars peek, dimmed, at the edges.
//
// HOW IT IS BUILT — three layers, bottom to top:
//   1. the set (SVG: glow, cone, turntable) and the light bar — fixed, it never scrolls;
//   2. the cars — one absolutely placed layer per slot, driven off the swipe position (translate, scale,
//      opacity), so a neighbour can peek at the edge at a SMALLER size than the car on the turntable,
//      which a plain paging ScrollView of full-width pages cannot draw;
//   3. an invisible full-width paging ScrollView on top that owns every touch. The live 3D car (a
//      WebView) therefore sits UNDER the swipe layer and can never win a horizontal drag — the trap
//      GarageHeroCarousel solved by making the model non-interactive; here it is also structural.
//
// SWIPING ONLY PREVIEWS. Settling on a car never switches it (GarageHeroCarousel switched on landing on
// an owned page); "Drive this today" does. A locked spot never opens the paywall on a swipe either —
// only a deliberate tap or its button.

import React, { useCallback, useEffect, useRef, useState } from "react";
import {
  Animated,
  StyleSheet,
  Text,
  TouchableWithoutFeedback,
  View,
  useWindowDimensions,
  type NativeScrollEvent,
  type NativeSyntheticEvent,
  type ScrollView,
  type ViewStyle,
} from "react-native";
import Svg, { Defs, Ellipse, LinearGradient as SvgLinearGradient, Polygon, RadialGradient, Rect, Stop } from "react-native-svg";
import { LinearGradient } from "expo-linear-gradient";
import { Ionicons } from "@expo/vector-icons";
import * as Haptics from "expo-haptics";
// Reanimated for the press scale only; the scroll-driven layers stay on core Animated's native driver.
import Reanimated from "react-native-reanimated";
import { skin, type VisualTier } from "../../tierTheme";
import SkinSheen from "../SkinSheen";
import { MOTION } from "../../motion";
import { useReduceMotion } from "../../motionPrefs";
import type { GarageTier } from "../../garageCars";
import { garageMetal, TIER_WORD } from "./tier";

export const STAGE_H = 400;
/** Where the turntable sits (its centre line) — every car is placed to stand on it. */
export const TURNTABLE_Y = 332;
/** The turntable's half-width and half-height, about (W / 2, TURNTABLE_Y). The light cone's foot is its
 *  widest points. */
const TABLE_RX = 150;
const TABLE_RY = 32;
/** The overhead light — the SOURCE the cone hangs from: half the approved design's 220 pt bar (Jeff,
 *  2026-09-23: "make the light source smaller"). Round-ended, radius LIGHT_H / 2. */
const LIGHT_W = 110;
const LIGHT_H = 6;
const LIGHT_TOP = 10;

export type StageSlot = {
  key: string;
  /** 'car' = an owned car; 'locked' = the next tier's preview; 'add' = Ultra's "+ Scan a car". */
  type: "car" | "locked" | "add";
};

type StageWords = { pill: string; pillMetal: VisualTier; name: string; sub: string };
type NoWords = { pill?: undefined; pillMetal?: undefined; name?: undefined; sub?: undefined };

/** What the stage says about the centred spot. `tier` is always there: the chip at top-RIGHT naming the
 *  rung the spot belongs to, in that rung's metal (Jeff, 2026-09-23: "on the right side of the screen
 *  (across from 'in your garage') should have the tier with matching colour. so we know what tier it
 *  is"). The words — the top-left pill, the name, the line under it — are left out on a spot whose art
 *  carries its own ("+ Scan a car", a scan still building). */
export type StageLabels = { tier: GarageTier } & (StageWords | NoWords);

/** Stand a car on the turntable: a box of the given size whose bottom edge sits `lift` above the
 *  turntable's centre line, centred across the stage. */
export function CarBox({ width, height, lift = 0, children }: {
  width: number; height: number; lift?: number; children: React.ReactNode;
}) {
  return (
    <View
      pointerEvents="none"
      style={{
        position: "absolute",
        top: TURNTABLE_Y + 14 - lift - height,
        left: 0,
        right: 0,
        height,
        alignItems: "center",
        justifyContent: "flex-end",
      }}
    >
      <View style={{ width, height, alignItems: "center", justifyContent: "flex-end" }}>{children}</View>
    </View>
  );
}

export default function Stage({
  slots,
  index,
  onIndexChange,
  onTapCentre,
  centreTappable = true,
  metal,
  labels,
  renderSlot,
  renderBadge,
  overlay,
}: {
  slots: StageSlot[];
  /** The settled, centred slot. */
  index: number;
  onIndexChange: (i: number) => void;
  onTapCentre: () => void;
  /** False when a tap on the centred slot does nothing (a car with no 3D spin), so it gets no press
   *  feedback either — a press response promises an action. Default true. */
  centreTappable?: boolean;
  /** The page metal: light, cone, turntable ring, the active dot. */
  metal: VisualTier;
  /** The words and the tier chip for the centred slot; null hides them all. */
  labels: StageLabels | null;
  /** The slot's visual. `centred` is true only for the settled slot — the only one allowed to go live. */
  renderSlot: (slot: StageSlot, i: number, centred: boolean) => React.ReactNode;
  /** Optional mark that travels WITH a slot but is not dimmed with it — the lock H on the next tier's
   *  spot, which has to stay legible while the car behind it is a dim preview. */
  renderBadge?: (slot: StageSlot, i: number, centred: boolean) => React.ReactNode;
  /** Drawn over everything (the one-shot "your car is built" card). */
  overlay?: React.ReactNode;
}) {
  const { width: W } = useWindowDimensions();
  const sk = skin(metal);
  const glowHex = metal === "brand" ? sk.accent : sk.colors[0];

  const pager = useRef<ScrollView>(null);
  const scrollX = useRef(new Animated.Value(index * W)).current;
  const lastSettled = useRef(index);

  // Press feedback on the centred car (Jeff, 2026-09-23: Apple-feel batch 1; DESIGN.md §11.5). The touch
  // lands on the invisible pager page, so the page reports press-in/out and an INNER layer of the car
  // scales — never the scroll-driven layer, whose transform belongs to the swipe. Under Reduce Motion
  // there is no scale and no tint: the tint would be a full-width band across the stage, and the tap's
  // own result (paywall, scan, 3D viewer) answers at once.
  const reduce = useReduceMotion();
  const [pressedSlot, setPressedSlot] = useState<number | null>(null);

  // Follow an index change made OUTSIDE a swipe (the list changed under the centred car, or the page
  // re-centred on a new car). A settle we just reported is already where we are — no scroll fight.
  useEffect(() => {
    if (lastSettled.current === index) return;
    lastSettled.current = index;
    pager.current?.scrollTo({ x: index * W, animated: false });
  }, [index, W]);

  const onMomentumEnd = useCallback((e: NativeSyntheticEvent<NativeScrollEvent>) => {
    const i = Math.max(0, Math.min(slots.length - 1, Math.round(e.nativeEvent.contentOffset.x / W)));
    if (i !== lastSettled.current) {
      lastSettled.current = i;
      Haptics.selectionAsync();
      onIndexChange(i);
    }
  }, [W, slots.length, onIndexChange]);

  // Neighbour geometry, matched to the approved drawing at 390 pt: a neighbour's centre sits ~187 pt
  // out (0.48 of the width), drawn at ~60% size and ~35% opacity; two out it is gone.
  const PEEK = W * 0.48;

  // The light (Jeff, 2026-09-23: "make the light source smaller and the light fan out to the edges of the
  // circle. make sure the light effect is not outside the light source when it touches the light like it
  // currently is"). ONE shape carries all of it — the cone — hung from the bar and fanned out to the
  // turntable; the glow is painted inside that shape only, and the bar has no halo, so nothing lights the
  // stage above or beside the source.
  //   top  — the bar's straight bottom edge. Its ends are round, so on y = barBottom it is LIGHT_W − LIGHT_H
  //          wide; a cone any wider would show beside the round ends, right where the light leaves the bar.
  //   foot — the turntable's widest points, W / 2 ± TABLE_RX on TURNTABLE_Y.
  const cx = W / 2;
  const barBottom = LIGHT_TOP + LIGHT_H;
  const coneTopHalf = (LIGHT_W - LIGHT_H) / 2;
  const cone =
    `${cx - coneTopHalf},${barBottom} ${cx + coneTopHalf},${barBottom} ` +
    `${cx + TABLE_RX},${TURNTABLE_Y} ${cx - TABLE_RX},${TURNTABLE_Y}`;

  return (
    <View style={[styles.stage, { height: STAGE_H }]}>
      {/* 1 · the set */}
      <View style={StyleSheet.absoluteFill} pointerEvents="none">
      <Svg width={W} height={STAGE_H}>
        <Defs>
          {/* Centred on the source and reaching the turntable, so the light is brightest where it leaves
              the bar; it only ever fills the cone. */}
          <RadialGradient id="stageGlow" cx={cx} cy={barBottom} r={TURNTABLE_Y - barBottom} gradientUnits="userSpaceOnUse">
            <Stop offset="0" stopColor={glowHex} stopOpacity={0.14} />
            <Stop offset="0.55" stopColor={glowHex} stopOpacity={0} />
          </RadialGradient>
          {/* objectBoundingBox: bar → turntable. It ends faint, not at nothing, so the cone's edges still
              read where they meet the table's rim. */}
          <SvgLinearGradient id="stageCone" x1="0" y1="0" x2="0" y2="1">
            <Stop offset="0" stopColor={sk.accent} stopOpacity={0.1} />
            <Stop offset="1" stopColor={sk.accent} stopOpacity={0.035} />
          </SvgLinearGradient>
          {/* objectBoundingBox (the default): the gradient stretches to the ellipse it fills */}
          <RadialGradient id="stageTable" cx="50%" cy="50%" r="50%">
            <Stop offset="0" stopColor="#12161B" stopOpacity={1} />
            <Stop offset="1" stopColor="#0B0C0E" stopOpacity={1} />
          </RadialGradient>
          <RadialGradient id="stageShadow" cx="50%" cy="50%" r="50%">
            <Stop offset="0" stopColor="#000000" stopOpacity={0.7} />
            <Stop offset="1" stopColor="#000000" stopOpacity={0} />
          </RadialGradient>
        </Defs>
        <Rect x={0} y={0} width={W} height={STAGE_H} fill="#0B0C0E" />
        <Polygon points={cone} fill="url(#stageCone)" />
        <Polygon points={cone} fill="url(#stageGlow)" />
        {/* the light source: its bottom edge is the cone's top */}
        <Rect x={cx - LIGHT_W / 2} y={LIGHT_TOP} width={LIGHT_W} height={LIGHT_H} rx={LIGHT_H / 2} fill="#F4FDFF" fillOpacity={0.8} />
        {/* the turntable's soft glow, then the table, then the shadow the car throws on it */}
        <Ellipse cx={W / 2} cy={TURNTABLE_Y} rx={156} ry={37} fill="none" stroke={sk.accent} strokeOpacity={0.08} strokeWidth={8} />
        <Ellipse cx={W / 2} cy={TURNTABLE_Y} rx={TABLE_RX} ry={TABLE_RY} fill="url(#stageTable)" stroke={sk.accent} strokeOpacity={0.55} strokeWidth={1} />
        <Ellipse cx={W / 2} cy={TURNTABLE_Y - 3} rx={130} ry={13} fill="url(#stageShadow)" />
      </Svg>
      </View>

      {/* 2 · the cars — the centred one drawn LAST, so it sits over its neighbours (in list order the next
          spot painted across a wide car's tail — the 3D class still, 2026-09-22); then the lock marks, over
          every car */}
      {(() => {
        const near = slots
          .map((slot, i) => ({ slot, i }))
          .filter(({ i }) => Math.abs(i - index) <= 2);
        const anim = (i: number) => {
          const inputRange = [(i - 2) * W, (i - 1) * W, i * W, (i + 1) * W, (i + 2) * W];
          return {
            translateX: scrollX.interpolate({
              inputRange,
              outputRange: [PEEK * 2, PEEK, 0, -PEEK, -PEEK * 2],
              extrapolate: "extend",
            }),
            scale: scrollX.interpolate({ inputRange, outputRange: [0.5, 0.6, 1, 0.6, 0.5], extrapolate: "clamp" }),
            opacity: scrollX.interpolate({ inputRange, outputRange: [0, 0.36, 1, 0.36, 0], extrapolate: "clamp" }),
            badgeOpacity: scrollX.interpolate({ inputRange, outputRange: [0, 1, 1, 1, 0], extrapolate: "clamp" }),
          };
        };
        const drawOrder = [...near.filter(({ i }) => i !== index), ...near.filter(({ i }) => i === index)];
        return (
          <>
            {drawOrder.map(({ slot, i }) => {
              const a = anim(i);
              return (
                <Animated.View
                  key={slot.key}
                  pointerEvents="none"
                  style={[StyleSheet.absoluteFill, { opacity: a.opacity, transform: [{ translateX: a.translateX }, { scale: a.scale }] }]}
                >
                  {/* Every slot gets this layer, so a slot never remounts (the live 3D car is a WebView)
                      when it becomes the centred one. It shrinks toward the turntable, so the car stays
                      planted instead of lifting off it. */}
                  <Reanimated.View
                    style={[
                      StyleSheet.absoluteFill,
                      pressLayer,
                      { transform: [{ scale: pressedSlot === i && !reduce ? MOTION.press.scale : 1 }] },
                    ]}
                  >
                    {renderSlot(slot, i, i === index)}
                  </Reanimated.View>
                </Animated.View>
              );
            })}
            {near.map(({ slot, i }) => {
              const badge = renderBadge?.(slot, i, i === index);
              if (!badge) return null;
              const a = anim(i);
              return (
                <Animated.View
                  key={`${slot.key}:badge`}
                  pointerEvents="none"
                  style={[StyleSheet.absoluteFill, { opacity: a.badgeOpacity, transform: [{ translateX: a.translateX }, { scale: a.scale }] }]}
                >
                  {/* The lock mark dips with its car, so the two stay one object under the finger. */}
                  <Reanimated.View
                    style={[
                      StyleSheet.absoluteFill,
                      pressLayer,
                      { transform: [{ scale: pressedSlot === i && !reduce ? MOTION.press.scale : 1 }] },
                    ]}
                  >
                    {badge}
                  </Reanimated.View>
                </Animated.View>
              );
            })}
          </>
        );
      })()}

      {/* 3 · the swipe layer */}
      <Animated.ScrollView
        ref={pager}
        horizontal
        pagingEnabled
        showsHorizontalScrollIndicator={false}
        style={StyleSheet.absoluteFill}
        contentOffset={{ x: index * W, y: 0 }}
        onScroll={Animated.event([{ nativeEvent: { contentOffset: { x: scrollX } } }], { useNativeDriver: true })}
        scrollEventThrottle={16}
        // A swipe starts with a touch on the centred page; let go of its press the moment the pager
        // takes the gesture, so a swipe never begins with the car dipping.
        onScrollBeginDrag={() => setPressedSlot(null)}
        onMomentumScrollEnd={onMomentumEnd}
        onLayout={() => {
          // contentOffset is an initial value only, and Android has not always honoured it — put the
          // centred car in the middle once the pager has a size.
          pager.current?.scrollTo({ x: lastSettled.current * W, animated: false });
        }}
        accessibilityLabel="Your cars — swipe to look at each one"
      >
        {slots.map((slot, i) => (
          <TouchableWithoutFeedback
            key={slot.key}
            onPressIn={() => { if (i === lastSettled.current && centreTappable) setPressedSlot(i); }}
            onPressOut={() => setPressedSlot(null)}
            onPress={() => { if (i === lastSettled.current) onTapCentre(); }}
            accessibilityRole="button"
          >
            <View style={{ width: W, height: STAGE_H }} />
          </TouchableWithoutFeedback>
        ))}
      </Animated.ScrollView>

      {/* the words for the centred car */}
      {labels ? (
        <View style={styles.labels} pointerEvents="none">
          {/* one row: the pill at left, the spot's tier across from it at right */}
          <View style={styles.pillRow}>
            {labels.pill !== undefined ? <MetalPill text={labels.pill} metal={labels.pillMetal} /> : null}
            <MetalPill text={TIER_WORD[labels.tier]} metal={garageMetal(labels.tier)} style={styles.tierPill} />
          </View>
          {labels.name !== undefined ? (
            <>
              <Text style={styles.name} numberOfLines={1} adjustsFontSizeToFit minimumFontScale={0.7}>{labels.name}</Text>
              <Text style={styles.sub} numberOfLines={2}>{labels.sub}</Text>
            </>
          ) : null}
        </View>
      ) : null}

      {/* page dots: the active one is a metal capsule; the locked spot is a lock, the scan spot a plus */}
      <View style={styles.dots} pointerEvents="none">
        {slots.map((slot, i) => {
          if (slot.type === "locked") {
            return <Ionicons key={slot.key} name="lock-closed" size={10} color={i === index ? sk.accent : "rgba(244,253,255,0.5)"} />;
          }
          if (slot.type === "add") {
            return <Ionicons key={slot.key} name="add" size={12} color={i === index ? sk.accent : "rgba(244,253,255,0.5)"} />;
          }
          return (
            <View
              key={slot.key}
              style={[styles.dot, i === index && { width: 18, backgroundColor: sk.accent }]}
            />
          );
        })}
      </View>

      {overlay}
    </View>
  );
}

/** A pill in a metal. The stage's two pills are this one component, so they share one height, one
 *  gradient and one sheen (the diamond's facets included). */
function MetalPill({ text, metal, style }: { text: string; metal: VisualTier; style?: ViewStyle }) {
  const pk = skin(metal);
  return (
    <LinearGradient colors={pk.colors} locations={pk.locations} style={[styles.pill, { borderColor: pk.rim }, style]}>
      <SkinSheen sk={pk} />
      <Text style={[styles.pillText, { color: pk.ink }]}>{text}</Text>
    </LinearGradient>
  );
}

// MOTION.press on the centred car: the transition from the one table, the origin on the turntable.
// Outside StyleSheet.create, whose types do not know Reanimated's CSS transition keys.
const pressLayer = {
  transformOrigin: ["50%", TURNTABLE_Y, 0] as (string | number)[],
  transitionProperty: "transform" as const,
  transitionDuration: MOTION.press.durationCss,
  transitionTimingFunction: MOTION.ease.outCss,
};

const styles = StyleSheet.create({
  stage: { width: "100%", backgroundColor: "#0B0C0E", overflow: "hidden" },
  labels: { position: "absolute", left: 20, top: 26, right: 20, alignItems: "flex-start", gap: 6 },
  pillRow: { alignSelf: "stretch", flexDirection: "row", alignItems: "center" },
  // Pushed to the row's right end whether or not a pill sits at its left.
  tierPill: { marginLeft: "auto" },
  pill: {
    height: 22,
    paddingHorizontal: 10,
    borderRadius: 11,
    borderWidth: 1,
    justifyContent: "center",
    overflow: "hidden",
  },
  pillText: { fontSize: 10, fontWeight: "800", letterSpacing: 1.5 },
  name: { color: "#F4FDFF", fontSize: 32, fontWeight: "800", lineHeight: 34, maxWidth: "92%" },
  sub: { color: "#8FA6B8", fontSize: 14, maxWidth: "92%" },
  dots: {
    position: "absolute",
    left: 0,
    right: 0,
    bottom: 12,
    flexDirection: "row",
    justifyContent: "center",
    alignItems: "center",
    gap: 8,
  },
  dot: { width: 6, height: 6, borderRadius: 3, backgroundColor: "rgba(244,253,255,0.28)" },
});
