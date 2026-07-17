// AnimatedSplash.tsx — the branded launch image (OTA).
//
// Shows the Hairpin splash (splash2.png) full-screen the instant the RN root mounts, so
// the new branding takes over as soon as the app's JS boots, then fades out to reveal the
// app. Mounted once at the root (app/_layout.tsx); unmounts itself when done.
//
// NOTE: the very first cold-start frame is the NATIVE splash, baked into the installed
// build — an OTA can't touch it. On builds cut before app.json's splash was set to
// splash2.png, the old logo flashes for a beat before this takes over; a native build
// (with the new splash baked in) removes that first frame entirely.
import React, { useEffect, useRef, useState } from 'react';
import { Animated, Dimensions, Easing, StyleSheet } from 'react-native';

export default function AnimatedSplash({ onDone }: { onDone?: () => void }) {
  // Read inside the component, not at module scope: Dimensions.get('window')
  // throws if the window dimensions aren't set yet, and this module loads
  // during cold HEADLESS launches (CarPlay scene, no phone window).
  const { width: SW, height: SH } = Dimensions.get('window');
  const fade = useRef(new Animated.Value(1)).current; // whole splash → 0 to reveal the app
  const [gone, setGone] = useState(false);

  useEffect(() => {
    Animated.sequence([
      Animated.delay(1300),
      Animated.timing(fade, { toValue: 0, duration: 450, easing: Easing.in(Easing.ease), useNativeDriver: true }),
    ]).start(({ finished }) => { if (finished) { setGone(true); onDone?.(); } });
  }, [fade, onDone]);

  if (gone) return null;

  return (
    <Animated.View pointerEvents="none" style={[styles.root, { opacity: fade }]}>
      <Animated.Image
        source={require('../../assets/images/splash2.png')}
        resizeMode="cover"
        style={{ position: 'absolute', top: 0, left: 0, width: SW, height: SH }}
      />
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  root: { ...StyleSheet.absoluteFillObject, backgroundColor: '#000', zIndex: 99999 },
});
