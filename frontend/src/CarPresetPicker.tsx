import React from "react";
import { View, Text, TouchableOpacity, ScrollView, StyleSheet } from "react-native";
import { COLORS } from "./theme";
import { CAR_PRESETS, CarPreset } from "./carPresets";

type Props = {
  selectedMake?: string;
  selectedModel?: string;
  onSelect: (p: CarPreset) => void;
};

export default function CarPresetPicker({ selectedMake, selectedModel, onSelect }: Props) {
  return (
    <View>
      <Text style={styles.label}>Quick pick</Text>
      <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.row}>
        {CAR_PRESETS.map((p, i) => {
          const isSel = p.make === selectedMake && p.model === selectedModel;
          return (
            <TouchableOpacity
              key={`${p.make}-${p.model}-${i}`}
              testID={`car-preset-${i}`}
              activeOpacity={0.85}
              onPress={() => onSelect(p)}
              style={[styles.chip, isSel && styles.chipSel]}
            >
              {!!p.emoji && <Text style={styles.emoji}>{p.emoji}</Text>}
              <View>
                <Text style={[styles.make, isSel && { color: "#fff" }]}>{p.make}</Text>
                <Text style={[styles.model, isSel && { color: "#fff" }]}>{p.model}</Text>
              </View>
            </TouchableOpacity>
          );
        })}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  label: { color: COLORS.textDim, fontSize: 11, fontWeight: "600", letterSpacing: 0.4, marginBottom: 6, marginLeft: 2 },
  row: { gap: 8, paddingRight: 12 },
  chip: {
    flexDirection: "row", alignItems: "center", gap: 8,
    paddingHorizontal: 10, paddingVertical: 8, borderRadius: 12,
    borderWidth: 1, borderColor: COLORS.hairline,
    backgroundColor: "rgba(255,255,255,0.04)",
  },
  chipSel: { backgroundColor: COLORS.primary, borderColor: COLORS.primary },
  emoji: { fontSize: 20 },
  make: { color: COLORS.textDim, fontSize: 10, fontWeight: "600", letterSpacing: 0.3, textTransform: "uppercase" },
  model: { color: COLORS.text, fontSize: 13, fontWeight: "600" },
});
