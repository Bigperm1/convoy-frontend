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

// The animation, in one place so the safety timeout below can do arithmetic against it.
const HOLD_MS = 1300;
const FADE_MS = 450;
// ── THE SPLASH MUST LIFT EVEN IF THE ANIMATION NEVER FINISHES ────────────────
// Jeff and Olaf, 2026-09-21: both phones went entirely black — no map, no search bar, no
// tab bar — while the app kept running and logging normally. The measured cause is an iOS
// scene problem on CarPlay-first launches, NOT this file; but this file is the one piece of
// our own code that can paint that exact picture and had no way out of it. Its root is
// absoluteFill + #000 + zIndex 99999, mounted as a SIBLING of the whole <Stack>, so it
// covers the tab bar too — nothing inside a screen could do that — and until today its ONLY
// exit was the completion callback of a JS-scheduled Animated.sequence. A launch that stalls
// the JS thread is precisely the case where that callback does not arrive, and the user is
// left with an opaque black rectangle and no escape but a force-quit.
//
// So: dismiss on a plain timer too, regardless of what the animation is doing. The hold and
// fade together run HOLD_MS + FADE_MS = 1750 ms, so 3000 ms leaves 1250 ms of slack — more
// than the whole fade and nearly the whole hold — and a merely slow boot still finishes the
// brand animation normally and is never cut short. A stuck one clears itself in 3 s.
//
// Precedent: the warm-mount cover in src/ConvoyMapbox.tsx (`warmMountRef`) is the same shape
// — an opaque Animated.View whose real lift is an event (SelfCarModel's first camera push)
// with an unconditional `setTimeout(endWarm, 1000)` behind it. A cover over the map is
// recoverable; a cover over the entire app is not, which is why this one gets a timeout too.
const SAFETY_MS = 3000;

export default function AnimatedSplash({ onDone }: { onDone?: () => void }) {
  // Read inside the component, not at module scope: Dimensions.get('window')
  // throws if the window dimensions aren't set yet, and this module loads
  // during cold HEADLESS launches (CarPlay scene, no phone window).
  const { width: SW, height: SH } = Dimensions.get('window');
  const fade = useRef(new Animated.Value(1)).current; // whole splash → 0 to reveal the app
  const [gone, setGone] = useState(false);
  // Two ways out now, and they race: whichever arrives second must be a no-op. A ref, not
  // state, because the loser reads it in the same tick the winner set it.
  const doneRef = useRef(false);

  useEffect(() => {
    const dismiss = () => {
      if (doneRef.current) return;
      doneRef.current = true;
      setGone(true);
      onDone?.();
    };
    Animated.sequence([
      Animated.delay(HOLD_MS),
      Animated.timing(fade, { toValue: 0, duration: FADE_MS, easing: Easing.in(Easing.ease), useNativeDriver: true }),
    ]).start(({ finished }) => { if (finished) dismiss(); });
    const safety = setTimeout(dismiss, SAFETY_MS);
    return () => clearTimeout(safety);
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
