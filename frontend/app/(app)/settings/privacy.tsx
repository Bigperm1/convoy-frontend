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

      <SectionLabel>AVATAR LIVE</SectionLabel>
      <SettingsCard>
        <RadioRow icon="car-sport" iconColor="#00C46A" title="Full" subtitle="Always on your convoy's map: live while you drive, parked at your car when you're not. Your real location away from the car is never shared." selected={getAvatarMode(settings) === "full"} onSelect={() => setAvatarMode("full")} />
        <Divider />
        <RadioRow icon="car-outline" iconColor="#0A84FF" title="Partial" subtitle="Live while you're connected to your car; disconnect and you stay pinned at your car's last spot. Reconnect to go live." selected={getAvatarMode(settings) === "partial"} onSelect={() => setAvatarMode("partial")} />
        <Divider />
        <RadioRow icon="eye-off-outline" iconColor="#8E8E93" title="Ghost" subtitle="Invisible — your convoy never sees you, driving or parked." selected={getAvatarMode(settings) === "ghost"} onSelect={() => setAvatarMode("ghost")} />
      </SettingsCard>
      <HelpText>{`Full and Partial both keep you on the map at your car — live while you drive, pinned at your car's spot when you disconnect, never your real location away from it. Ghost hides you completely.`}</HelpText>
    </SettingsPage>
  );
}
