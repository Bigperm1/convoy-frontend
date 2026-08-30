import React from "react";
import { useSettings } from "../../../src/settings";
import { SettingsPage, SectionLabel, SettingsCard, ToggleRow, Divider, HelpText } from "../../../src/components/settingsKit";

export default function MapLayersPage() {
  const [settings, setSettings] = useSettings();
  return (
    <SettingsPage title="Map Layers">
      <SectionLabel>OVERLAYS</SectionLabel>
      <SettingsCard>
        {/* ⚠ THIS SUBTITLE PROMISED A MAP OVERLAY THAT HAS NEVER EXISTED (fixed 2026-08-30).
            It read "Temperature, wind & precipitation overlay on the map". There is no
            overlay: `showWeatherLayer` gates the HUD CHIP only (src/weatherLayer.ts — a
            current-conditions fetch, no RasterSource anywhere in the app). The copy now
            says what the switch does.

            THE OVERLAY IS PARKED, and here is the research so nobody re-runs it:
            • The Weather Company (ex-IBM, now Francisco Partners) sells radar tiles at a
              published $500/mo on an annual term — and their own docs say their CANADIAN
              radar carries ECCC attribution, i.e. we would pay $6k/yr to be resold
              Canadian government data that is free direct. A CarPlay app (Storm Radar,
              shipped 2026-08-30) exposes no API to other apps either way.
            • The free, no-key source that WOULD work: ECCC GeoMet `RADAR_1KM_RRAI`.
              Probed live 2026-08-30 — HTTP 200, RGBA PNG with real alpha, ~0.36 s, licence
              explicitly permits commercial use with attribution. GetFeatureInfo at Seattle
              returns class "Undetected" exactly as Vancouver does, so it covers BC AND the
              Washington run in one layer.
            • WHY IT IS PARKED ANYWAY — the zoom argument, not the cost one. CHASE_ZOOM_STOPS
              runs z17 parked → z14 highway → z12.8 fast. At 49°N, z17 spans ~304 m across
              the WHOLE screen against 1 km data: the entire display is less than one radar
              cell. A flat colour wash. Radar only becomes a picture around z8-10, i.e. a
              route-overview camera we do not have yet. Build it there, or not at all.
            • And animation is independently out: ECCC's usage policy prohibits "bulk and
              batch retrieval of WMS tiles" and thresholds at 86,400 req/day. Static single
              frame at 170 members ≈ 27,200/day (fine); a 10-frame loop ≈ 272,000/day —
              3.1× over, and the exact behaviour they block for. */}
        <ToggleRow icon="cloudy" iconColor="#5AC8FA" title="Weather" subtitle="Current conditions in the map HUD — temperature, wind & precipitation" value={settings.showWeatherLayer} onChange={(v) => setSettings({ showWeatherLayer: v })} />
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
