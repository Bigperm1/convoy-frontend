// CarHero3D — the Garage hero, but live. Jeff, 2026-08-23: "Currently you have
// to open a window to spin the car i would like that to be in the hero shot."
//
// Same <model-viewer> engine as the full-screen CarViewer3D, rendered INLINE.
// The one thing that makes inline different is gesture arbitration:
//
//   touch-action="pan-y"  — NOT "none" (what the full-screen viewer uses).
//   Horizontal drags go to the model (spin the car); vertical drags are left to
//   the page so the Garage still scrolls under your finger. With "none" the
//   WebView swallows every gesture and the Garage becomes unscrollable at the
//   top of the screen, which is where the hero lives.
//
// The WebView itself is scrollEnabled={false} + nestedScrollEnabled so it never
// competes with the parent ScrollView.

import React, { useState } from "react";
import {
  ActivityIndicator,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
  type StyleProp,
  type ViewStyle,
} from "react-native";
import { WebView } from "react-native-webview";
import { Ionicons } from "@expo/vector-icons";
import { COLORS } from "./theme";

export function carViewerHtml(glbUrl: string, opts?: { inline?: boolean; interactive?: boolean }): string {
  const inline = opts?.inline ?? false;
  const interactive = opts?.interactive ?? true;
  return `<!DOCTYPE html><html><head>
<meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no">
<script type="module" src="https://ajax.googleapis.com/ajax/libs/model-viewer/3.5.0/model-viewer.min.js"></script>
<style>
  html,body{margin:0;height:100%;background:#0B0C0E;overflow:hidden}
  model-viewer{width:100%;height:100%;--poster-color:transparent;background:#0B0C0E}
</style></head><body>
<model-viewer
  src="${glbUrl}"
  ${interactive ? "camera-controls" : "disable-pan disable-zoom disable-tap"}
  auto-rotate
  auto-rotate-delay="${inline ? 600 : 1200}"
  rotation-per-second="${inline ? "12deg" : "8deg"}"
  camera-orbit="325deg 76deg 100%"
  min-camera-orbit="auto 55deg auto"
  max-camera-orbit="auto 92deg auto"
  min-field-of-view="18deg"
  max-field-of-view="42deg"
  interaction-prompt="none"
  exposure="1.05"
  shadow-intensity="0.9"
  shadow-softness="0.7"
  touch-action="${!interactive ? "pan-y" : inline ? "pan-y" : "none"}">
</model-viewer>
<script>
  // HERO SHOT (2026-09-03): once the model has loaded, wait a beat for the first frames,
  // then hand a JPEG of the canvas to the app. The app decides whether it wants it.
  (function () {
    var mv = document.querySelector('model-viewer');
    if (!mv) return;
    mv.addEventListener('load', function () {
      setTimeout(function () {
        try {
          var d = mv.toDataURL('image/jpeg', 0.86);
          if (window.ReactNativeWebView) window.ReactNativeWebView.postMessage(JSON.stringify({ t: 'hero', d: d }));
        } catch (e) {}
      }, 900);
    });
  })();
</script>
</body></html>`;
}

