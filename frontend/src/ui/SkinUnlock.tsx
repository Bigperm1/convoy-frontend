// ui/SkinUnlock.tsx — the unlock wave's light band and badge, and the host that decides WHEN an unlock is shown.
// Both mount once, in the signed-in shell (app/(app)/_layout.tsx). See src/skinWave.ts for the design.

import React, { useEffect, useRef, useState } from "react";
import { AppState, StyleSheet, Text, View, useWindowDimensions } from "react-native";
import { LinearGradient } from "expo-linear-gradient";
import { usePathname } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import Animated, {
  Easing, ReduceMotion, useAnimatedStyle, useSharedValue, withDelay, withSequence, withTiming,
} from "react-native-reanimated";
import { getGarage, subscribeGarage } from "../garageStore";
import { pendingUnlock, releaseSkinHold } from "../appSkin";
import { skin, type VisualTier } from "../tierTheme";
import { MOTION } from "../motion";
import { haptics } from "../haptics";
import { useReduceMotion } from "../motionPrefs";
import { logEventReliable } from "../crashBreadcrumb";
import { WAVE, getSkinWave, playSkinWave, useSkinWave, type SkinWave, type WaveBadge } from "../skinWave";
import { isNavSessionLive } from "../navNotification";
import { headUnitAttachedRaw } from "../locationPrivacy";
import SkinSheen from "../components/SkinSheen";
import ConvoyLogo from "../components/ConvoyLogo";
import { splashLiftedAt, subscribeSplashLifted } from "../components/AnimatedSplash";

/** The change can be seen and should be shown: the app is in front and nobody is driving to a destination or plugged
 *  into a car. Never a celebration mid-drive. */
export function canPlayWave(): boolean {
  if (AppState.currentState !== "active") return false;
  try { if (isNavSessionLive()) return false; } catch {}
  try { if (headUnitAttachedRaw()) return false; } catch {}
  return true;
}

/** The metal's own name, for the badge. */
const METAL_NAME: Record<VisualTier, string> = { brand: "GREEN", premium: "SILVER", ultra: "GOLD", diamond: "DIAMOND" };

