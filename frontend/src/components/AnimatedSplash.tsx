// AnimatedSplash.tsx — the branded launch animation (OTA).
//
// The very first frame on cold start is the NATIVE splash (baked into the build); this
// overlay plays the instant the RN root mounts, on top of everything, so the new Hairpin
// branding takes over immediately:
//   1. the green "h" logo fades + scales in over the map/route background,
//   2. the map background fades away INTO BLACK (the logo stays),
//   3. the whole overlay dissolves to reveal the app.
// Mounted once at the root (app/_layout.tsx); unmounts itself when the sequence ends.
// pointerEvents="none" throughout so it can never eat a tap.
import React, { useEffect, useRef, useState } from 'react';
import { Animated, Dimensions, Easing, StyleSheet } from 'react-native';

const { width: SW, height: SH } = Dimensions.get('window');

export default function AnimatedSplash({ onDone }: { onDone?: () => void }) {
  const logoIn = useRef(new Animated.Value(0)).current;      // "h" fade + scale in
  const mapFade = useRef(new Animated.Value(1)).current;     // map bg opacity → 0 (into black)
  const overlayFade = useRef(new Animated.Value(1)).current; // whole splash → 0 at the end
  const [gone, setGone] = useState(false);

  useEffect(() => {
    Animated.sequence([
      Animated.timing(logoIn, { toValue: 1, duration: 460, easing: Easing.out(Easing.cubic), useNativeDriver: true }),
      Animated.delay(240),
      Animated.timing(mapFade, { toValue: 0, duration: 820, easing: Easing.inOut(Easing.ease), useNativeDriver: true }),
      Animated.delay(260),
      Animated.timing(overlayFade, { toValue: 0, duration: 420, easing: Easing.in(Easing.ease), useNativeDriver: true }),
    ]).start(({ finished }) => { if (finished) { setGone(true); onDone?.(); } });
  }, [logoIn, mapFade, overlayFade, onDone]);

  if (gone) return null;
  const logoScale = logoIn.interpolate({ inputRange: [0, 1], outputRange: [0.84, 1] });

  return (
    // Whole overlay fades out at the end (overlayFade 1→0) to reveal the app underneath.
    <Animated.View pointerEvents="none" style={[styles.root, { opacity: overlayFade }]}>
      {/* map/route background, fading away into the black root */}
      <Animated.Image
        source={require('../../assets/images/glass-bgt.png')}
        resizeMode="cover"
        style={{ position: 'absolute', top: 0, left: 0, width: SW, height: SH, opacity: mapFade }}
      />
      {/* the "h" logo — stays through the map fade */}
      <Animated.Image
        source={require('../../assets/images/brand-mark.png')}
        resizeMode="contain"
        style={{ width: 176, height: 176, opacity: logoIn, transform: [{ scale: logoScale }] }}
      />
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  root: { ...StyleSheet.absoluteFillObject, backgroundColor: '#000', alignItems: 'center', justifyContent: 'center', zIndex: 99999 },
});
