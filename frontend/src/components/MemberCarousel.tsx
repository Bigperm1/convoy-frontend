// MemberCarousel.tsx — a horizontal strip of community members shown by their
// car avatar + handle. ONE component, two modes, reused everywhere members are
// picked:
//   • mode="route"  → single tap routes to a LIVE friend; offline members are
//                     greyed + disabled (we can't route to someone with no
//                     live location).
//   • mode="share"  → multi-select to push music/route/comms; offline members
//                     are dimmed but STILL selectable (the push reaches them
//                     whenever they next open the app).
// Presentation-only: the caller merges the community roster with live presence
// and owns selection state, so this stays reusable across the nav search and
// all three share flows.
import React, { useMemo } from "react";
import { View, Text, StyleSheet, TouchableOpacity, ScrollView } from "react-native";
import { Image } from "expo-image";
import { Ionicons } from "@expo/vector-icons";
import { COLORS } from "../theme";
import { getVehiclePngOrDefault } from "../vehicleAssets";

export type CarouselMember = {
  id: string;
  handle: string;
  car_color?: string;
  is_admin?: boolean;
  isLive?: boolean;       // online right now (from presence)
  lat?: number;           // live location — present only when isLive (for routing)
  lng?: number;
};

type Props = {
  members: CarouselMember[];
  mode: "route" | "share";
  selected?: Set<string>;            // controlled selection (share mode)
  onSelect: (m: CarouselMember) => void;
  emptyText?: string;
};

export default function MemberCarousel({ members, mode, selected, onSelect, emptyText }: Props) {
  // Live first, then offline; alphabetical within each group for stability.
  const sorted = useMemo(() => {
    const byHandle = (a: CarouselMember, b: CarouselMember) => (a.handle || "").localeCompare(b.handle || "");
    const live = members.filter((m) => m.isLive).sort(byHandle);
    const off = members.filter((m) => !m.isLive).sort(byHandle);
    return [...live, ...off];
  }, [members]);

  if (sorted.length === 0) {
    return <Text style={styles.empty}>{emptyText || "No members yet."}</Text>;
  }

  return (
    <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.row}>
      {sorted.map((m) => {
        const sel = !!selected?.has(m.id);
        // Offline members are only tappable in share mode.
        const enabled = mode === "share" || !!m.isLive;
        return (
          <TouchableOpacity
            key={m.id}
            style={[styles.chip, !enabled && styles.chipDisabled]}
            activeOpacity={enabled ? 0.7 : 1}
            onPress={() => { if (enabled) onSelect(m); }}
          >
            <View style={[styles.avatarWrap, sel && styles.avatarWrapSel]}>
              <Image source={getVehiclePngOrDefault(m.car_color)} style={styles.avatar} contentFit="contain" />
              {m.isLive && <View style={styles.liveDot} />}
              {sel && (
                <View style={styles.check}>
                  <Ionicons name="checkmark" size={13} color="#1a1a1a" />
                </View>
              )}
            </View>
            <Text style={[styles.handle, !enabled && styles.handleDim]} numberOfLines={1}>
              {m.handle || "Driver"}
            </Text>
          </TouchableOpacity>
        );
      })}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  row: { gap: 14, paddingHorizontal: 14, paddingVertical: 8 },
  chip: { width: 64, alignItems: "center", gap: 6 },
  chipDisabled: { opacity: 0.38 },
  avatarWrap: {
    width: 56, height: 56, borderRadius: 28,
    backgroundColor: "rgba(255,255,255,0.08)",
    alignItems: "center", justifyContent: "center",
    borderWidth: 2, borderColor: "rgba(255,255,255,0.14)",
  },
  avatarWrapSel: { borderColor: COLORS.brand },
  avatar: { width: 44, height: 44 },
  liveDot: {
    position: "absolute", bottom: 1, right: 3,
    width: 13, height: 13, borderRadius: 7,
    backgroundColor: COLORS.success, borderWidth: 2, borderColor: "#15171A",
  },
  check: {
    position: "absolute", top: -2, right: -2,
    width: 20, height: 20, borderRadius: 10,
    backgroundColor: COLORS.brand, alignItems: "center", justifyContent: "center",
    borderWidth: 2, borderColor: "#15171A",
  },
  handle: { color: COLORS.text, fontSize: 11, fontWeight: "600", maxWidth: 64, textAlign: "center" },
  handleDim: { color: COLORS.textDim },
  empty: { color: COLORS.textDim, fontSize: 13, paddingHorizontal: 16, paddingVertical: 14 },
});
