import React, { useEffect, useState } from "react";
import { View, Text, StyleSheet, Alert } from "react-native";
import { LinearGradient } from "expo-linear-gradient";
import { useRouter } from "expo-router";
import {
  SettingsPage, SectionLabel, SettingsCard, RadioRow, Divider, HelpText,
} from "../../../src/components/settingsKit";
import {
  setSkinChoice, autoSkin, appSkinNow, skinForChoice, releaseSkinHold, useDiamondUnlocked, type SkinChoice,
} from "../../../src/appSkin";
import { playSkinWave } from "../../../src/skinWave";
import { canPlayWave } from "../../../src/ui/SkinUnlock";
import { SkinFade, useWaveMetal } from "../../../src/ui/SkinWave";
import { useReduceMotion } from "../../../src/motionPrefs";
import { haptics } from "../../../src/haptics";
import SkinSheen from "../../../src/components/SkinSheen";
import { getSettings } from "../../../src/settings";
import { skin, TIER_SKIN, type VisualTier } from "../../../src/tierTheme";
import { subscribeEntitlement } from "../../../src/entitlements";
import { COLORS } from "../../../src/theme";

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
  diamond: "Diamond",
};

const OPTIONS: {
  key: VisualTier;
  icon: any;
  title: string;
  sub: string;
  feature?: "app_skin_silver" | "app_skin_gold" | "app_skin_diamond";
}[] = [
  { key: "brand",   icon: "leaf",     title: SKIN_NAME.brand,   sub: "The original. Always yours." },
  { key: "premium", icon: "sparkles", title: SKIN_NAME.premium, sub: "With Silver", feature: "app_skin_silver" },
  { key: "ultra",   icon: "trophy",   title: SKIN_NAME.ultra,   sub: "With Gold", feature: "app_skin_gold" },
  { key: "diamond", icon: "diamond",  title: SKIN_NAME.diamond, sub: "Unlocked by your 1st 3D scan", feature: "app_skin_diamond" },
];

function Swatch({ tier }: { tier: VisualTier }) {
  const sk = TIER_SKIN[tier];
  return (
    <LinearGradient
      colors={sk.colors}
      locations={sk.locations}
      style={[styles.swatch, { borderColor: sk.rim, overflow: "hidden" }]}
    >
      <SkinSheen sk={sk} />
    </LinearGradient>
  );
}

export default function AppSkinPage() {
  const router = useRouter();
  const reduce = useReduceMotion();
  // The preview turns with the wave (src/skinWave.ts) — it is the first thing the band crosses.
  const active = useWaveMetal(0.14);
  const diamondOpen = useDiamondUnlocked();
  const [choice, setChoice] = useState<SkinChoice>((getSettings().appSkin ?? "auto") as SkinChoice);
  // Buying a tier mid-screen should light the new row up immediately.
  const [, bump] = useState(0);
  useEffect(() => subscribeEntitlement(() => bump((n) => n + 1)), []);

  const autoTier = autoSkin();
  const waitingForScan = choice === "diamond" && !diamondOpen;

  // A pick carries the whole app to the new metal as the unlock wave (Jeff, 2026-09-23: "all the buttons etc.. on the
  // screen turning to the next tier skin color in real time") — one tick on the tap, the band does the rest.
  const pick = (next: SkinChoice) => {
    haptics.tick();
    setChoice(next);
    void playSkinWave({
      from: appSkinNow(),
      to: skinForChoice(next),
      reduce,
      canPlay: canPlayWave(),
      apply: async () => { await releaseSkinHold(); await setSkinChoice(next); },
    });
  };

  // Diamond is earned, not bought: the first 3D scan unlocks it (Jeff, 2026-09-23).
  const explainDiamond = () => {
    haptics.tick();
    Alert.alert(
      "Your 1st 3D scan unlocks Diamond",
      "Scan your car in the Garage. The moment your 3D car is built, the whole app turns Diamond.",
      [{ text: "Not now", style: "cancel" }, { text: "Go to Garage", onPress: () => router.push("/(app)/garage" as any) }],
    );
  };

  return (
    <SettingsPage title="App Skin">
      <View style={styles.preview}>
        <SkinFade render={(t) => <Swatch tier={t} />} />
        <View style={{ flex: 1 }}>
          <Text style={[styles.previewTitle, { color: skin(active).accent }]}>
            {SKIN_NAME[active]}
          </Text>
          <Text style={styles.previewSub}>
            {waitingForScan
              ? "Diamond unlocks with your 1st 3D scan"
              : choice === "auto" ? "Following your plan" : "Your pick"}
          </Text>
        </View>
      </View>

      <SectionLabel>APP SKIN</SectionLabel>
      <SettingsCard>
        <RadioRow
          icon="color-wand"
          iconColor={skin(autoTier).accent}
          title="Automatic"
          subtitle="Always wear the best metal you have unlocked"
          selected={choice === "auto"}
          onSelect={() => pick("auto")}
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
              lockedNote={o.key === "diamond" && !diamondOpen}
              onSelect={() => (o.key === "diamond" && !diamondOpen ? explainDiamond() : pick(o.key))}
            />
          </React.Fragment>
        ))}
      </SettingsCard>

      <HelpText>
        {`Your metal arrives with your plan — Silver turns the app silver, Gold turns it gold, and your 1st 3D scan unlocks Diamond. You can always drop back down (gold can wear silver or green), but you can never wear a metal above your plan.\n\nOn the map, the colours that MEAN something never change: the route line, traffic colours, hazards and speed cameras stay exactly as they are, because you read those at speed. Your search pins do wear your metal.`}
      </HelpText>
    </SettingsPage>
  );
}

const styles = StyleSheet.create({
  preview: { flexDirection: "row", alignItems: "center", gap: 14, paddingHorizontal: 4, paddingBottom: 18, paddingTop: 4 },
  swatch: { width: 56, height: 56, borderRadius: 16, borderWidth: 1 },
  previewTitle: { fontSize: 22, fontWeight: "800", letterSpacing: -0.3 },
  previewSub: { color: COLORS.textDim, fontSize: 13, marginTop: 2 },
});
