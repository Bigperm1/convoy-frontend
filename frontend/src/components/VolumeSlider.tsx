// VolumeSlider — a pure-JS horizontal slider (PanResponder, no native module) so
// it ships over-the-air. @react-native-community/slider is native → not OTA-able,
// which is why we roll our own. Value is 0..1. onChange fires live while dragging;
// onComplete fires on release (persist there to avoid a settings write per frame).
// disabled → greyed, non-interactive (used for the fixed "Music" reference row).
import React, { useRef, useState } from "react";
import { View, StyleSheet, PanResponder, LayoutChangeEvent, GestureResponderEvent, PanResponderGestureState } from "react-native";

const THUMB = 22;
const clamp01 = (v: number) => Math.max(0, Math.min(1, v));

export default function VolumeSlider({
  value, onChange, onComplete, disabled = false,
  color = "#2DEC86", trackColor = "rgba(255,255,255,0.14)", height = 6,
}: {
  value: number;
  onChange?: (v: number) => void;
  onComplete?: (v: number) => void;
  disabled?: boolean;
  color?: string;
  trackColor?: string;
  height?: number;
}) {
  const [w, setW] = useState(0);
  const wRef = useRef(0);
  const valRef = useRef(value);
  valRef.current = value;
  const grantRef = useRef(0); // value captured on touch-down

  const onLayout = (e: LayoutChangeEvent) => {
    const width = e.nativeEvent.layout.width;
    wRef.current = width;
    setW(width);
  };

  const pan = useRef(
    PanResponder.create({
      onStartShouldSetPanResponder: () => !disabled,
      onMoveShouldSetPanResponder: () => !disabled,
      onPanResponderGrant: (e: GestureResponderEvent) => {
        if (disabled || !wRef.current) return;
        const v = clamp01(e.nativeEvent.locationX / wRef.current);
        grantRef.current = v;
        onChange?.(v);
      },
      onPanResponderMove: (_e: GestureResponderEvent, g: PanResponderGestureState) => {
        if (disabled || !wRef.current) return;
        onChange?.(clamp01(grantRef.current + g.dx / wRef.current));
      },
      onPanResponderRelease: () => { if (!disabled) onComplete?.(valRef.current); },
      onPanResponderTerminate: () => { if (!disabled) onComplete?.(valRef.current); },
    }),
  ).current;

  const v = clamp01(value);
  const fillW = w > 0 ? v * w : 0;
  const thumbLeft = Math.max(0, Math.min(w - THUMB, v * w - THUMB / 2));
  const dim = disabled ? 0.45 : 1;

  return (
    <View
      style={styles.wrap}
      onLayout={onLayout}
      hitSlop={{ top: 14, bottom: 14, left: 6, right: 6 }}
      {...pan.panHandlers}
    >
      <View style={[styles.track, { height, borderRadius: height / 2, backgroundColor: trackColor, opacity: dim }]} />
      <View style={[styles.fill, { height, borderRadius: height / 2, width: fillW, backgroundColor: color, opacity: dim }]} />
      <View
        style={[
          styles.thumb,
          { left: thumbLeft, backgroundColor: disabled ? "#8E8E93" : "#FFFFFF", borderColor: color, opacity: disabled ? 0.6 : 1 },
        ]}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { height: THUMB + 8, justifyContent: "center" },
  track: { position: "absolute", left: 0, right: 0 },
  fill: { position: "absolute", left: 0 },
  thumb: {
    position: "absolute", width: THUMB, height: THUMB, borderRadius: THUMB / 2, borderWidth: 2,
    shadowColor: "#000", shadowOpacity: 0.35, shadowRadius: 3, shadowOffset: { width: 0, height: 1 }, elevation: 3,
  },
});
