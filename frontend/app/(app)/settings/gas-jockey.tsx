import React from "react";
import { useSettings } from "../../../src/settings";
import { GAS_BRANDS, OCTANES } from "../../../src/gasJockey";
import { SettingsPage, SectionLabel, SettingsCard, ToggleRow, RadioRow, Divider, HelpText } from "../../../src/components/settingsKit";

export default function GasJockeyPage() {
  const [settings, setSettings] = useSettings();
  return (
    <SettingsPage title="Gas Jockey">
      <SectionLabel>BRANDS</SectionLabel>
      <SettingsCard>
        {GAS_BRANDS.map((b, i) => (
          <React.Fragment key={b.key}>
            {i > 0 && <Divider />}
            <ToggleRow
              icon="business" iconColor="#FF9F0A" title={b.label}
              value={(settings.gasBrands ?? {})[b.key] !== false}
              onChange={(v) => setSettings({ gasBrands: { ...(settings.gasBrands ?? {}), [b.key]: v } })}
            />
          </React.Fragment>
        ))}
        <Divider />
        <ToggleRow
          icon="ellipsis-horizontal-circle-outline" iconColor="#8E8E93" title="Other"
          subtitle="Unbranded & independent stations"
          value={settings.gasOther !== false}
          onChange={(v) => setSettings({ gasOther: v })}
        />
      </SettingsCard>
      <HelpText>{`Pick the chains you actually stop at — anything you switch off is hidden from the map's Gas pins. Leave them all on to see every station.`}</HelpText>

      <SectionLabel>OCTANE</SectionLabel>
      <SettingsCard>
        {OCTANES.filter((o) => o === "94").map((o, i) => (
          <React.Fragment key={o}>
            {i > 0 && <Divider />}
            <RadioRow
              icon="flame" iconColor="#FF9F0A" title="High Octane Premium" subtitle="Ultra 94"
              selected={settings.gasOctane === o}
              onSelect={() => setSettings({ gasOctane: settings.gasOctane === o ? null : o })}
            />
          </React.Fragment>
        ))}
      </SettingsCard>
      <HelpText>{`Show only stations that carry your fuel. Choosing an octane turns the others off; tap it again to clear and show all grades. Stations that don't publish fuel data stay visible.`}</HelpText>
    </SettingsPage>
  );
}
