import React from "react";
import { View, Text, TouchableOpacity } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { useSettings, getRouteColor } from "../../../src/settings";
import { SettingsPage, SectionLabel, SettingsCard, HelpText } from "../../../src/components/settingsKit";
import { haptics } from "../../../src/haptics";

type Swatch = { name: string; hex: string };

// The original presets MINUS the three that ARE the traffic colours (Jeff, 2026-09-23: "YES REMOVE THE TRAFFIC COLORS
// EXCEPT THE SYSTEM GREEN DONT TOUCH SCENIC"). Yellow #FFD60A / Orange #FF9500 / Red #FF3B30 are exactly
// CONGESTION_COLOR's moderate / heavy / severe (mapboxDirections.ts), so on a route in one of them the slowdowns
// vanish into the line. Green stays: it is the system colour, and "clear" traffic is drawn in the route colour anyway.
const PRESETS: Swatch[] = [
  { name: "Green", hex: "#2DEC86" }, { name: "Blue", hex: "#0A84FF" }, { name: "Cyan", hex: "#00D6E0" },
  { name: "Indigo", hex: "#5E5CE6" }, { name: "Purple", hex: "#BF5CFF" }, { name: "Pink", hex: "#FF2D95" },
  { name: "White", hex: "#FFFFFF" },
];
// A tester who already picked one keeps it — never silently flip a choice (CLAUDE.md, Settings defaults) — so the
// Current row still names it and says what it costs.
const TRAFFIC_COLOURS: Swatch[] = [
  { name: "Yellow", hex: "#FFD60A" }, { name: "Orange", hex: "#FF9500" }, { name: "Red", hex: "#FF3B30" },
];

// MORE COLOURS (Jeff, 2026-09-23: "maybe had like 20 more selectable colours that dont overlap the current
// selection.. remove the spectrum"). The spectrum never worked: onPress's locationX is relative to whichever of its
// 60 child strips took the touch, so every tap mapped to the red end. These twenty replace it, each MEASURED
// (CIEDE2000, tools in the 2026-09-23 session): ≥ 10.7 from every other swatch here and from the presets, ≥ 22
// from the traffic colours drawn ON the route (#FFD60A / #FF9500 / #FF3B30 — CONGESTION_COLOR in
// mapboxDirections.ts), and ≥ 14 from the day map's land, parks, roads and water — as visible as Cyan, more than
// the brand Green (11.3 against a park). No gold: a gold route line reads as traffic (DESIGN.md). Hue order.
const MORE: Swatch[] = [
  { name: "Rose", hex: "#C92E65" }, { name: "Coral", hex: "#FB9BA4" }, { name: "Lime", hex: "#ADF81C" },
  { name: "Moss", hex: "#7DB82F" }, { name: "Grass", hex: "#508B0F" }, { name: "Jade", hex: "#10A72E" },
  { name: "Emerald", hex: "#02945F" }, { name: "Turquoise", hex: "#52C49C" }, { name: "Spring", hex: "#1EFED7" },
  { name: "Teal", hex: "#079D8D" }, { name: "Sky", hex: "#19A7D5" }, { name: "Cobalt", hex: "#0B73AC" },
  { name: "Periwinkle", hex: "#8EA7FF" }, { name: "Violet", hex: "#897AD1" }, { name: "Lavender", hex: "#C197FF" },
  { name: "Plum", hex: "#AA68B7" }, { name: "Magenta", hex: "#B824C1" }, { name: "Bubblegum", hex: "#FFBCF6" },
  { name: "Orchid", hex: "#FF76F3" }, { name: "Flamingo", hex: "#FF8FC8" },
];

const ALL = [...PRESETS, ...MORE];

/** Black tick on a light swatch, white on a dark one (relative luminance). */
function tickColor(hex: string): string {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255)
    .map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b > 0.45 ? "#000" : "#FFF";
}

function SwatchGrid({ swatches, current, onPick }: { swatches: Swatch[]; current: string; onPick: (hex: string) => void }) {
  return (
    <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 12, padding: 14 }}>
      {swatches.map(({ name, hex }) => {
        const active = current === hex.toLowerCase();
        return (
          <TouchableOpacity
            key={hex}
            activeOpacity={0.8}
            onPress={() => onPick(hex)}
            accessibilityRole="button"
            accessibilityLabel={`${name} route line`}
            accessibilityState={{ selected: active }}
            hitSlop={4}
            style={{ width: 34, height: 34, borderRadius: 17, backgroundColor: hex, borderWidth: active ? 3 : 1, borderColor: active ? "#FFFFFF" : "rgba(255,255,255,0.2)", alignItems: "center", justifyContent: "center" }}
          >
            {active && <Ionicons name="checkmark" size={18} color={tickColor(hex)} />}
          </TouchableOpacity>
        );
      })}
    </View>
  );
}

export default function RouteColorPage() {
  const [settings, setSettings] = useSettings();
  const routeColor = getRouteColor(settings);
  const current = routeColor.toLowerCase();
  // A colour picked on the old spectrum is still honoured — it just has no swatch, so it reads "Custom".
  const traffic = TRAFFIC_COLOURS.find((s) => s.hex.toLowerCase() === current);
  const named = ALL.find((s) => s.hex.toLowerCase() === current)?.name ?? traffic?.name ?? "Custom";
  const pick = (hex: string) => {
    if (hex.toLowerCase() === current) return;
    haptics.tick();
    setSettings({ routeColor: hex });
  };

  return (
    <SettingsPage title="Route Color">
      <SectionLabel>CURRENT</SectionLabel>
      <SettingsCard>
        <View style={{ flexDirection: "row", alignItems: "center", gap: 12, padding: 14 }}>
          <View style={{ width: 44, height: 8, borderRadius: 4, backgroundColor: routeColor }} />
          <Text style={{ color: "#F4F4F4", fontSize: 15, fontWeight: "700" }}>{named}</Text>
          <Text style={{ color: "rgba(244,244,244,0.55)", fontSize: 13, fontWeight: "600" }}>{routeColor.toUpperCase()}</Text>
        </View>
        {!!traffic && (
          <Text style={{ color: "rgba(244,244,244,0.7)", fontSize: 12.5, fontWeight: "600", paddingHorizontal: 14, paddingBottom: 14, marginTop: -4 }}>
            {`Traffic is drawn in ${traffic.name.toLowerCase()} too, so slowdowns blend into this line. Pick another colour to see them.`}
          </Text>
        )}
      </SettingsCard>
      <SectionLabel>PRESETS</SectionLabel>
      <SettingsCard>
        <SwatchGrid swatches={PRESETS} current={current} onPick={pick} />
      </SettingsCard>
      <SectionLabel>MORE COLOURS</SectionLabel>
      <SettingsCard>
        <SwatchGrid swatches={MORE} current={current} onPick={pick} />
      </SettingsCard>
      <HelpText>Sets your route-line color on the map and CarPlay. The glow and the fade near your car follow the same color automatically. Traffic on your route is drawn in yellow, orange and red.</HelpText>
    </SettingsPage>
  );
}
