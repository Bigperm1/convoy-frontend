// Bottom Comms tab button with press-and-hold walkie.
//
//   TAP   → open the Comms screen (normal tab navigation).
//   HOLD  → transmit to your active channel WITHOUT leaving the current tab,
//           using the global PTT recorder. Release to send.
//
// Hold-to-talk is intentionally disabled when Comms is already the focused tab
// (accessibilityState.selected) — you have the full-size mic on screen there,
// and gating it this way guarantees the screen recorder and this global one can
// never run at the same time.

import React, { useEffect, useRef, useState } from "react";
import { Pressable, View, StyleSheet } from "react-native";
import * as Haptics from "expo-haptics";
import { pttDown, pttUp, globalPttBus } from "../globalPtt";

type Props = {
  children?: React.ReactNode;
  onPress?: (e?: any) => void;
  accessibilityState?: { selected?: boolean };
  style?: any;
  selfId?: string | null;
  [key: string]: any;
};

export default function CommsTabButton({ children, onPress, accessibilityState, style, selfId, ...rest }: Props) {
  const txRef = useRef(false);
  const [txing, setTxing] = useState(false);
  const selected = !!accessibilityState?.selected;

  // Reflect the global recorder's state (covers the 60s auto-cap closing it).
  useEffect(() => globalPttBus.on(setTxing), []);

  const handleLongPress = async () => {
    // Only key up from OTHER tabs — on Comms itself the big mic is right there.
    if (selected) return;
    const res = await pttDown(selfId);
    if (res === "recording") {
      txRef.current = true;
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Heavy).catch(() => {});
    } else if (res === "no-channel") {
      // Nothing to talk to yet — fall back to opening Comms so they can pick a crew.
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning).catch(() => {});
      onPress?.();
    } else if (res === "blocked") {
      // Someone else holds the floor — buzz and do nothing.
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning).catch(() => {});
    }
    // "prompted" → mic permission was just requested; the next hold records.
  };

  const handlePressOut = () => {
    if (txRef.current) {
      txRef.current = false;
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light).catch(() => {});
      pttUp().catch(() => {});
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
      {children}
      {txing && <View style={styles.txDot} pointerEvents="none" />}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  // Fill the tab cell and center the icon/label like the default buttons.
  btn: { flex: 1, alignItems: "center", justifyContent: "center" },
  // Small red "on air" dot near the top of the tab while transmitting.
  txDot: {
    position: "absolute",
    top: 4,
    alignSelf: "center",
    width: 9,
    height: 9,
    borderRadius: 5,
    backgroundColor: "#FF3B30",
  },
});
