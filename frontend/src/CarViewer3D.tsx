// CarViewer3D — full-screen interactive 3D car viewer (Jeff's ask 8/20: "the
// car in 3d where i can use my finger to move it around").
//
// A WebView running Google's <model-viewer> — finger orbit, pinch zoom,
// inertia, slow auto-rotate — loading the SAME https GLB the map renders, so
// the garage shows exactly what the convoy sees. Opened by tapping the garage
// hero on any colour that has a 3D model. All-JS: react-native-webview and the
// model URLs were already in the app, so this ships OTA.

import React from "react";
import { ActivityIndicator, Modal, StyleSheet, Text, TouchableOpacity, View } from "react-native";
import { WebView } from "react-native-webview";
import { Ionicons } from "@expo/vector-icons";
import { COLORS } from "./theme";

export default function CarViewer3D({
  visible,
  glbUrl,
  title,
  onClose,
}: {
  visible: boolean;
  glbUrl: string | null;
  title?: string;
  onClose: () => void;
}) {
  if (!glbUrl) return null;
  const html = `<!DOCTYPE html><html><head>
<meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no">
<script type="module" src="https://ajax.googleapis.com/ajax/libs/model-viewer/3.5.0/model-viewer.min.js"></script>
<style>
  html,body{margin:0;height:100%;background:#0B0C0E;overflow:hidden}
  model-viewer{width:100%;height:100%;--poster-color:transparent;background:#0B0C0E}
</style></head><body>
<model-viewer
  src="${glbUrl}"
  camera-controls
  auto-rotate
  auto-rotate-delay="1200"
  rotation-per-second="8deg"
  camera-orbit="215deg 76deg 105%"
  min-camera-orbit="auto 55deg auto"
  max-camera-orbit="auto 92deg auto"
  min-field-of-view="18deg"
  max-field-of-view="42deg"
  interaction-prompt="none"
  exposure="1.05"
  shadow-intensity="0.9"
  shadow-softness="0.7"
  touch-action="none">
</model-viewer>
</body></html>`;
  return (
    <Modal visible={visible} animationType="fade" onRequestClose={onClose}>
      <View style={styles.root}>
        <WebView
          originWhitelist={["*"]}
          source={{ html, baseUrl: "https://localhost" }}
          style={styles.web}
          startInLoadingState
          renderLoading={() => (
            <View style={styles.loading}>
              <ActivityIndicator color={COLORS.brand} size="large" />
              <Text style={styles.loadingText}>Rolling it out…</Text>
            </View>
          )}
          javaScriptEnabled
          domStorageEnabled
          allowsInlineMediaPlayback
        />
        <View style={styles.topBar} pointerEvents="box-none">
          <TouchableOpacity onPress={onClose} style={styles.close} hitSlop={12}>
            <Ionicons name="close" size={24} color={COLORS.text} />
          </TouchableOpacity>
          {title ? <Text style={styles.title}>{title}</Text> : null}
          <View style={styles.close} />
        </View>
        <Text style={styles.hint}>Drag to spin · pinch to zoom</Text>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: "#0B0C0E" },
  web: { flex: 1, backgroundColor: "#0B0C0E" },
  loading: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: "#0B0C0E",
    alignItems: "center",
    justifyContent: "center",
    gap: 10,
  },
  loadingText: { color: COLORS.textDim, fontSize: 13 },
  topBar: {
    position: "absolute",
    top: 54,
    left: 0,
    right: 0,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: 14,
  },
  close: {
    width: 40,
    height: 40,
    borderRadius: 20,
    backgroundColor: "rgba(28,28,30,0.72)",
    alignItems: "center",
    justifyContent: "center",
  },
  title: { color: COLORS.text, fontSize: 16, fontWeight: "700" },
  hint: {
    position: "absolute",
    bottom: 42,
    alignSelf: "center",
    color: COLORS.textDim,
    fontSize: 12.5,
  },
});
