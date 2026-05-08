import React from "react";
import { View, StyleSheet, ViewProps, Platform } from "react-native";
import { BlurView } from "expo-blur";
import { COLORS } from "./theme";

type Props = ViewProps & {
  intensity?: number;
  tint?: "light" | "dark" | "default";
  radius?: number;
  border?: boolean;
};

// Liquid-glass card. Uses BlurView on iOS/Android, semi-transparent fallback on web.
export default function Glass({
  intensity = 50,
  tint = "dark",
  radius = 20,
  border = true,
  style,
  children,
  ...rest
}: Props) {
  const base = {
    borderRadius: radius,
    overflow: "hidden" as const,
    borderWidth: border ? StyleSheet.hairlineWidth : 0,
    borderColor: COLORS.hairlineStrong,
  };

  if (Platform.OS === "web") {
    // BlurView on web is unreliable; emulate with translucent surface
    return (
      <View
        style={[
          base,
          { backgroundColor: "rgba(28,28,30,0.72)" },
          style,
        ]}
        {...rest}
      >
        {children}
      </View>
    );
  }

  return (
    <View style={[base, style]} {...rest}>
      <BlurView intensity={intensity} tint={tint} style={StyleSheet.absoluteFill} />
      <View style={{ backgroundColor: "rgba(28,28,30,0.45)", flex: 1 }}>{children}</View>
    </View>
  );
}
