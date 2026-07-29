// Drives — recorded trip history and lifetime totals.
//
// The user-facing half of src/trips.ts. Everything shown here is read from ON-DEVICE
// storage: the route geometry never leaves the phone (see the long note in trips.ts for
// why). Only distance/duration/when are mirrored to the server, and only so the club
// leaderboard can compare members.
//
// Tapping a drive is where playback will hook in — the polyline is already stored, so
// that feature is a renderer, not a data change.
import React, { useCallback, useState } from "react";
import { View, Text, StyleSheet, ScrollView, TouchableOpacity, RefreshControl } from "react-native";
import { useFocusEffect, useRouter } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import { SafeAreaView } from "react-native-safe-area-context";
import { COLORS } from "../../src/theme";
import { getTrips, tripTotals, removeTrip, setTakeAgain, fmtKm, fmtDur, type Trip } from "../../src/trips";
import TripPlayback from "../../src/components/TripPlayback";

function whenLabel(ms: number): string {
  const d = new Date(ms);
  const now = new Date();
  const sameDay = d.toDateString() === now.toDateString();
  const yest = new Date(now.getTime() - 86400000).toDateString() === d.toDateString();
  const time = d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  if (sameDay) return `Today · ${time}`;
  if (yest) return `Yesterday · ${time}`;
  return `${d.toLocaleDateString([], { month: "short", day: "numeric" })} · ${time}`;
}