/** A hex colour at an opacity, as rgba (LinearGradient stops need a real alpha). */
function rgba(hex: string, a: number): string {
  const h = hex.replace("#", "");
  const n = parseInt(h.length === 3 ? h.split("").map((c) => c + c).join("") : h.slice(0, 6), 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
}

/** The band of light in the new metal, crossing the screen top → bottom in WAVE.sweep. Its centre reaches height y at
 *  t0 + y × sweep — the same moment every wave element turns (skinWave.waveReachMs). */
function Band({ wave }: { wave: SkinWave }) {
  const { height: H } = useWindowDimensions();
  const bandH = Math.round(H * WAVE.bandFrac);
  const p = useSharedValue(0);
  const op = useSharedValue(0);
  useEffect(() => {
    const delay = Math.max(0, wave.t0 - Date.now());
    const cfg = { reduceMotion: ReduceMotion.Never } as const;
    p.set(withDelay(delay, withTiming(1, { duration: WAVE.sweep, easing: Easing.linear, ...cfg })));
    op.set(withDelay(delay, withSequence(
      withTiming(1, { duration: 120, easing: MOTION.ease.out, ...cfg }),
      withDelay(WAVE.sweep - 240, withTiming(0, { duration: 120, easing: MOTION.ease.out, ...cfg })),
    )));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const st = useAnimatedStyle(() => ({
    opacity: op.get(),
    transform: [{ translateY: p.get() * H - bandH / 2 }],
  }));
  const sk = skin(wave.to);
  const light = sk.colors[0];
  // A soft glow in the new metal around a thin bright core — a scan line. No texture: without a mask module a sheen
  // image would show the band's hard top and bottom edges (sim, 2026-09-23).
  return (
    <Animated.View pointerEvents="none" style={[styles.band, { height: bandH }, st]}>
      <LinearGradient
        colors={[
          rgba(sk.accent, 0), rgba(sk.accent, 0.24), rgba(light, 0.6), "rgba(255,255,255,0.95)",
          rgba(light, 0.6), rgba(sk.accent, 0.24), rgba(sk.accent, 0),
        ]}
        locations={[0, 0.34, 0.485, 0.5, 0.515, 0.66, 1]}
        style={StyleSheet.absoluteFill}
      />
    </Animated.View>
  );
}

/** "DIAMOND UNLOCKED · Your 1st 3D scan" — in the new metal, after the band has passed. */
function Badge({ to, badge, reduce, onDone }: { to: VisualTier; badge: WaveBadge; reduce: boolean; onDone: () => void }) {
  const insets = useSafeAreaInsets();
  const op = useSharedValue(0);
  const sc = useSharedValue(reduce ? 1 : MOTION.popover.fromScale);
  useEffect(() => {
    const cfg = { reduceMotion: ReduceMotion.Never } as const;
    op.set(withSequence(
      withTiming(1, { duration: WAVE.badgeIn, easing: MOTION.ease.out, ...cfg }),
      withDelay(WAVE.badgeHold, withTiming(0, { duration: WAVE.badgeOut, easing: MOTION.ease.out, ...cfg })),
    ));
    if (!reduce) sc.set(withTiming(1, { duration: WAVE.badgeIn, easing: MOTION.ease.out, ...cfg }));
    // Unmount after it has faded (JS timer: the badge is not interactive, and a stuck badge must still go).
    const t = setTimeout(onDone, WAVE.badgeIn + WAVE.badgeHold + WAVE.badgeOut + 60);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const st = useAnimatedStyle(() => ({ opacity: op.get(), transform: [{ scale: sc.get() }] }));
  const sk = skin(to);
  return (
    <Animated.View pointerEvents="none" style={[styles.badgeWrap, { top: insets.top + 132 }, st]}>
      <LinearGradient colors={sk.colors} locations={sk.locations} style={[styles.badge, { borderColor: sk.rim }]}>
        <SkinSheen sk={sk} radius={22} />
        <ConvoyLogo tier={to} size={40} />
        <View>
          <Text style={[styles.badgeTitle, { color: sk.ink }]} allowFontScaling={false}>{badge.title}</Text>
          {badge.sub ? <Text style={[styles.badgeSub, { color: sk.ink }]} allowFontScaling={false}>{badge.sub}</Text> : null}
        </View>
      </LinearGradient>
    </Animated.View>
  );
}

/** The band and the badge, over everything, never touchable. */
export function SkinWaveOverlay() {
  const wave = useSkinWave();
  const [shown, setShown] = useState<{ id: number; to: VisualTier; badge: WaveBadge; reduce: boolean } | null>(null);
  // Keyed by the wave's id, not the object: its run → settle hand-over must not re-run (and cancel) these timers.
  const waveId = wave?.id;
  useEffect(() => {
    const w = getSkinWave();
    if (!w || w.id !== waveId) return;
    const { id, to, badge, reduce } = w;
    // One haptic, on the causal frame — the band starting — and only for an unlock (a badge). A skin picked in Settings
    // already ticked on the tap.
    const startIn = Math.max(0, w.t0 - Date.now());
    const timers: ReturnType<typeof setTimeout>[] = [];
    if (badge) {
      timers.push(setTimeout(() => haptics.success(), startIn));
      timers.push(setTimeout(() => setShown({ id, to, badge, reduce }), startIn + (reduce ? WAVE.reduceReveal : WAVE.sweep)));
    }
    return () => timers.forEach(clearTimeout);
  }, [waveId]);
  return (
    <View pointerEvents="none" style={StyleSheet.absoluteFill}>
      {wave && !wave.reduce && wave.phase === "run" ? <Band key={wave.id} wave={wave} /> : null}
      {shown ? <Badge key={shown.id} to={shown.to} badge={shown.badge} reduce={shown.reduce} onDone={() => setShown(null)} /> : null}
    </View>
  );
}

/** Screens where an unlock may play: any tab page — not the Garage and its scan flow, which wear their own metal (and
 *  the scan's "your car is ready" moment happens there; the wave follows on the next page). */
function onUnlockScreen(pathname: string | null): boolean {
  if (!pathname) return false;
  return !/^\/(\(app\)\/)?garage/.test(pathname);
}

/** How often a held unlock re-checks whether it can play (the app came back, a drive ended). */
const RECHECK_MS = 15_000;
/** After the launch splash lifts, let the page land before the wave runs over it. */
const AFTER_SPLASH_MS = 700;

/**
 * Plays an unlock the moment it can be SEEN. An unlock (appSkin.holdSkinForUnlock — the first finished 3D scan today)
 * keeps the old metal on every surface until then; this waits for the app in front, no drive, a tab page, then runs the
 * wave and releases the hold as its last step. A hold that changes nothing (the member wears a lower metal by choice) or
 * has gone stale is released without a wave.
 */
export function SkinUnlockHost() {
  const pathname = usePathname();
  const reduce = useReduceMotion();
  const [tick, setTick] = useState(0);
  const playing = useRef(false);

  useEffect(() => subscribeGarage(() => setTick((n) => n + 1)), []);
  useEffect(() => subscribeSplashLifted(() => setTick((n) => n + 1)), []);
  useEffect(() => {
    const sub = AppState.addEventListener("change", (s) => { if (s === "active") setTick((n) => n + 1); });
    const t = setInterval(() => { if (getGarage().skinHold) setTick((n) => n + 1); }, RECHECK_MS);
    return () => { sub.remove(); clearInterval(t); };
  }, []);

  useEffect(() => {
    if (playing.current || !getGarage().skinHold) return;
    const p = pendingUnlock();
    if (!p) {
      void releaseSkinHold();
      return;
    }
    if (!onUnlockScreen(pathname) || !canPlayWave()) return;
    // Never behind the launch splash: wait for it to lift, then a beat for the page to land.
    const lifted = splashLiftedAt();
    if (!lifted) return;
    const wait = lifted + AFTER_SPLASH_MS - Date.now();
    if (wait > 0) {
      const t = setTimeout(() => setTick((n) => n + 1), wait);
      return () => clearTimeout(t);
    }
    playing.current = true;
    const badge: WaveBadge = p.key === "first-scan" && p.to === "diamond"
      ? { title: "DIAMOND UNLOCKED", sub: "Your 1st 3D scan" }
      : { title: `${METAL_NAME[p.to]} UNLOCKED` };
    void playSkinWave({ from: p.from, to: p.to, reduce, badge, canPlay: true, apply: releaseSkinHold })
      .then((how) => { try { logEventReliable(`skin-unlock shown key=${p.key} to=${p.to} how=${how}`); } catch {} })
      .catch(() => { void releaseSkinHold(); })
      .finally(() => { playing.current = false; });
  }, [tick, pathname, reduce]);

  return null;
}

const styles = StyleSheet.create({
  band: { position: "absolute", left: 0, right: 0, top: 0 },
  badgeWrap: { position: "absolute", left: 0, right: 0, alignItems: "center" },
  badge: {
    flexDirection: "row", alignItems: "center", gap: 12,
    paddingLeft: 10, paddingRight: 20, paddingVertical: 10,
    borderRadius: 22, borderWidth: 1, overflow: "hidden",
  },
  badgeTitle: { fontSize: 14, fontWeight: "800", letterSpacing: 1.6 },
  badgeSub: { fontSize: 12, fontWeight: "600", marginTop: 2, opacity: 0.78 },
});
