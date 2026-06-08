// CategoryPills.tsx — Google-Maps-style category quick-search pills that sit
// directly under the map search bar. Tapping a pill runs a Places (New) Text
// Search for that category near the driver and reports the results up to the
// map, which drops them as tappable pins (tap a pin → route there). The first
// six pills (Gas → Parking) are always visible and scroll horizontally; a
// trailing "More" pill opens a sheet with the rest of the categories.
//
// Styling mirrors Google's dark translucent pills so the row reads as one
// family with the existing search bar. The active pill fills convoy-yellow so
// it's obvious which category is currently showing; tapping it again clears
// the pins (toggle off).
import React, { useRef, useState } from "react";
import { View, Text, StyleSheet, TouchableOpacity, ScrollView, Modal, ActivityIndicator, Pressable } from "react-native";
import { MaterialCommunityIcons } from "@expo/vector-icons";
import { GOOGLE_MAPS_KEY } from "../api";
import { getSettings } from "../settings";
import { passesGasFilters, type Octane } from "../gasJockey";

export type PlaceResult = { id: string; lat: number; lng: number; label: string; price?: string; isGas?: boolean; cheapest?: boolean };

type Category = { key: string; label: string; icon: any; query: string };

// Primary row — exact order requested. Always visible, horizontally scrollable.
const PRIMARY: Category[] = [
  { key: "gas",     label: "Gas",        icon: "gas-station",           query: "gas station" },
  { key: "food",    label: "Food",       icon: "silverware-fork-knife", query: "restaurants" },
  { key: "coffee",  label: "Coffee",     icon: "coffee",                query: "coffee" },
  { key: "carwash", label: "Car Wash",   icon: "car-wash",              query: "car wash" },
  { key: "repair",  label: "Car Repair", icon: "car-wrench",            query: "car repair" },
  { key: "parking", label: "Parking",    icon: "parking",               query: "parking" },
];

// Overflow — opened by the "More" pill. Car-centric extras + the usual
// road-trip stops. Add/remove freely; nothing else needs to change.
const MORE: Category[] = [
  { key: "ev",       label: "EV Charging", icon: "ev-station",   query: "ev charging station" },
  { key: "parts",    label: "Auto Parts",  icon: "car-cog",      query: "auto parts store" },
  { key: "grocery",  label: "Groceries",   icon: "cart",         query: "grocery store" },
  { key: "pharmacy", label: "Pharmacy",    icon: "medical-bag",  query: "pharmacy" },
  { key: "atm",      label: "ATM",         icon: "cash",         query: "atm" },
  { key: "hotel",    label: "Hotels",      icon: "bed",          query: "hotels" },
  { key: "fastfood", label: "Fast Food",   icon: "hamburger",    query: "fast food" },
  { key: "hospital", label: "Hospital",    icon: "hospital-box", query: "hospital" },
];

