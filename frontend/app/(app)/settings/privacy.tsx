import React from "react";
import { useSettings, getAvatarMode, setAvatarMode } from "../../../src/settings";
import { SettingsPage, SectionLabel, SettingsCard, ToggleRow, RadioRow, Divider, HelpText } from "../../../src/components/settingsKit";

export default function PrivacyPage() {
  const [settings, setSettings] = useSettings();
  return (
    <SettingsPage title="Visibility & Comms">
      <SectionLabel>COMMS</SectionLabel>
      <SettingsCard>
        <ToggleRow icon="radio-outline" iconColor="#FF6A00" title="Comms Live" subtitle="Hear & broadcast walkie-talkie on your clubs. Off = radio silence." value={settings.commsLive} onChange={(v) => setSettings({ commsLive: v })} />
        <Divider />
        <ToggleRow icon="people-outline" iconColor="#30D158" title="Nearby" subtitle="Show how many crew members are near you on the Comms screen." value={settings.showNearby} onChange={(v) => setSettings({ showNearby: v })} />
      </SettingsCard>
      <HelpText>{`Your car only ever appears on maps inside clubs you've joined — strangers from outside the crew can never see you. Choose how you appear with Avatar Live below.`}</HelpText>

      <SectionLabel>APPEARANCE ON THE CREW MAP</SectionLabel>
      <SettingsCard>
        <RadioRow icon="car-sport" iconColor="#00C46A" title="Visible" subtitle="Your car is on the crew map — moving while you're in it, parked at the car's own spot once you've left it. Your real location away from the car is never shared." selected={getAvatarMode(settings) === "visible"} onSelect={() => setAvatarMode("visible")} />
        <Divider />
        <RadioRow icon="eye-off-outline" iconColor="#8E8E93" title="Ghost" subtitle="Invisible — your crew never sees you, driving or parked." selected={getAvatarMode(settings) === "ghost"} onSelect={() => setAvatarMode("ghost")} />
      </SettingsCard>
      <HelpText>{`What the crew sees is your CAR, never you. It moves while you're driving it, and once you leave it, it stays put at the car's own last spot — so walking away from it shares nothing. Ghost hides you completely.`}</HelpText>
    </SettingsPage>
  );
}
