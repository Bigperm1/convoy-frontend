import React, { useState } from "react";
import { View, Text, TouchableOpacity } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { useSettings, getRouteColor } from "../../../src/settings";
import { SettingsPage, SectionLabel, SettingsCard, HelpText } from "../../../src/components/settingsKit";

const ROUTE_PRESETS = [
  "#2DEC86", "#0A84FF", "#00D6E0", "#5E5CE6", "#BF5CFF",
  "#FF2D95", "#FF3B30", "#FF9500", "#FFD60A", "#FFFFFF",
];

// HSL → #rrggbb so a tapped hue maps to a fixed vivid saturation/lightness.
function hslToHex(h: number, s: number, l: number): string {
  s /= 100; l /= 100;
  const k = (n: number) => (n + h / 30) % 12;
  const a = s * Math.min(l, 1 - l);
  const f = (n: number) => {
    const c = l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
    return Math.round(255 * c).toString(16).padStart(2, "0");
  };
  return `#${f(0)}${f(8)}${f(4)}`;
}

export default function RouteColorPage() {
  const [settings, setSettings] = useSettings();
  const [spectrumW, setSpectrumW] = useState(0);
  const routeColor = getRouteColor(settings);

  return (
    <SettingsPage title="Route Color">
      <SectionLabel>PRESETS</SectionLabel>
      <SettingsCard>
        <View style={{ padding: 14 }}>
          <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 12 }}>
            {ROUTE_PRESETS.map((hex) => {
              const active = routeColor.toLowerCase() === hex.toLowerCase();
              return (
                <TouchableOpacity
                  key={hex}
                  activeOpacity={0.8}
                  onPress={() => setSettings({ routeColor: hex })}
                  style={{ width: 34, height: 34, borderRadius: 17, backgroundColor: hex, borderWidth: active ? 3 : 1, borderColor: active ? "#FFFFFF" : "rgba(255,255,255,0.2)", alignItems: "center", justifyContent: "center" }}
                >
                  {active && <Ionicons name="checkmark" size={18} color={hex === "#FFFFFF" || hex === "#FFD60A" ? "#000" : "#FFF"} />}
                </TouchableOpacity>
              );
            })}
          </View>

          <Text style={{ color: "#808080", fontSize: 12, fontWeight: "600", marginTop: 16, marginBottom: 8 }}>Custom — tap the spectrum</Text>
          <TouchableOpacity
            activeOpacity={1}
            onLayout={(e) => setSpectrumW(e.nativeEvent.layout.width)}
            onPress={(e) => {
              if (spectrumW > 0) {
                const x = Math.max(0, Math.min(spectrumW, e.nativeEvent.locationX));
                setSettings({ routeColor: hslToHex(Math.round((x / spectrumW) * 360), 85, 55) });
              }
            }}
            style={{ height: 28, borderRadius: 8, overflow: "hidden", flexDirection: "row", borderWidth: 1, borderColor: "rgba(255,255,255,0.15)" }}
          >
            {Array.from({ length: 60 }).map((_, i) => (
              <View key={i} style={{ flex: 1, backgroundColor: hslToHex(Math.round((i / 59) * 360), 85, 55) }} />
            ))}
          </TouchableOpacity>

          <View style={{ flexDirection: "row", alignItems: "center", marginTop: 14, gap: 10 }}>
            <View style={{ width: 22, height: 22, borderRadius: 11, backgroundColor: routeColor, borderWidth: 1, borderColor: "rgba(255,255,255,0.3)" }} />
            <Text style={{ color: "#F4F4F4", fontSize: 14, fontWeight: "700" }}>{routeColor.toUpperCase()}</Text>
          </View>
        </View>
      </SettingsCard>
      <HelpText>Sets your route-line color on the map and CarPlay. Tap a preset, or tap anywhere on the spectrum for a custom color. The glow and the fade near your car follow the same color automatically.</HelpText>
    </SettingsPage>
  );
}
