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
  const holdTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const clearHoldTimer = () => {
    if (holdTimer.current) { clearTimeout(holdTimer.current); holdTimer.current = null; }
  };

  // Press-and-hold via a MANUAL onPressIn timer instead of Pressable's
  // onLongPress. The Avatar hold only ever runs while Map is the ALREADY-focused
  // tab, and onLongPress does not reliably fire on the focused tab button (React
  // Navigation owns its press handling) — that was why the panel never opened.
  // onPressIn fires on touch-down regardless of focus, so the hold opens the
  // panel every time. A short tap clears the timer before it fires (-> plain
  // navigation); a hold >=260ms fires the avatar signal + green glow.
  const handlePressIn = () => {
    heldRef.current = false;
    clearHoldTimer();
    holdTimer.current = setTimeout(() => {
      heldRef.current = true;
      setHolding(true);
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Heavy).catch(() => {});
      emitAvatarHold();
    }, 260);
  };

  const handlePressOut = () => {
    clearHoldTimer();
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
      onPressIn={handlePressIn}
      onPress={onPress}
      onPressOut={handlePressOut}
      // Suppress React Navigation's spread-in onLongPress (tabLongPress emitter)
      // so a long hold never "consumes" the press — onPress (navigate) still
      // fires on release. The avatar hold is driven by the onPressIn timer above.
      onLongPress={undefined}
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
