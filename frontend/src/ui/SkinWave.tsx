// ui/SkinWave.tsx — how a skinned element takes part in the unlock wave (src/skinWave.ts).
//
//   SkinFade      an element whose look is BAKED per metal (the H tile, the tab glyphs, the map's 2D/3D and Crew art, a
//                 gradient fill): it draws the new metal as a second layer on top and fades it in when the band reaches
//                 it. `render(metal)` must draw the element for any metal.
//   useWaveMetal  a plain colour (an icon tint, a label): the metal to paint with — the old one until the band crosses
//                 `y`, the new one from then on. The band's highlight passes over the moment it turns.
//   WaveWipe      the full-screen wallpaper: the new road is wiped in from the top in step with the band.
//
// Outside a wave every one of these is exactly the element as it was: one layer, the metal in force (useAppSkin).

import React, { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { Dimensions, StyleSheet, View, useWindowDimensions, type StyleProp, type ViewStyle } from "react-native";
import Animated, {
  Easing, ReduceMotion, useAnimatedStyle, useSharedValue, withDelay, withTiming,
} from "react-native-reanimated";
import { useAppSkin } from "../appSkin";
import type { VisualTier } from "../tierTheme";
import { MOTION } from "../motion";
import { WAVE, useSkinWave, waveReachMs, type SkinWave } from "../skinWave";

/** Where this element sits on screen, 0 (top) … 1 (bottom), measured on layout — when the band will reach it. */
export function useWaveY(fallback = 0.5): { ref: React.RefObject<View | null>; y: React.MutableRefObject<number>; onLayout: () => void } {
  const ref = useRef<View | null>(null);
  const y = useRef(fallback);
  const onLayout = useCallback(() => {
    ref.current?.measureInWindow((_x, top, _w, h) => {
      const H = Dimensions.get("window").height || 1;
      if (Number.isFinite(top) && Number.isFinite(h)) y.current = Math.max(0, Math.min(1, (top + h / 2) / H));
    });
  }, []);
  return { ref, y, onLayout };
}

/** The metal a plain colour should wear at screen height `y` (0 = top … 1 = bottom): the old metal until the band
 *  crosses it, then the new one. Outside a wave, the metal in force. */
export function useWaveMetal(y: number): VisualTier {
  const worn = useAppSkin();
  const wave = useSkinWave();
  const [passed, setPassed] = useState<number | null>(null);
  useEffect(() => {
    if (!wave) return;
    const at = wave.t0 + waveReachMs(y, wave.reduce) - Date.now();
    if (at <= 0) { setPassed(wave.id); return; }
    const t = setTimeout(() => setPassed(wave.id), at);
    return () => clearTimeout(t);
    // One timer per wave; a re-measured y mid-wave does not restart it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [wave?.id]);
  if (!wave) return worn;
  if (wave.phase === "settle") return wave.to;
  return passed === wave.id ? wave.to : wave.from;
}

/** The metal a layered element draws UNDER the reveal. */
function baseMetal(worn: VisualTier, wave: SkinWave | null): VisualTier {
  if (!wave) return worn;
  return wave.phase === "run" ? wave.from : wave.to;
}

/** The new-metal layer: mounts at opacity 0, fades in when the band reaches `y`. Keyed by the wave, so it survives the
 *  run → settle hand-over and never re-runs. */
function Reveal({ wave, y, children }: { wave: SkinWave; y: number; children: ReactNode }) {
  const op = useSharedValue(wave.phase === "settle" ? 1 : 0);
  useEffect(() => {
    if (wave.phase === "settle") return;
    const delay = Math.max(0, wave.t0 - Date.now()) + waveReachMs(y, wave.reduce);
    const duration = wave.reduce ? WAVE.reduceReveal : WAVE.reveal;
    op.set(withDelay(delay, withTiming(1, { duration, easing: MOTION.ease.out, reduceMotion: ReduceMotion.Never })));
    // Mount-once by design (keyed by wave.id): the phase change must not restart the fade.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const st = useAnimatedStyle(() => ({ opacity: op.get() }));
  return (
    <Animated.View pointerEvents="none" style={[StyleSheet.absoluteFill, st]}>
      {children}
    </Animated.View>
  );
}

/**
 * A baked-per-metal element that turns with the wave. `style` is the box's layout (it wraps the element); `y` pins the
 * screen height instead of measuring it (the tab bar: 0.94). Outside a wave it is exactly `render(metal in force)`.
 */
export function SkinFade({
  render, style, y: fixedY, pointerEvents,
}: {
  render: (metal: VisualTier) => ReactNode;
  style?: StyleProp<ViewStyle>;
  y?: number;
  pointerEvents?: "box-none" | "none" | "box-only" | "auto";
}) {
  const worn = useAppSkin();
  const wave = useSkinWave();
  const { ref, y, onLayout } = useWaveY();
  const layered = !!wave && wave.from !== wave.to;
  return (
    <View ref={ref} onLayout={fixedY === undefined ? onLayout : undefined} style={style} pointerEvents={pointerEvents} collapsable={false}>
      {render(layered ? baseMetal(worn, wave) : worn)}
      {layered ? (
        <Reveal key={wave!.id} wave={wave!} y={fixedY ?? y.current}>{render(wave!.to)}</Reveal>
      ) : null}
    </View>
  );
}

/** The wallpaper's reveal: a clip box sliding down from above the screen while its content slides the other way, so the
 *  new road is uncovered top-down exactly as fast as the band travels. Transforms only. */
function WipeIn({ wave, children }: { wave: SkinWave; children: ReactNode }) {
  const { height: H } = useWindowDimensions();
  const settled = wave.phase === "settle";
  const p = useSharedValue(settled ? 1 : 0);
  useEffect(() => {
    if (settled) return;
    const delay = Math.max(0, wave.t0 - Date.now());
    p.set(withDelay(delay, withTiming(1, {
      duration: wave.reduce ? WAVE.reduceReveal : WAVE.sweep,
      easing: wave.reduce ? MOTION.ease.out : Easing.linear,
      reduceMotion: ReduceMotion.Never,
    })));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const outer = useAnimatedStyle(() => (wave.reduce
    ? { opacity: p.get() }
    : { transform: [{ translateY: (p.get() - 1) * H }] }));
  const inner = useAnimatedStyle(() => (wave.reduce ? {} : { transform: [{ translateY: (1 - p.get()) * H }] }));
  return (
    <Animated.View pointerEvents="none" style={[StyleSheet.absoluteFill, { overflow: "hidden" }, outer]}>
      <Animated.View style={[StyleSheet.absoluteFill, inner]}>{children}</Animated.View>
    </Animated.View>
  );
}

/** A full-screen, per-metal background (GlassBackdrop) that wipes to the new metal with the band. */
export function WaveWipe({ render }: { render: (metal: VisualTier) => ReactNode }) {
  const worn = useAppSkin();
  const wave = useSkinWave();
  const layered = !!wave && wave.from !== wave.to;
  return (
    <View pointerEvents="none" style={StyleSheet.absoluteFill}>
      {render(layered ? baseMetal(worn, wave) : worn)}
      {layered ? <WipeIn key={wave!.id} wave={wave!}>{render(wave!.to)}</WipeIn> : null}
    </View>
  );
}
