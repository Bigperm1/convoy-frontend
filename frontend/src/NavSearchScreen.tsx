// NavSearchScreen.tsx — full-screen, Google-Maps-style destination search.
// Opens when the driver taps the map's search bar. Layout:
//   ┌──────────────────────────────────────┐
//   │  ←   [ Where to?            ✕ ]       │  search header
//   ├──────────────────────────────────────┤
//   │  (typing)  yellow-pin result rows     │
//   │  (idle)    RECENT  …                  │
//   │            DRIVE TO A FRIEND  [strip] │
//   └──────────────────────────────────────┘
// Presentation-only: the caller (map.tsx) owns the destination + routing, so
// this just reports a chosen place or a chosen live friend back up.
import React, { useEffect, useRef, useState } from "react";
import {
  View,
  Text,
  StyleSheet,
  TextInput,
  TouchableOpacity,
  Modal,
  ScrollView,
  Platform,
  ActivityIndicator,
} from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { COLORS } from "./theme";
import { autocompletePlaces, placeDetails, Suggestion } from "./places";
import { getRecentRoutes, RecentRoute } from "./recentRoutes";
import MemberCarousel, { CarouselMember } from "./components/MemberCarousel";

type Props = {
  visible: boolean;
  onClose: () => void;
  origin?: { lat: number; lng: number } | null;
  members: CarouselMember[];
  onSelectPlace: (loc: { lat: number; lng: number; label: string }) => void;
  onSelectFriend: (m: CarouselMember) => void;
};

export default function NavSearchScreen({
  visible,
  onClose,
  origin,
  members,
  onSelectPlace,
  onSelectFriend,
}: Props) {
  const [text, setText] = useState("");
  const [suggestions, setSuggestions] = useState<Suggestion[]>([]);
  const [recents, setRecents] = useState<RecentRoute[]>([]);
  const [loading, setLoading] = useState(false);
  const inputRef = useRef<TextInput>(null);
  const tRef = useRef<any>(null);

  useEffect(() => {
    if (!visible) return;
    setText("");
    setSuggestions([]);
    setLoading(false);
    getRecentRoutes().then(setRecents).catch(() => {});
    const t = setTimeout(() => inputRef.current?.focus(), 250);
    return () => clearTimeout(t);
  }, [visible]);

  const onChange = (q: string) => {
    setText(q);
    if (tRef.current) clearTimeout(tRef.current);
    if (!q.trim()) {
      setSuggestions([]);
      setLoading(false);
      return;
    }
    setLoading(true);
    tRef.current = setTimeout(async () => {
      const list = await autocompletePlaces(q, origin ?? undefined);
      setSuggestions(list);
      setLoading(false);
    }, 220);
  };

  const pickSuggestion = async (s: Suggestion) => {
    const detail = await placeDetails(s.place_id);
    if (!detail) return;
    onSelectPlace(detail);
    onClose();
  };

  const pickRecent = (r: RecentRoute) => {
    onSelectPlace({ lat: r.lat, lng: r.lng, label: r.label });
    onClose();
  };

  const typing = text.trim().length > 0;

  return (
    <Modal visible={visible} animationType="slide" onRequestClose={onClose}>
      <View style={styles.root}>
        {/* Search header */}
        <View style={styles.header}>
          <TouchableOpacity onPress={onClose} hitSlop={10} style={styles.backBtn}>
            <Ionicons name="arrow-back" size={24} color={COLORS.text} />
          </TouchableOpacity>
          <View style={styles.searchPill}>
            <Ionicons name="search" size={18} color="rgba(235,235,245,0.55)" />
            <TextInput
              ref={inputRef}
              value={text}
              onChangeText={onChange}
              placeholder="Where to?"
              placeholderTextColor="#808080"
              style={styles.input}
              returnKeyType="search"
              autoCorrect={false}
            />
            {!!text && (
              <TouchableOpacity onPress={() => onChange("")} hitSlop={8}>
                <Ionicons name="close-circle" size={20} color="rgba(235,235,245,0.6)" />
              </TouchableOpacity>
            )}
          </View>
        </View>

        <ScrollView keyboardShouldPersistTaps="handled" style={{ flex: 1 }} keyboardDismissMode="on-drag">
          {typing ? (
            <View style={styles.section}>
              {loading && suggestions.length === 0 ? (
                <ActivityIndicator color={COLORS.brand} style={{ marginTop: 24 }} />
              ) : (
                suggestions.map((s) => (
                  <TouchableOpacity
                    key={s.place_id}
                    style={styles.resultRow}
                    onPress={() => pickSuggestion(s)}
                    activeOpacity={0.7}
                  >
                    <View style={styles.pinWrap}>
                      <Ionicons name="location" size={18} color={COLORS.brand} />
                    </View>
                    <Text style={styles.resultText} numberOfLines={2}>{s.description}</Text>
                  </TouchableOpacity>
                ))
              )}
            </View>
          ) : (
            <>
              {recents.length > 0 && (
                <View style={styles.section}>
                  <Text style={styles.sectionLabel}>RECENT</Text>
                  {recents.map((r) => (
                    <TouchableOpacity
                      key={`${r.lat},${r.lng}`}
                      style={styles.resultRow}
                      onPress={() => pickRecent(r)}
                      activeOpacity={0.7}
                    >
                      <View style={styles.pinWrap}>
                        <Ionicons name="time-outline" size={18} color={COLORS.textDim} />
                      </View>
                      <Text style={styles.resultText} numberOfLines={1}>{r.label}</Text>
                    </TouchableOpacity>
                  ))}
                </View>
              )}

              <View style={styles.section}>
                <Text style={styles.sectionLabel}>DRIVE TO A FRIEND</Text>
                <MemberCarousel
                  members={members}
                  mode="route"
                  onSelect={(m) => { onSelectFriend(m); onClose(); }}
                  emptyText="No one in your convoy is live right now."
                />
              </View>
            </>
          )}
        </ScrollView>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: "#0B0B0D", paddingTop: Platform.OS === "ios" ? 52 : 28 },
  header: { flexDirection: "row", alignItems: "center", gap: 8, paddingHorizontal: 10, paddingBottom: 10 },
  backBtn: { width: 40, height: 40, alignItems: "center", justifyContent: "center" },
  searchPill: {
    flex: 1,
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    backgroundColor: "rgba(34,35,38,0.96)",
    borderRadius: 24,
    paddingHorizontal: 14,
    paddingVertical: 10,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: "rgba(255,255,255,0.12)",
  },
  input: { flex: 1, fontSize: 16, color: "#F4F4F4", paddingVertical: 0 },
  section: { paddingTop: 14, paddingBottom: 6 },
  sectionLabel: {
    color: COLORS.textDim,
    fontSize: 11,
    fontWeight: "700",
    letterSpacing: 0.8,
    paddingHorizontal: 18,
    marginBottom: 6,
  },
  resultRow: { flexDirection: "row", alignItems: "center", gap: 14, paddingVertical: 12, paddingHorizontal: 16 },
  pinWrap: {
    width: 38,
    height: 38,
    borderRadius: 19,
    backgroundColor: "rgba(255,255,255,0.06)",
    alignItems: "center",
    justifyContent: "center",
  },
  resultText: { color: COLORS.text, flex: 1, fontSize: 15 },
});