// Great-circle distance in metres (haversine) — used to collapse co-located
// results and to find the cheapest premium within 10 km.
function distM(aLat: number, aLng: number, bLat: number, bLng: number): number {
  const R = 6371000;
  const dLat = ((bLat - aLat) * Math.PI) / 180;
  const dLng = ((bLng - aLng) * Math.PI) / 180;
  const la = (aLat * Math.PI) / 180, lb = (bLat * Math.PI) / 180;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(la) * Math.cos(lb) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

// Numeric Premium pump price from a fuelOptions entry ({units, nanos} ->
// units + nanos/1e9, the per-litre/gallon price in the local currency).
function premVal(price?: { units?: string; nanos?: number }): number | undefined {
  if (!price) return undefined;
  const v = Number(price.units || 0) + Number(price.nanos || 0) / 1e9;
  return v || undefined;
}

// Places API (New) Text Search — same project/key + base host as the
// autocomplete used by DestinationSearch. A text query ("car wash") is far more
// forgiving than Nearby Search's strict includedTypes (no risk of an unknown
// type returning nothing), and locationBias keeps results near the driver.
// When includeFuel is set (Gas only) we also pull fuelOptions, surface the
// Premium pump price on each result, collapse co-located duplicates, and flag
// the cheapest premium within 10 km.
async function textSearchNearby(query: string, origin: { lat: number; lng: number }, includeFuel = false): Promise<PlaceResult[]> {
  try {
    // fuelOptions is a higher-cost field (Enterprise SKU), so we only request it
    // for the Gas category — every other pill uses the cheap basic field mask.
    const fieldMask = "places.id,places.location,places.displayName,places.formattedAddress"
      + (includeFuel ? ",places.fuelOptions" : "");
    const res = await fetch("https://places.googleapis.com/v1/places:searchText", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Goog-Api-Key": GOOGLE_MAPS_KEY,
        "X-Goog-FieldMask": fieldMask,
      },
      body: JSON.stringify({
        textQuery: query,
        // Slightly wider bias for Gas so we capture stations out to ~10 km for
        // the cheapest-premium comparison.
        locationBias: { circle: { center: { latitude: origin.lat, longitude: origin.lng }, radius: includeFuel ? 12000.0 : 8000.0 } },
        maxResultCount: 20,
      }),
    });
    const data = await res.json();

    // Gas Jockey filter (Gas only) — drop stations whose brand the driver has
    // hidden, or that don't carry the selected octane. With everything left ON
    // (the default) nothing is filtered.
    let places: any[] = (data.places || []).filter((p: any) => p.location);
    if (includeFuel) {
      const s = getSettings();
      const brands = (s as any).gasBrands as Record<string, boolean> | undefined;
      const showOther = (s as any).gasOther !== false;
      const octane = ((s as any).gasOctane ?? null) as Octane | null;
      places = places.filter((p: any) =>
        passesGasFilters(p.displayName?.text, p.fuelOptions, brands, showOther, octane)
      );
    }

    // Build results with a numeric premium price + distance from the driver.
    const raw = places
      .map((p: any) => {
        const prem = includeFuel
          ? (p.fuelOptions?.fuelPrices || []).find((f: any) => f.type === "PREMIUM")
          : undefined;
        const v = premVal(prem?.price);
        const lat = p.location.latitude, lng = p.location.longitude;
        return {
          v,
          dist: distM(origin.lat, origin.lng, lat, lng),
          place: {
            id: p.id, lat, lng,
            label: p.displayName?.text || p.formattedAddress || query,
            price: v != null ? "$" + v.toFixed(2) : undefined,
            isGas: includeFuel,
          } as PlaceResult,
        };
      });

    // Collapse co-located entries (e.g. a gas station + its on-site convenience
    // store both match "gas station") so each spot shows ONE pin. Priced entries
    // sort first, so when two sit on top of each other we keep the one with a price.
    raw.sort((a: any, b: any) => (b.v != null ? 1 : 0) - (a.v != null ? 1 : 0));
    const kept: any[] = [];
    for (const x of raw) {
      if (kept.some((k) => distM(k.place.lat, k.place.lng, x.place.lat, x.place.lng) < 25)) continue;
      kept.push(x);
    }

    // Cheapest premium within 10 km → flag it (map paints that chip green).
    if (includeFuel) {
      const elig = kept.filter((x) => x.v != null && x.dist <= 10000);
      if (elig.length) {
        const min = Math.min(...elig.map((x) => x.v as number));
        kept.forEach((x) => { if (x.v != null && x.v === min && x.dist <= 10000) x.place.cheapest = true; });
      }
    }

    return kept.map((x) => x.place);
  } catch {
    return [];
  }
}

type Props = {
  origin?: { lat: number; lng: number } | null;
  onResults: (places: PlaceResult[]) => void;
};

