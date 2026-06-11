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
import { getRecentRoutes, removeRecentRoute, RecentRoute } from "./recentRoutes";
import MemberCarousel, { CarouselMember } from "./components/MemberCarousel";
import { useSavedPlaces, predictDestination, type Prediction } from "./savedPlaces";
import { Swipeable, GestureHandlerRootView } from "react-native-gesture-handler";

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
  const [saved, , removeSavedPlace] = useSavedPlaces();
  // Time-of-day prediction over the Home/Work anchors — shown as a one-tap
  // "PREDICTIVE" row at the top of the idle list (replaces the old always-on
  // map banner). null when there's no confident guess (no anchors saved, etc.).
  const [prediction, setPrediction] = useState<Prediction>(null);

  useEffect(() => {
    if (!visible) return;
    setText("");
    setSuggestions([]);
    setLoading(false);
    getRecentRoutes().then(setRecents).catch(() => {});
    setPrediction(predictDestination(new Date(), origin?.lat, origin?.lng));
    const t = setTimeout(() => inputRef.current?.focus(), 250);
    return () => clearTimeout(t);
  }, [visible, origin?.lat, origin?.lng, saved]);

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

  const pickSaved = (p: { lat: number; lng: number; label: string }) => {
    onSelectPlace({ lat: p.lat, lng: p.lng, label: p.label });
    onClose();
  };

  const handleDeleteRecent = (r: RecentRoute) => {
    setRecents((prev) => prev.filter((x) => !(x.lat === r.lat && x.lng === r.lng)));
    void removeRecentRoute(r.lat, r.lng);
  };

  // Red "Delete" action revealed when a row is swiped left.
  const renderDelete = (onPress: () => void) => () => (
    <TouchableOpacity style={styles.swipeDelete} onPress={onPress} activeOpacity={0.85}>
      <Ionicons name="trash" size={20} color="#fff" />
      <Text style={styles.swipeDeleteText}>Delete</Text>
    </TouchableOpacity>
  );

  const typing = text.trim().length > 0;

  return (
    <Modal visible={visible} animationType="slide" onRequestClose={onClose}>
      <GestureHandlerRootView style={styles.root}>
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
              {prediction && (
                <View style={styles.section}>
                  <Text style={styles.sectionLabel}>PREDICTIVE</Text>
                  <TouchableOpacity
                    style={styles.resultRow}
                    onPress={() => pickSaved(prediction.place)}
                    activeOpacity={0.7}
                  >
                    <View style={styles.pinWrap}>
                      <Ionicons name="navigate-circle" size={18} color="#FFD60A" />
                    </View>
                    <Text style={[styles.resultText, styles.predictiveText]} numberOfLines={1}>
                      {prediction.place.label}
                    </Text>
                  </TouchableOpacity>
                </View>
              )}

              {recents.length > 0 && (
                <View style={styles.section}>
                  <Text style={styles.sectionLabel}>RECENT</Text>
                  {recents.map((r) => (
                    <Swipeable
                      key={`${r.lat},${r.lng}`}
                      renderRightActions={renderDelete(() => handleDeleteRecent(r))}
                      overshootRight={false}
                    >
                      <TouchableOpacity
                        style={[styles.resultRow, styles.swipeRow]}
                        onPress={() => pickRecent(r)}
                        activeOpacity={0.7}
                      >
                        <View style={styles.pinWrap}>
                          <Ionicons name="time-outline" size={18} color={COLORS.textDim} />
                        </View>
                        <Text style={styles.resultText} numberOfLines={1}>{r.label}</Text>
                      </TouchableOpacity>
                    </Swipeable>
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

              {saved.length > 0 && (
                <View style={styles.section}>
                  <Text style={styles.sectionLabel}>SAVED</Text>
                  {saved.map((p) => (
                    <Swipeable
                      key={p.id}
                      renderRightActions={renderDelete(() => { void removeSavedPlace(p.id); })}
                      overshootRight={false}
                    >
                      <TouchableOpacity
                        style={[styles.resultRow, styles.swipeRow]}
                        onPress={() => pickSaved(p)}
                        activeOpacity={0.7}
                      >
                        <View style={styles.pinWrap}>
                          <Ionicons
                            name={p.kind === "home" ? "home" : p.kind === "work" ? "briefcase" : "bookmark"}
                            size={18}
                            color={COLORS.brand}
                          />
                        </View>
                        <Text style={styles.resultText} numberOfLines={1}>{p.label}</Text>
                      </TouchableOpacity>
                    </Swipeable>
                  ))}
                </View>
              )}
            </>
          )}
        </ScrollView>
      </GestureHandlerRootView>
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
  predictiveText: { color: "#FFD60A", fontWeight: "600" },
  swipeRow: { backgroundColor: "#0B0B0D" },
  swipeDelete: {
    backgroundColor: "#FF453A",
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 6,
    width: 96,
  },
  swipeDeleteText: { color: "#fff", fontSize: 13, fontWeight: "700" },
});
