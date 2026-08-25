import React from "react";
import { useSettings } from "../../../src/settings";
import { useAccent } from "../../../src/appSkin";
import { SettingsPage, SectionLabel, SettingsCard, ToggleRow, Divider, HelpText } from "../../../src/components/settingsKit";

export default function RoutePreferencesPage() {
  const [settings, setSettings] = useSettings();
  const accent = useAccent();
  return (
    <SettingsPage title="Route Preferences">
      <SectionLabel>AVOID</SectionLabel>
      <SettingsCard>
        <ToggleRow icon="cash-outline" iconColor="#30D158" title="Avoid tolls" subtitle="Skip toll roads when possible" value={settings.avoidTolls} onChange={(v) => setSettings({ avoidTolls: v })} />
        <Divider />
        <ToggleRow icon="speedometer-outline" iconColor="#FF9F0A" title="Avoid highways" subtitle="Prefer surface streets over freeways" value={settings.avoidHighways} onChange={(v) => setSettings({ avoidHighways: v })} />
        <Divider />
        <ToggleRow icon="boat-outline" iconColor="#5AC8FA" title="Avoid ferries" subtitle="Don't route over water crossings" value={settings.avoidFerries} onChange={(v) => setSettings({ avoidFerries: v })} />
      </SettingsCard>
      <HelpText>Applied to every directions request — including auto-reroute when you go off-route. Routes refresh automatically when you toggle a preference.</HelpText>

      <SectionLabel>ON THE ROAD</SectionLabel>
      <SettingsCard>
        <ToggleRow
          icon="timer-outline"
          iconColor={accent}
          title="Pitstop timer"
          subtitle="Start a stopwatch when you park at a gas station or food stop"
          value={settings.pitstop !== false}
          onChange={(v) => setSettings({ pitstop: v })}
        />
      </SettingsCard>
      <HelpText>Pull in for fuel or a bite and Hairpin starts the clock, then banks the stop into a total for the drive. Your arrival time already accounts for time spent stopped, so this is just so you know how long you were off the road.</HelpText>
    </SettingsPage>
  );
}
