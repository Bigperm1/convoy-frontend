// PressableScale — the app's ONE press response (Jeff, 2026-09-23: Apple-feel batch 1). DESIGN.md §11.5.
//
// Press-IN shrinks the control to MOTION.press.scale (a Reanimated CSS transition on `transform`,
// 120 ms ease-out); release brings it back. Feedback lands on press-in, the action on press-out.
// Under Reduce Motion there is no scale: a CHILD tint (MOTION.press.highlight) lights the control instead.
// Neither path ever sets opacity, so a glass child (GlassFill → UIVisualEffectView) never gets an alpha'd
// parent — Apple's docs say that renders the effect incorrectly, and it is what TouchableOpacity did to
// every glass control it wrapped.
//
// ONE element, on purpose: the Pressable IS the animated view and takes the caller's `style` whole, just
// as TouchableOpacity did, so swapping the tag is the entire migration. The recipe's shape — an unstyled
// Pressable around a styled inner view — breaks every control whose style carries its own layout: the
// flex item (route chips and pills are `flex: 1`) or the absolutely placed box would become the unstyled
// wrapper, and an inner absolute box would hang off a 0×0 Pressable.
//
// ⚠ Plain style values only: a core-Animated value (Animated.Value / interpolate) in `style` is not
// understood by a Reanimated component. Wrap such a control in its own core Animated.View instead.
//
// hitSlop defaults to MOTION.press.hitSlop (12), which brings a small control up to the 44 pt target.
// A control that is already 44 pt and sits closer than 12 pt to another pressable passes hitSlop={0}:
// the hit test walks siblings last-first, so the later control's slop takes the earlier one's visible
// edge (read in RN's hit-testing, not measured on a device). pressRetentionOffset stays at RN's
// default (20/20/20/30), per §11.5.
import React, { useState } from "react";
import {
  Pressable,
  StyleSheet,
  View,
  type GestureResponderEvent,
  type PressableProps,
  type StyleProp,
  type ViewStyle,
} from "react-native";
import Animated from "react-native-reanimated";
import { MOTION } from "../motion";
import { useReduceMotion } from "../motionPrefs";

const AnimatedPressable = Animated.createAnimatedComponent(Pressable);

// Built from the one table; only the composition lives here.
const pressTransition = {
  transitionProperty: "transform",
  transitionDuration: MOTION.press.durationCss,
  transitionTimingFunction: MOTION.ease.outCss,
} as const;

const RADIUS_KEYS = [
  "borderRadius",
  "borderTopLeftRadius",
  "borderTopRightRadius",
  "borderBottomLeftRadius",
  "borderBottomRightRadius",
] as const;

/** The control's own corner radii, so the Reduce Motion tint matches its shape. */
function radiiOf(flat: ViewStyle | undefined): ViewStyle | null {
  if (!flat) return null;
  let out: ViewStyle | null = null;
  for (const k of RADIUS_KEYS) {
    if (flat[k] != null) (out ??= {})[k] = flat[k] as never;
  }
  return out;
}

export type PressableScaleProps = Omit<PressableProps, "style" | "children"> & {
  style?: StyleProp<ViewStyle>;
  children?: React.ReactNode;
};

export function PressableScale({
  style,
  children,
  hitSlop,
  onPressIn,
  onPressOut,
  disabled,
  ...rest
}: PressableScaleProps) {
  const reduce = useReduceMotion();
  const [pressed, setPressed] = useState(false);
  const down = pressed && !disabled;

  const flat = StyleSheet.flatten(style) as ViewStyle | undefined;
  const own = flat?.transform;
  // A caller's own transform array keeps its place and the press scale composes after it. A string
  // transform cannot be composed, so that control falls back to the tint rather than lose its transform.
  const composable = own == null || Array.isArray(own);
  const scaled = composable && !reduce;
  const transform = composable
    ? [...((own as Exclude<ViewStyle["transform"], string>) ?? []), { scale: down && scaled ? MOTION.press.scale : 1 }]
    : undefined;

  return (
    <AnimatedPressable
      {...rest}
      disabled={disabled}
      hitSlop={hitSlop ?? MOTION.press.hitSlop}
      onPressIn={(e: GestureResponderEvent) => {
        setPressed(true);
        onPressIn?.(e);
      }}
      onPressOut={(e: GestureResponderEvent) => {
        setPressed(false);
        onPressOut?.(e);
      }}
      style={[style, pressTransition, transform ? { transform } : null]}
    >
      {children}
      {down && !scaled ? (
        <View
          pointerEvents="none"
          style={[StyleSheet.absoluteFill, radiiOf(flat), { backgroundColor: MOTION.press.highlight }]}
        />
      ) : null}
    </AnimatedPressable>
  );
}

export default PressableScale;
