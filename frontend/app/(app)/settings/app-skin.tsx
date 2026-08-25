import React, { useEffect, useState } from "react";
import { View, Text, StyleSheet } from "react-native";
import { LinearGradient } from "expo-linear-gradient";
import {
  SettingsPage, SectionLabel, SettingsCard, RadioRow, Divider, HelpText,
} from "../../../src/components/settingsKit";
import { useAppSkin, setSkinChoice, entitledSkin, type SkinChoice } from "../../../src/appSkin";
import { getSettings } from "../../../src/settings";
import { skin, TIER_SKIN, type VisualTier } from "../../../src/tierTheme";
import { subscribeEntitlement } from "../../../src/entitlements";

/**
 * App Skin — the metal the whole app wears.
 *
 * Jeff, 2026-08-24: "everything on the app turns to silver and gold when the tier are
 * purchased... when silver is purchased you can switch back to green but cant get gold?"
 *
 * The ladder IS the feature, so the locked rows are deliberately still VISIBLE: a free
 * driver sees the silver and gold options wearing their H, which is the upsell. A dead
 * hidden row sells nothing. See DESIGN.md and src/appSkin.ts.
 */

/** The skin's own name. Deliberately NOT TierSkin.label — that is the PAYWALL wording
 *  ("Premium" / "Ultra Premium"), and here we are naming a colour the customer wears,
 *  not a thing they must buy. The tier is the SUBTITLE instead. */
const SKIN_NAME: Record<VisualTier, string> = {
  brand: "Hairpin Green",
  premium: "Silver",
  ultra: "Gold",
};

const OPTIONS: {
  key: VisualTier;
  icon: any;
  title: string;
  sub: string;
  feature?: "app_skin_silver" | "app_skin_gold";
}[] = [
  { key: "brand",   icon: "leaf",     title: SKIN_NAME.brand,   sub: "The original. Always yours." },
  { key: "premium", icon: "sparkles", title: SKIN_NAME.premium, sub: "Premium", feature: "app_skin_silver" },
  { key: "ultra",   icon: "trophy",   title: SKIN_NAME.ultra,   sub: "Ultra Premium", feature: "app_skin_gold" },
];

function Swatch({ tier }: { tier: VisualTier }) {
  const sk = TIER_SKIN[tier];
  return (
    <LinearGradient
      colors={sk.colors}
      locations={sk.locations}
      style={[styles.swatch, { borderColor: sk.rim }]}
    />
  );
}

export default function AppSkinPage() {
  const active = useAppSkin();
  const [choice, setChoice] = useState<SkinChoice>((getSettings().appSkin ?? "auto") as SkinChoice);
  // Buying a tier mid-screen should light the new row up immediately.
  const [, bump] = useState(0);
  useEffect(() => subscribeEntitlement(() => bump((n) => n + 1)), []);

  const maxTier = entitledSkin();

  return (
    <SettingsPage title="App Skin">
      <View style={styles.preview}>
        <Swatch tier={active} />
        <View style={{ flex: 1 }}>
          <Text style={[styles.previewTitle, { color: skin(active).accent }]}>
            {SKIN_NAME[active]}
          </Text>
          <Text style={styles.previewSub}>
            {choice === "auto" ? "Following your tier" : "Your pick"}
          </Text>
        </View>
      </View>

      <SectionLabel>APP SKIN</SectionLabel>
      <SettingsCard>
        <RadioRow
          icon="color-wand"
          iconColor={skin(maxTier).accent}
          title="Automatic"
          subtitle="Always wear the best metal your tier unlocks"
          selected={choice === "auto"}
          onSelect={() => { setChoice("auto"); setSkinChoice("auto"); }}
        />
        {OPTIONS.map((o) => (
          <React.Fragment key={o.key}>
            <Divider />
            <RadioRow
              icon={o.icon}
              iconColor={TIER_SKIN[o.key].accent}
              title={o.title}
              subtitle={o.sub}
              selected={choice === o.key}
              feature={o.feature}
              onSelect={() => { setChoice(o.key); setSkinChoice(o.key); }}
            />
          </React.Fragment>
        ))}
      </SettingsCard>

      <HelpText>
        {`Your metal arrives with your tier — buy Premium and the app turns silver, buy Ultra Premium and it turns gold. You can always drop back down (gold can wear silver or green), but you can never wear a metal above your tier.\n\nThe map never changes: the route line, traffic colours and hazards stay exactly as they are, because those colours mean something at speed.`}
      </HelpText>
    </SettingsPage>
  );
}

const styles = StyleSheet.create({
  preview: { flexDirection: "row", alignItems: "center", gap: 14, paddingHorizontal: 4, paddingBottom: 18, paddingTop: 4 },
  swatch: { width: 56, height: 56, borderRadius: 16, borderWidth: 1 },
  previewTitle: { fontSize: 22, fontWeight: "800", letterSpacing: -0.3 },
  previewSub: { color: "#808080", fontSize: 13, marginTop: 2 },
});
