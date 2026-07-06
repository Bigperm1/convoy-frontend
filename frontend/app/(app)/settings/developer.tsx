import React from "react";
import { useSettings } from "../../../src/settings";
import { SettingsPage, SectionLabel, SettingsCard, ToggleRow, Divider, HelpText } from "../../../src/components/settingsKit";

export default function DeveloperPage() {
  const [settings, setSettings] = useSettings();
  return (
    <SettingsPage title="Developer">
      <SectionLabel>DIAGNOSTICS</SectionLabel>
      <SettingsCard>
        <ToggleRow icon="bug-outline" iconColor="#8E8E93" title="Debug overlays" subtitle="Show diagnostic readouts on the map and CarPlay — off keeps the screen clean" value={settings.debugOverlays === true} onChange={(v) => setSettings({ debugOverlays: v })} />
        <Divider />
        <ToggleRow icon="car-sport-outline" iconColor="#8E8E93" title="CarPlay debug" subtitle="Show the feed breadcrumb + readouts on the CarPlay screen — off by default" value={settings.carplayDebug === true} onChange={(v) => setSettings({ carplayDebug: v })} />
      </SettingsCard>
      <HelpText>Diagnostics for troubleshooting. Leave both off for a clean screen.</HelpText>
    </SettingsPage>
  );
}