export default function CarHero3D({
  glbUrl,
  style,
  onExpand,
  emptyLabel = "No car yet",
  emptyHint = "Scan yours to put it on the map",
  onEmptyPress,
  interactive = true,
  onSnapshot,
}: {
  glbUrl: string | null;
  style?: StyleProp<ViewStyle>;
  onExpand?: () => void;
  emptyLabel?: string;
  emptyHint?: string;
  onEmptyPress?: () => void;
  /**
   * false = auto-rotate only, finger orbit OFF.
   *
   * Inside a horizontal carousel this MUST be false: a pager and a
   * finger-spinnable model both want horizontal drags, and model-viewer wins —
   * the page would become impossible to swipe off. Non-interactive still spins
   * itself, and tapping expands to the full-screen viewer where you can grab it.
   */
  interactive?: boolean;
  /** Receives a data:image/jpeg URI of the loaded hero (see the HERO SHOT script). */
  onSnapshot?: (jpegDataUri: string) => void;
}) {
  const [ready, setReady] = useState(false);

  // No model — the Garage ships with no car until one is scanned, so this is a
  // first-class state, not an error.
  if (!glbUrl) {
    return (
      <TouchableOpacity
        style={[styles.wrap, styles.empty, style]}
        activeOpacity={onEmptyPress ? 0.85 : 1}
        onPress={onEmptyPress}
        disabled={!onEmptyPress}
      >
        <Ionicons name="car-sport-outline" size={44} color="#2E2E2E" />
        <Text style={styles.emptyLabel}>{emptyLabel}</Text>
        <Text style={styles.emptyHint}>{emptyHint}</Text>
      </TouchableOpacity>
    );
  }

  return (
    <View style={[styles.wrap, style]}>
      <WebView
        pointerEvents={interactive ? "auto" : "none"}
        originWhitelist={["*"]}
        source={{ html: carViewerHtml(glbUrl, { inline: true, interactive }), baseUrl: "https://localhost" }}
        style={styles.web}
        javaScriptEnabled
        domStorageEnabled
        allowsInlineMediaPlayback
        // iOS: RNCWebViewImpl defaults _scrollEnabled and _bounces to YES, and its
        // gestureRecognizer delegate refuses to recognise simultaneously with
        // anything but a long-press. With bounces on, the inner WKWebView
        // scrollView pan claims the touch even though overflow:hidden leaves it
        // nothing to scroll — so BOTH of these must be off or the Garage page
        // stops scrolling wherever the hero is under your finger.
        scrollEnabled={false}
        bounces={false}
        // Android: deliberately NOT setting nestedScrollEnabled. The prop is
        // inverted from how it reads — RNCWebView.onTouchEvent calls
        // requestDisallowInterceptTouchEvent(true) when it is on, which FORBIDS
        // the parent ScrollView from claiming the vertical pan. Leaving it at its
        // default false is what lets ScrollView.onInterceptTouchEvent take the
        // drag past touch-slop and ACTION_CANCEL the WebView.
        onLoadEnd={() => setReady(true)}
        onMessage={(e) => {
          try {
            const m = JSON.parse(e.nativeEvent.data);
            if (m && m.t === 'hero' && typeof m.d === 'string' && m.d.startsWith('data:image/jpeg')) onSnapshot?.(m.d);
          } catch {}
        }}
      />

      {!ready && (
        <View style={styles.loading} pointerEvents="none">
          <ActivityIndicator color={COLORS.brand} />
        </View>
      )}

      {/* Non-interactive so it never steals a drag from the model. */}
      {interactive && (
        <Text style={styles.hint} pointerEvents="none">
          Drag to spin
        </Text>
      )}

      {onExpand && (
        <TouchableOpacity style={styles.expand} onPress={onExpand} hitSlop={10} activeOpacity={0.8}>
          <Ionicons name="expand" size={16} color={COLORS.text} />
        </TouchableOpacity>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { backgroundColor: "#0B0C0E", overflow: "hidden" },
  web: { flex: 1, backgroundColor: "#0B0C0E" },
  loading: { ...StyleSheet.absoluteFillObject, alignItems: "center", justifyContent: "center" },

  empty: { alignItems: "center", justifyContent: "center", gap: 8 },
  emptyLabel: { color: COLORS.textDim, fontSize: 16, fontWeight: "700" },
  emptyHint: { color: "#4A4A4A", fontSize: 13 },

  // Top-left, opposite the expand button — the bottom belongs to the host's
  // caption (year/make/model), and centring this collided with it.
  hint: {
    position: "absolute",
    top: 16,
    left: 16,
    color: "rgba(255,255,255,0.30)",
    fontSize: 11.5,
    fontWeight: "600",
  },
  expand: {
    position: "absolute",
    top: 10,
    right: 10,
    width: 32,
    height: 32,
    borderRadius: 16,
    backgroundColor: "rgba(28,28,30,0.72)",
    alignItems: "center",
    justifyContent: "center",
  },
});