export default function TripsPage() {
  const router = useRouter();
  const [trips, setTrips] = useState<Trip[]>([]);
  const [totals, setTotals] = useState({ km: 0, drives: 0, hours: 0 });
  const [busy, setBusy] = useState(false);
  const [playing, setPlaying] = useState<Trip | null>(null);

  const load = useCallback(async () => {
    setBusy(true);
    try {
      setTrips(await getTrips());
      setTotals(await tripTotals());
    } finally {
      setBusy(false);
    }
  }, []);

  // Reload on focus so a drive recorded since the last visit shows without a manual pull.
  useFocusEffect(useCallback(() => { void load(); }, [load]));

  return (
    <SafeAreaView style={styles.page} edges={["top"]}>
      <View style={styles.header}>
        <TouchableOpacity onPress={() => router.back()} hitSlop={10}>
          <Ionicons name="chevron-back" size={26} color={COLORS.text} />
        </TouchableOpacity>
        <Text style={styles.title}>Drives</Text>
        <View style={{ width: 26 }} />
      </View>

      <ScrollView
        contentContainerStyle={{ paddingBottom: 40 }}
        refreshControl={<RefreshControl refreshing={busy} onRefresh={load} tintColor="#2DEC86" />}
      >
        {/* Lifetime totals */}
        <View style={styles.totalsRow}>
          <View style={styles.totalCell}>
            <Text style={styles.totalNum}>{fmtKm(totals.km)}</Text>
            <Text style={styles.totalLabel}>recorded</Text>
          </View>
          <View style={styles.totalDivider} />
          <View style={styles.totalCell}>
            <Text style={styles.totalNum}>{totals.drives}</Text>
            <Text style={styles.totalLabel}>{totals.drives === 1 ? "drive" : "drives"}</Text>
          </View>
          <View style={styles.totalDivider} />
          <View style={styles.totalCell}>
            <Text style={styles.totalNum}>{totals.hours < 1 ? `${Math.round(totals.hours * 60)}m` : `${Math.round(totals.hours)}h`}</Text>
            <Text style={styles.totalLabel}>driving</Text>
          </View>
        </View>

        {trips.length === 0 ? (
          <View style={styles.empty}>
            <Ionicons name="navigate-outline" size={34} color={COLORS.textDim} />
            <Text style={styles.emptyTitle}>No drives yet</Text>
            <Text style={styles.emptyText}>
              Finish a route and it lands here — distance, time, and the way you actually went.
            </Text>
          </View>
        ) : (
          trips.map((t) => (
            <View key={t.id} style={styles.row}>
              <View style={styles.rowIcon}>
                <Ionicons name="navigate" size={18} color="#2DEC86" />
              </View>
              {/* Tap the drive to watch it play back — the geometry is already local. */}
              <TouchableOpacity style={{ flex: 1, minWidth: 0 }} activeOpacity={0.7} onPress={() => setPlaying(t)}>
                <Text style={styles.rowTitle} numberOfLines={1}>{t.destLabel}</Text>
                <Text style={styles.rowSub} numberOfLines={1}>
                  {whenLabel(t.endedAt)} · {fmtKm(t.distanceM / 1000)} · {fmtDur(t.durationS)}
                  {t.stops?.length ? ` · ${t.stops.length} stop${t.stops.length === 1 ? "" : "s"}` : ""}
                </Text>
              </TouchableOpacity>
              <TouchableOpacity
                onPress={async () => setTrips(await removeTrip(t.id))}
                hitSlop={10}
                testID={`trip-remove-${t.id}`}
              >
                <Ionicons name="close-circle" size={20} color="#8E8E93" />
              </TouchableOpacity>
            </View>
          ))
        )}

        {trips.length > 0 && (
          <Text style={styles.footnote}>
            Routes are stored on this phone only. Your club leaderboard sees distance and time — never where you drove.
          </Text>
        )}
      </ScrollView>

      <TripPlayback
        trip={playing}
        visible={!!playing}
        onClose={() => setPlaying(null)}
        onTakeAgain={(t) => {
          setPlaying(null);
          setTakeAgain(t);          // the map consumes this on focus
          router.push("/(app)/map" as any);
        }}
      />
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  page: { flex: 1, backgroundColor: COLORS.bg },
  header: {
    flexDirection: "row", alignItems: "center", justifyContent: "space-between",
    paddingHorizontal: 16, paddingVertical: 12,
  },
  title: { color: COLORS.text, fontSize: 20, fontWeight: "800", letterSpacing: -0.4 },
  totalsRow: {
    flexDirection: "row", alignItems: "center",
    marginHorizontal: 16, marginBottom: 18, paddingVertical: 16,
    borderRadius: 18, backgroundColor: "rgba(255,255,255,0.06)",
  },
  totalCell: { flex: 1, alignItems: "center" },
  totalDivider: { width: StyleSheet.hairlineWidth, height: 30, backgroundColor: "rgba(255,255,255,0.14)" },
  totalNum: { color: "#2DEC86", fontSize: 19, fontWeight: "800", letterSpacing: -0.4 },
  totalLabel: { color: COLORS.text, fontSize: 11.5, fontWeight: "600", marginTop: 3, opacity: 0.8 },
  row: {
    flexDirection: "row", alignItems: "center", gap: 12,
    marginHorizontal: 16, marginBottom: 8, padding: 12,
    borderRadius: 14, backgroundColor: "rgba(255,255,255,0.05)",
  },
  rowIcon: {
    width: 34, height: 34, borderRadius: 17, alignItems: "center", justifyContent: "center",
    backgroundColor: "rgba(45,236,134,0.14)",
  },
  rowTitle: { color: COLORS.text, fontSize: 15, fontWeight: "700", letterSpacing: -0.2 },
  rowSub: { color: COLORS.text, opacity: 0.75, fontSize: 12, fontWeight: "600", marginTop: 2 },
  empty: { alignItems: "center", paddingHorizontal: 40, paddingTop: 40, gap: 10 },
  emptyTitle: { color: COLORS.text, fontSize: 16, fontWeight: "700" },
  emptyText: { color: COLORS.text, opacity: 0.7, fontSize: 13, textAlign: "center", lineHeight: 19 },
  footnote: {
    color: COLORS.textDim, fontSize: 11.5, lineHeight: 17,
    marginHorizontal: 16, marginTop: 14, textAlign: "center",
  },
});
