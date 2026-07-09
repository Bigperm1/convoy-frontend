// MarqueeText — single-line text that gently scrolls (ping-pong) ONLY when it's too
// long for its container; otherwise it renders static. Built for the CarPlay maneuver
// banner so long instructions ("…take the 3rd exit toward 202 Street") read fully instead
// of truncating. Safe fallback: if measurement doesn't resolve, it just shows static
// (truncated) text — never worse than before.

import React, { useEffect, useRef, useState } from "react";
import { Animated, View, Text, StyleSheet, type TextStyle, type StyleProp } from "react-native";

export function MarqueeText({
  text,
  style,
}: {
  text: string;
  style?: StyleProp<TextStyle>;
}) {
  const [containerW, setContainerW] = useState(0);
  const [textW, setTextW] = useState(0);
  const tx = useRef(new Animated.Value(0)).current;
  const overflow = containerW > 0 && textW > 0 ? Math.max(0, textW - containerW) : 0;

  useEffect(() => {
    tx.stopAnimation();
    tx.setValue(0);
    if (overflow <= 1) return; // fits → static, no animation
    const dur = Math.max(2500, Math.round(overflow * 28)); // ~28 ms per overflow px
    const loop = Animated.loop(
      Animated.sequence([
        Animated.delay(1400),                                                    // read the start
        Animated.timing(tx, { toValue: -overflow, duration: dur, useNativeDriver: true }), // reveal the end
        Animated.delay(1400),                                                    // read the end
        Animated.timing(tx, { toValue: 0, duration: dur, useNativeDriver: true }),         // back to start
      ]),
    );
    loop.start();
    return () => loop.stop();
  }, [overflow, text, tx]);

  return (
    <View style={styles.clip} onLayout={(e) => setContainerW(e.nativeEvent.layout.width)}>
      {/* Hidden probe — measures the natural single-line width (absolute → unconstrained). */}
      <Text style={[style, styles.probe]} numberOfLines={1} onLayout={(e) => setTextW(e.nativeEvent.layout.width)}>
        {text}
      </Text>
      <Animated.Text
        style={[style, { width: Math.max(textW, containerW) || undefined, transform: [{ translateX: tx }] }]}
        numberOfLines={1}
      >
        {text}
      </Animated.Text>
    </View>
  );
}

const styles = StyleSheet.create({
  clip: { overflow: "hidden", alignSelf: "stretch" },
  probe: { position: "absolute", opacity: 0, left: 0, top: 0 },
});

export default MarqueeText;
