import React from "react";
import { useSettings } from "../../../src/settings";
import { SettingsPage, SectionLabel, SettingsCard, RadioRow, Divider, HelpText } from "../../../src/components/settingsKit";

export default function MapViewPage() {
  const [settings, setSettings] = useSettings();
  return (
    <SettingsPage title="Map View">
      <SectionLabel>ORIENTATION</SectionLabel>
      <SettingsCard>
        <RadioRow
          icon="navigate" iconColor="#0A84FF" title="Heading Up"
          subtitle="Drone view, map rotates under the car, 45° pitch, car always points up"
          selected={settings.mapView === "heading_up"}
          onSelect={() => setSettings({ mapView: "heading_up" })}
        />
        <Divider />
        <RadioRow
          icon="compass-outline" iconColor="#34C759" title="North Up"
          subtitle="Classic view, map stays fixed north, flat with no pitch, car rotates on top"
          selected={settings.mapView === "north_up"}
          onSelect={() => setSettings({ mapView: "north_up" })}
        />
      </SettingsCard>
      <HelpText>Heading Up is the default and feels like Waze/Google during driving. North Up keeps the world steady — helpful for getting your bearings or scanning a wide area. Your choice persists across launches.</HelpText>
    </SettingsPage>
  );
}
