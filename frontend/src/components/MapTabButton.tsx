// Bottom Map tab button with press-and-hold "Avatar" shortcut.
//
//   TAP  → open the Map screen (normal tab navigation).
//   HOLD → open the on-map Avatar visibility panel (Full / Partial / Ghost),
//          signalled to map.tsx via avatarHoldBus.
//
// Mirrors CommsTabButton's structure exactly, reusing the SAME green-smoke
// CommsHoldGlow behind the icon while holding, so the two tab gestures feel
// identical. The hold only fires while Map is the focused tab (the panel lives
// on the Map screen) — holding from another tab just navigates normally.

import React, { useRef, useState } from "react";
import { Pressable, StyleSheet } from "react-native";
import * as Haptics from "expo-haptics";
import CommsHoldGlow from "./CommsHoldGlow";
import { emitAvatarHold } from "../avatarHoldBus";

type Props = {
  children?: React.ReactNode;
  onPress?: (e?: any) => void;
  accessibilityState?: { selected?: boolean };
  style?: any;
  [key: string]: any;
};

export default function MapTabButton({ children, onPress, accessibilityState, style, ...rest }: Props) {
  const [holding, setHolding] = useState(false);
  const heldRef = useRef(false);
  const selected = !!accessibilityState?.selected;

  const handleLongPress = () => {
    // Only open the Avatar panel when Map is already the active screen — the
    // panel renders there. From other tabs a hold just behaves like a tap.
    if (!selected) return;
    heldRef.current = true;
    setHolding(true);
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Heavy).catch(() => {});
    emitAvatarHold();
  };

  const handlePressOut = () => {
    if (heldRef.current) {
      heldRef.current = false;
      setHolding(false);
    }
  };

  return (
    <Pressable
      {...rest}
      style={[styles.btn, style]}
      accessibilityState={accessibilityState}
      accessibilityRole="button"
      onPress={onPress}
      onLongPress={handleLongPress}
      onPressOut={handlePressOut}
      delayLongPress={250}
    >
      {/* Same smoky green haze as the Comms hold, behind the Map icon. */}
      <CommsHoldGlow active={holding} />
      {children}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  btn: { flex: 1, alignItems: "center", justifyContent: "center" },
});
