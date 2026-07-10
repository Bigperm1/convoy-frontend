// ListeningEdgeGlow.tsx — Siri-style screen-edge glow while Scout is listening.
//
// Four green LinearGradient strips bleed in from the screen edges and BREATHE
// (opacity pulse) while active, echoing the iOS-26 assistant activation look —
// drawn entirely with our own gradients (no system/private APIs). A master
// `vis` value fades the whole thing in on mic-open and dissolves it on release.
// pointerEvents="none" everywhere so it can never block a tap.
//
// Two ways to drive it:
//   • <ListeningEdgeGlow active={bool} />      — direct (CarPlay surface uses
//     carStore.scoutListening).
//   • <GlobalListeningGlow />                  — self-contained; subscribes to
//     the module-level glow bus below. Mounted once in app/(app)/_layout.tsx.
//     useVoice flips the bus in start()/stop(), so EVERY Scout listening path
//     (Comms hold-to-talk, CarPlay mic button) lights the phone edges for free.
import React, { useEffect, useRef, useState } from "react";
import { Animated, Easing, StyleSheet, View } from "react-native";
import { LinearGradient } from "expo-linear-gradient";

const GREEN = "#2DEC86";
const EDGE = 110;            // how far the glow bleeds in from each edge (px)
const PULSE_MS = 1500;       // one breathe direction (in or out)

// ---- glow bus (module-level, same Set pattern as voiceBus) ----
type Listener = (on: boolean) => void;
const listeners = new Set<Listener>();
let glowOn = false;
export function setListeningGlow(on: boolean) {
  glowOn = on;
  listeners.forEach((fn) => { try { fn(on); } catch {} });
}
export function subscribeListeningGlow(fn: Listener): () => void {
  listeners.add(fn);
  return () => { listeners.delete(fn); };
}

export function ListeningEdgeGlow({ active }: { active: boolean }) {
  const vis = useRef(new Animated.Value(0)).current;    // master fade in/out
  const pulse = useRef(new Animated.Value(1)).current;  // breathing loop
  const [mounted, setMounted] = useState(active);       // unmount when fully faded

  useEffect(() => {
    let loop: Animated.CompositeAnimation | null = null;
    if (active) {
      setMounted(true);
      Animated.timing(vis, { toValue: 1, duration: 220, useNativeDriver: true }).start();
      loop = Animated.loop(
        Animated.sequence([
          Animated.timing(pulse, { toValue: 0.55, duration: PULSE_MS, easing: Easing.inOut(Easing.sin), useNativeDriver: true }),
          Animated.timing(pulse, { toValue: 1, duration: PULSE_MS, easing: Easing.inOut(Easing.sin), useNativeDriver: true }),
        ]),
      );
      loop.start();
    } else {
      Animated.timing(vis, { toValue: 0, duration: 350, useNativeDriver: true }).start(({ finished }) => {
        if (finished) setMounted(false);
      });
    }
    return () => { loop?.stop(); };
  }, [active, vis, pulse]);

  if (!mounted) return null;
  const opacity = Animated.multiply(vis, pulse);
  const c = [`${GREEN}8C`, `${GREEN}33`, `${GREEN}00`] as const; // 55% → 20% → 0
  return (
    <Animated.View pointerEvents="none" style={[styles.fill, { opacity }]}>
      <LinearGradient colors={c} start={{ x: 0.5, y: 0 }} end={{ x: 0.5, y: 1 }} style={[styles.edge, { top: 0, left: 0, right: 0, height: EDGE }]} />
      <LinearGradient colors={c} start={{ x: 0.5, y: 1 }} end={{ x: 0.5, y: 0 }} style={[styles.edge, { bottom: 0, left: 0, right: 0, height: EDGE }]} />
      <LinearGradient colors={c} start={{ x: 0, y: 0.5 }} end={{ x: 1, y: 0.5 }} style={[styles.edge, { left: 0, top: 0, bottom: 0, width: EDGE }]} />
      <LinearGradient colors={c} start={{ x: 1, y: 0.5 }} end={{ x: 0, y: 0.5 }} style={[styles.edge, { right: 0, top: 0, bottom: 0, width: EDGE }]} />
    </Animated.View>
  );
}

/** Global phone overlay — mounted once in the (app) layout, driven by the bus. */
export function GlobalListeningGlow() {
  const [on, setOn] = useState(glowOn);
  useEffect(() => subscribeListeningGlow(setOn), []);
  return (
    <View pointerEvents="none" style={styles.fill}>
      <ListeningEdgeGlow active={on} />
    </View>
  );
}

const styles = StyleSheet.create({
  fill: { ...StyleSheet.absoluteFillObject, zIndex: 9998 },
  edge: { position: "absolute" },
});

export default ListeningEdgeGlow;
