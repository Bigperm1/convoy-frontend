import React from "react";
import { useSettings } from "../../../src/settings";
import { SettingsPage, SectionLabel, SettingsCard, ToggleRow, Divider, HelpText } from "../../../src/components/settingsKit";

export default function CommunityPage() {
  const [settings, setSettings] = useSettings();
  return (
    <SettingsPage title="Hairpin Community">
      <SectionLabel>REPORTS</SectionLabel>
      <SettingsCard>
        <ToggleRow icon="ribbon" iconColor="#2DEC86" title="Highlight convoy reports" subtitle="Gold border around hazards reported by fellow convoy drivers" value={settings.highlightConvoy} onChange={(v) => setSettings({ highlightConvoy: v })} badge="GOLD" />
        <Divider />
        <ToggleRow icon="musical-note" iconColor="#FF9F0A" title="Hairpin alert sound" subtitle="Subtle chime when a new community report appears nearby" value={settings.alertSound} onChange={(v) => setSettings({ alertSound: v })} />
      </SettingsCard>
      <HelpText>These convoy-originated reports are prioritized: they appear with a distinct gold border so you can tell at a glance which alerts came from your crew vs. the general feed.</HelpText>
    </SettingsPage>
  );
}
