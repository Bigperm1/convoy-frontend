// CandyCta — a primary button wearing the map banner's candy language.
//
// Jeff, 2026-08-23: "apply the same gradient effect [as] the map banners to the
// save cta and all the icons." The stops live in ManeuverArrow.tsx next to
// ManeuverBox, which is the component the nav banner already uses, so a CTA here
// and the maneuver square on the map can never drift apart. Do not re-type the
// hex values — import them.
//
// Disabled is a real state, not 40% opacity on the gradient: a dimmed green
// still reads as "green button, tap me". Disabled drops the fill entirely and
// leaves a hairline outline, so it reads as inert at a glance.

import React from "react";
import {
  ActivityIndicator,
  StyleSheet,
  Text,
  View,
  type StyleProp,
  type ViewStyle,
} from "react-native";
import { LinearGradient } from "expo-linear-gradient";
import { Ionicons } from "@expo/vector-icons";
import { skin, type VisualTier } from "../tierTheme";
import SkinSheen from "./SkinSheen";
import { PressableScale } from "../ui/PressableScale";

export function CandyCta({
  label,
  icon,
  onPress,
  disabled,
  busy,
  height = 54,
  radius = 16,
  tier = "brand",
  style,
}: {
  label: string;
  icon?: keyof typeof Ionicons.glyphMap;
  onPress?: () => void;
  disabled?: boolean;
  busy?: boolean;
  height?: number;
  radius?: number;
  /** brand = green (untiered). premium = silver. ultra = gold. See tierTheme.ts. */
  tier?: VisualTier;
  style?: StyleProp<ViewStyle>;
}) {
  const off = !!disabled;
  const sk = skin(tier);
  return (
    <PressableScale
      // Already ≥ 44 pt tall and often stacked 4–12 pt from another button: keep today's touch target,
      // since the default slop would reach into the neighbour (Jeff, 2026-09-23: Apple-feel batch 1).
      hitSlop={0}
      onPress={onPress}
      disabled={off || busy}
      // The radius is only for the Reduce Motion press tint, so it takes the button's shape.
      style={[style, { borderRadius: radius }]}
      accessibilityRole="button"
      accessibilityState={{ disabled: off }}
    >
      <View
        style={[
          styles.wrap,
          { height, borderRadius: radius, borderColor: sk.rim },
          off && styles.wrapOff,
        ]}
      >
        {!off && (
          <LinearGradient
            colors={sk.colors}
            locations={sk.locations}
            style={[StyleSheet.absoluteFill, { borderRadius: radius }]}
          />
        )}
        {!off && <SkinSheen sk={sk} radius={radius} />}
        {busy ? (
          <ActivityIndicator color={off ? "#4A4A4A" : sk.ink} />
        ) : (
          <>
            {icon ? <Ionicons name={icon} size={19} color={off ? "#4A4A4A" : sk.ink} /> : null}
            <Text style={[styles.label, { color: sk.ink }, off && styles.labelOff]}>{label}</Text>
          </>
        )}
      </View>
    </PressableScale>
  );
}

const styles = StyleSheet.create({
  wrap: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 9,
    overflow: "hidden",
    borderWidth: 1,
  },
  wrapOff: { borderColor: "#242424", backgroundColor: "transparent" },
  label: { fontSize: 17, fontWeight: "800" },
  labelOff: { color: "#4A4A4A" },
});

export default CandyCta;
