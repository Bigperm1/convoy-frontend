// Bottom Comms tab button with press-and-hold walkie.
//
//   TAP   → open the Comms screen (normal tab navigation).
//   HOLD  → ask Claude for directions by voice — records via useVoice and
//           transcribes on release (replaces the old walkie PTT).
//
// Hold-to-talk is intentionally disabled when Comms is already the focused tab
// (accessibilityState.selected) — you have the full-size mic on screen there,
// and gating it this way guarantees the screen recorder and this global one can
// never run at the same time.

import React, { useRef } from "react";
import { Pressable, StyleSheet } from "react-native";
import * as Haptics from "expo-haptics";
import { useVoice } from "../useVoice";
import CommsHoldGlow from "./CommsHoldGlow";

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
  const voice = useVoice();
  const selected = !!accessibilityState?.selected;

  const handleLongPress = async () => {
    // Only key up from OTHER tabs — on Comms itself the big mic is right there.
    if (selected) return;
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Heavy).catch(() => {});
    txRef.current = true;
    await voice.start();
  };

  const handlePressOut = async () => {
    if (txRef.current) {
      txRef.current = false;
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light).catch(() => {});
      const uri = await voice.stop();
      if (uri) await voice.transcribe(uri);
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
      {/* Smoky green haze behind the mic while holding-to-talk. */}
      <CommsHoldGlow active={voice.recording} />
      {children}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  // Fill the tab cell and center the icon/label like the default buttons.
  btn: { flex: 1, alignItems: "center", justifyContent: "center" },
});
