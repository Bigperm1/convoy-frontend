import React from "react";
import { View, Text, StyleSheet } from "react-native";
import { COLORS } from "../theme";
import { SettingsPage } from "./settingsKit";

// Reusable legal/content page (Privacy Policy, Terms, Safety). Renders a titled
// scaffold with sections + a visible placeholder banner so it's obvious the copy
// still needs replacing before App Store submission.
export type LegalSection = { heading: string; body: string };

export default function LegalPage({
  title,
  updated,
  intro,
  sections,
}: {
  title: string;
  updated: string;
  intro?: string;
  sections: LegalSection[];
}) {
  return (
    <SettingsPage title={title}>
      <View style={styles.placeholderNote}>
        <Text style={styles.placeholderText}>
          Placeholder copy — replace with your finalized wording before App Store submission.
        </Text>
      </View>
      <Text style={styles.updated}>Last updated {updated}</Text>
      {!!intro && <Text style={styles.body}>{intro}</Text>}
      {sections.map((s, i) => (
        <View key={i} style={{ marginTop: 18 }}>
          <Text style={styles.heading}>{s.heading}</Text>
          <Text style={styles.body}>{s.body}</Text>
        </View>
      ))}
    </SettingsPage>
  );
}

const styles = StyleSheet.create({
  placeholderNote: {
    backgroundColor: "rgba(255,159,10,0.14)", borderWidth: 1, borderColor: "rgba(255,159,10,0.5)",
    borderRadius: 12, padding: 12, marginTop: 6,
  },
  placeholderText: { color: "#FFB84D", fontSize: 12, fontWeight: "600", lineHeight: 16 },
  updated: { color: COLORS.textDim, fontSize: 12, marginTop: 16 },
  heading: { color: COLORS.text, fontSize: 16, fontWeight: "700", marginBottom: 6 },
  body: { color: COLORS.textDim, fontSize: 14, lineHeight: 21, marginTop: 6 },
});
