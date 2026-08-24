import React from "react";
import { useSettings } from "../../../src/settings";
import { SettingsPage, SectionLabel, SettingsCard, ToggleRow, Divider, HelpText } from "../../../src/components/settingsKit";

export default function MapLayersPage() {
  const [settings, setSettings] = useSettings();
  return (
    <SettingsPage title="Map Layers">
      <SectionLabel>OVERLAYS</SectionLabel>
      <SettingsCard>
        <ToggleRow icon="cloudy" iconColor="#5AC8FA" title="Weather" subtitle="Temperature, wind & precipitation overlay on the map" value={settings.showWeatherLayer} onChange={(v) => setSettings({ showWeatherLayer: v })} />
        <Divider />
        <ToggleRow icon="camera" iconColor="#FF453A" title="Speed cameras" subtitle="Show fixed speed cameras and get a Scout voice alert as you approach (OpenStreetMap)" value={settings.speedCameras !== false} onChange={(v) => setSettings({ speedCameras: v })} feature="speed_cameras" />
        <Divider />
        <ToggleRow icon="warning" iconColor="#FF9F0A" title="Road incidents" subtitle="Official BC accidents, construction & closures with a Scout callout for major ones (DriveBC). British Columbia only." value={settings.roadIncidents !== false} onChange={(v) => setSettings({ roadIncidents: v })} feature="road_incidents" />
        {settings.roadIncidents !== false && (
          <>
            <Divider />
            <ToggleRow icon="alert-circle" iconColor="#FF453A" title="Major incidents" subtitle="Red pins — accidents & closures (major / moderate)" value={settings.roadIncidentsRed !== false} onChange={(v) => setSettings({ roadIncidentsRed: v })} />
            <Divider />
            <ToggleRow icon="information-circle" iconColor="#8E8E93" title="Minor incidents" subtitle="Grey pins — minor roadwork & info events. Off by default to keep the map clean." value={settings.roadIncidentsGrey === true} onChange={(v) => setSettings({ roadIncidentsGrey: v })} />
          </>
        )}
        <Divider />
        <ToggleRow icon="location" iconColor="#2DEC86" title="Place pins" subtitle="Show the pin markers for category search results. Gas prices and place names always stay visible." value={settings.showPlacePins !== false} onChange={(v) => setSettings({ showPlacePins: v })} />
      </SettingsCard>
      <HelpText>{`These persist across launches. Traffic and Hazard pins are toggled from the map's own Layers button since you flip those while looking at the map.`}</HelpText>
    </SettingsPage>
  );
}
