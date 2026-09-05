import React from "react";
import { useSettings } from "../../../src/settings";
import { SettingsPage, SectionLabel, SettingsCard, ToggleRow, Divider, HelpText } from "../../../src/components/settingsKit";

export default function DeveloperPage() {
  const [settings, setSettings] = useSettings();
  return (
    <SettingsPage title="Developer">
      <SectionLabel>DIAGNOSTICS</SectionLabel>
      <SettingsCard>
        {/* Turning overlays OFF also clears the nested force-starve switch's persisted
            value — Codex review (2026-09-05) caught that leaving it `true` while the
            row that controls it disappears meant a forgotten sim run could keep
            forcing "starved" across restarts with no visible toggle. The force row's
            OWN onChange below is untouched — this only fires when overlays themselves
            are turned off. src/timerLiveness.ts also resets the flag at load as a
            second, session-scoped backstop, so it can never outlive an app restart
            even if this write is missed. */}
        <ToggleRow icon="bug-outline" iconColor="#8E8E93" title="Debug overlays" subtitle="Show diagnostic readouts on the map and CarPlay — off keeps the screen clean" value={settings.debugOverlays === true} onChange={(v) => setSettings(v ? { debugOverlays: v } : { debugOverlays: v, debugForceTimerStarve: false })} />
        <Divider />
        <ToggleRow icon="car-sport-outline" iconColor="#8E8E93" title="CarPlay debug" subtitle="Show the feed breadcrumb + readouts on the CarPlay screen — off by default" value={settings.carplayDebug === true} onChange={(v) => setSettings({ carplayDebug: v })} />
        {settings.debugOverlays === true && (
          <>
            <Divider />
            <ToggleRow icon="hourglass-outline" iconColor="#8E8E93" title="Force timer starvation" subtitle="SIM ONLY — makes the car surface act as if JS timers are frozen (real GPS/route keep working) to test the phone-locked fallback. Turn off when done." value={settings.debugForceTimerStarve === true} onChange={(v) => setSettings({ debugForceTimerStarve: v })} />
          </>
        )}
      </SettingsCard>
      <HelpText>Diagnostics for troubleshooting. Leave both off for a clean screen.</HelpText>
    </SettingsPage>
  );
}
