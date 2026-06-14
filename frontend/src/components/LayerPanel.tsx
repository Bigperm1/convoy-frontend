// LayerPanel — floating panel for toggling map layers on/off.
// Shown when the user taps the layers FAB on the map screen.
// Layers:
//   • Weather  — Google Weather API current conditions overlay + HUD chip
//   • 3D Map   — hybridFlyover (iOS) / 3D buildings toggle

import React from "react";
import {
  View, Text, StyleSheet, TouchableOpacity, Switch, Platform, Modal,
} from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { BlurView } from "expo-blur";

export type LayerState = {
  showWeatherLayer: boolean;
  show3DMap: boolean;
};

type Props = {
  visible: boolean;
  layers: LayerState;
  onToggle: (key: keyof LayerState, value: boolean) => void;
  onClose: () => void;
};

type LayerRow = {
  key: keyof LayerState;
  label: string;
  subtitle: string;
  icon: any;
  iconColor: string;
  platformNote?: string;
};

const LAYER_ROWS: LayerRow[] = [
  {
    key: "showWeatherLayer",
    label: "Weather",
    subtitle: "Current conditions, temp & wind",
    icon: "partly-sunny",
    iconColor: "#2DEC86",
  },
  {
    key: "show3DMap",
    label: "3D Map",
    subtitle: Platform.OS === "ios" ? "Flyover mode with building extrusions" : "Satellite hybrid with 3D buildings",
    icon: "cube",
    iconColor: "#5AC8FA",
    platformNote: Platform.OS === "android" ? "Limited on Android" : undefined,
  },
];

export default function LayerPanel({ visible, layers, onToggle, onClose }: Props) {
  return (
    <Modal
      visible={visible}
      transparent
      animationType="fade"
      statusBarTranslucent
      onRequestClose={onClose}
    >
      <TouchableOpacity style={styles.backdrop} activeOpacity={1} onPress={onClose} />
      <View style={styles.panelWrap} pointerEvents="box-none">
        <View style={styles.panel}>
          {/* Header */}
          <View style={styles.header}>
            <Ionicons name="layers" size={18} color="#2DEC86" />
            <Text style={styles.headerText}>Map Layers</Text>
            <TouchableOpacity onPress={onClose} hitSlop={{ top: 12, bottom: 12, left: 12, right: 12 }}>
              <Ionicons name="close" size={20} color="rgba(255,255,255,0.5)" />
            </TouchableOpacity>
          </View>

          {/* Layer rows */}
          {LAYER_ROWS.map((row) => (
            <TouchableOpacity
              key={row.key}
              style={styles.row}
              activeOpacity={0.7}
              onPress={() => onToggle(row.key, !layers[row.key])}
            >
              {/* Icon */}
              <View style={[styles.iconWrap, { backgroundColor: layers[row.key] ? row.iconColor + "22" : "rgba(255,255,255,0.06)" }]}>
                <Ionicons name={row.icon} size={20} color={layers[row.key] ? row.iconColor : "rgba(255,255,255,0.4)"} />
              </View>

              {/* Labels */}
              <View style={styles.labelWrap}>
                <Text style={styles.label}>{row.label}</Text>
                <Text style={styles.subtitle} numberOfLines={1}>
                  {row.subtitle}
                  {row.platformNote ? `  \u2022  ${row.platformNote}` : ""}
                </Text>
              </View>

              {/* Toggle */}
              <Switch
                value={layers[row.key]}
                onValueChange={(v) => onToggle(row.key, v)}
                trackColor={{ false: "rgba(255,255,255,0.12)", true: row.iconColor + "99" }}
                thumbColor={layers[row.key] ? row.iconColor : "rgba(255,255,255,0.6)"}
                ios_backgroundColor="rgba(255,255,255,0.12)"
              />
            </TouchableOpacity>
          ))}
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: "rgba(0,0,0,0.35)",
  },
  panelWrap: {
    position: "absolute",
    right: 16,
    top: Platform.OS === "ios" ? 110 : 90,
    width: 280,
  },
  panel: {
    backgroundColor: "rgba(18,18,22,0.97)",
    borderRadius: 18,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: "rgba(255,255,255,0.12)",
    overflow: "hidden",
    ...Platform.select({
      ios: { shadowColor: "#000", shadowOpacity: 0.5, shadowRadius: 20, shadowOffset: { width: 0, height: 8 } },
      android: { elevation: 12 },
    }),
  },
  header: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: 16,
    paddingTop: 14,
    paddingBottom: 10,
    gap: 8,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: "rgba(255,255,255,0.08)",
  },
  headerText: {
    flex: 1,
    color: "#F4F4F4",
    fontSize: 15,
    fontWeight: "700",
    letterSpacing: 0.3,
  },
  row: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: 14,
    paddingVertical: 12,
    gap: 12,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: "rgba(255,255,255,0.06)",
  },
  iconWrap: {
    width: 38,
    height: 38,
    borderRadius: 10,
    alignItems: "center",
    justifyContent: "center",
  },
  labelWrap: { flex: 1 },
  label: { color: "#F4F4F4", fontSize: 14, fontWeight: "600" },
  subtitle: { color: "#808080", fontSize: 11, marginTop: 2 },
});
