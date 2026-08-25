import React from "react";
import { useSettings, getMapModeChoice } from "../../../src/settings";
import { SettingsPage, SectionLabel, SettingsCard, RadioRow, Divider, HelpText } from "../../../src/components/settingsKit";
import { useAccent } from "../../../src/appSkin";

const MODES = [
  { key: "auto", icon: "time", color: "#2DEC86", title: "Auto", sub: "Follows the time of day — dawn / day / dusk / night" },
  { key: "satellite", icon: "globe", color: "#0A84FF", title: "Satellite", sub: "Aerial imagery with road labels" },
  { key: "dawn", icon: "partly-sunny", color: "#FF9F0A", title: "Dawn", sub: "Soft morning light" },
  { key: "day", icon: "sunny", color: "#FFB300", title: "Day", sub: "Bright daytime" },
  { key: "dusk", icon: "cloudy-night", color: "#FF6A00", title: "Dusk", sub: "Warm evening light" },
  { key: "night", icon: "moon", color: "#5E5CE6", title: "Night", sub: "Dark 3D night map with buildings" },
] as const;

export default function MapModePage() {
  const [settings, setSettings] = useSettings();
  const accent = useAccent();
  return (
    <SettingsPage title="Map Mode">
      <SectionLabel>APPEARANCE</SectionLabel>
      <SettingsCard>
        {MODES.map((m, i) => (
          <React.Fragment key={m.key}>
            {i > 0 && <Divider />}
            <RadioRow
              icon={m.icon} iconColor={m.key === "auto" ? accent : m.color} title={m.title} subtitle={m.sub}
              selected={getMapModeChoice(settings) === m.key}
              onSelect={() => setSettings({ mapMode: m.key })}
            />
          </React.Fragment>
        ))}
      </SettingsCard>
      <HelpText>{`Pick how the map looks. Satellite shows aerial imagery; Dawn / Day / Dusk / Night use the Mapbox vector map with time-of-day lighting and 3D buildings. Stays in sync with the map's own Layers button.`}</HelpText>
    </SettingsPage>
  );
}