export default function CategoryPills({ origin, onResults }: Props) {
  const [activeKey, setActiveKey] = useState<string | null>(null);
  const [loadingKey, setLoadingKey] = useState<string | null>(null);
  const [moreOpen, setMoreOpen] = useState(false);
  // Monotonic request id. Switching/clearing bumps it so a slower in-flight
  // search can't repopulate pins for a category the user has since left.
  const reqSeq = useRef(0);

  const run = async (cat: Category) => {
    // Tapping the already-active pill clears the results (toggle off).
    if (activeKey === cat.key) {
      reqSeq.current++;            // cancel any in-flight search
      setActiveKey(null);
      onResults([]);
      return;
    }
    if (!origin) return;
    const myReq = ++reqSeq.current;
    // Clear the previous category's pins IMMEDIATELY, before the network call.
    // Besides the instant Google-Maps-style feedback, this forces the map to
    // drop ALL old markers in a render BEFORE the new ones mount. Without that
    // empty in-between frame, react-native-maps on Android occasionally leaves
    // a stray "ghost" pin from the previous category sitting under a new one
    // (e.g. the green cheapest-gas chip lingering on the Food / Car Wash view).
    setActiveKey(cat.key);
    onResults([]);
    setLoadingKey(cat.key);
    const results = await textSearchNearby(cat.query, origin, cat.key === "gas");
    if (myReq !== reqSeq.current) return;  // a newer tap superseded this search
    setLoadingKey(null);
    onResults(results);
  };

  const renderPill = (cat: Category) => {
    const active = activeKey === cat.key;
    const loading = loadingKey === cat.key;
    return (
      <TouchableOpacity
        key={cat.key}
        testID={`cat-pill-${cat.key}`}
        activeOpacity={0.8}
        onPress={() => run(cat)}
        style={[styles.pill, active && styles.pillActive]}
      >
        {loading ? (
          <ActivityIndicator size="small" color={active ? "#1C1C1E" : "#FFD60A"} />
        ) : (
          <MaterialCommunityIcons name={cat.icon} size={15} color={active ? "#1C1C1E" : "#FFD60A"} />
        )}
        <Text style={[styles.pillText, active && styles.pillTextActive]}>{cat.label}</Text>
      </TouchableOpacity>
    );
  };

  return (
    <View style={styles.wrap} pointerEvents="box-none">
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={styles.row}
        keyboardShouldPersistTaps="handled"
      >
        {PRIMARY.map(renderPill)}
        {/* More pill — always last, opens the overflow sheet. */}
        <TouchableOpacity testID="cat-pill-more" activeOpacity={0.8} onPress={() => setMoreOpen(true)} style={styles.pill}>
          <MaterialCommunityIcons name="dots-horizontal" size={16} color="#FFD60A" />
          <Text style={styles.pillText}>More</Text>
        </TouchableOpacity>
      </ScrollView>

      <Modal visible={moreOpen} transparent animationType="slide" onRequestClose={() => setMoreOpen(false)}>
        <Pressable style={styles.backdrop} onPress={() => setMoreOpen(false)}>
          <Pressable style={styles.sheet} onPress={() => {}}>
            <View style={styles.grip} />
            <Text style={styles.sheetTitle}>More places</Text>
            <View style={styles.grid}>
              {MORE.map((cat) => (
                <TouchableOpacity
                  key={cat.key}
                  testID={`cat-more-${cat.key}`}
                  activeOpacity={0.8}
                  style={styles.gridItem}
                  onPress={() => { setMoreOpen(false); run(cat); }}
                >
                  <View style={styles.gridIcon}>
                    <MaterialCommunityIcons name={cat.icon} size={22} color="#FFD60A" />
                  </View>
                  <Text style={styles.gridLabel} numberOfLines={1}>{cat.label}</Text>
                </TouchableOpacity>
              ))}
            </View>
            <TouchableOpacity onPress={() => setMoreOpen(false)} style={styles.doneBtn}>
              <Text style={styles.doneText}>Done</Text>
            </TouchableOpacity>
          </Pressable>
        </Pressable>
      </Modal>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { marginTop: 8 },
  row: { gap: 8, paddingRight: 16, paddingLeft: 2, alignItems: "center" },
  pill: {
    flexDirection: "row", alignItems: "center", gap: 6,
    paddingHorizontal: 12, paddingVertical: 8,
    borderRadius: 999,
    backgroundColor: "rgba(28,28,30,0.92)",
    borderWidth: StyleSheet.hairlineWidth, borderColor: "rgba(255,255,255,0.18)",
    shadowColor: "#000", shadowOpacity: 0.25, shadowRadius: 4, shadowOffset: { width: 0, height: 2 }, elevation: 3,
  },
  pillActive: { backgroundColor: "#FFD60A", borderColor: "rgba(0,0,0,0.15)" },
  pillText: { color: "#F4F4F4", fontSize: 13, fontWeight: "600", letterSpacing: 0.1 },
  pillTextActive: { color: "#1C1C1E" },
  // ===== "More" bottom sheet =====
  backdrop: { flex: 1, backgroundColor: "rgba(0,0,0,0.55)", justifyContent: "flex-end" },
  sheet: {
    backgroundColor: "#15171A",
    paddingHorizontal: 20, paddingTop: 12, paddingBottom: 28,
    borderTopLeftRadius: 22, borderTopRightRadius: 22,
    borderTopWidth: StyleSheet.hairlineWidth, borderColor: "rgba(255,255,255,0.12)",
  },
  grip: { width: 38, height: 4, borderRadius: 2, backgroundColor: "rgba(255,255,255,0.25)", alignSelf: "center", marginBottom: 14 },
  sheetTitle: { color: "#F4F4F4", fontSize: 18, fontWeight: "700", marginBottom: 14, letterSpacing: -0.2 },
  grid: { flexDirection: "row", flexWrap: "wrap" },
  gridItem: { width: "25%", alignItems: "center", marginBottom: 18 },
  gridIcon: {
    width: 52, height: 52, borderRadius: 26,
    alignItems: "center", justifyContent: "center",
    backgroundColor: "rgba(255,214,10,0.14)",
    borderWidth: StyleSheet.hairlineWidth, borderColor: "rgba(255,214,10,0.35)",
    marginBottom: 6,
  },
  gridLabel: { color: "#808080", fontSize: 11, fontWeight: "600", textAlign: "center" },
  doneBtn: { marginTop: 6, alignSelf: "center", paddingHorizontal: 22, paddingVertical: 10, borderRadius: 999, backgroundColor: "rgba(255,255,255,0.10)" },
  doneText: { color: "#F4F4F4", fontWeight: "600", fontSize: 14 },
});
