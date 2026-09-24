// CategoryPills.tsx — Google-Maps-style category quick-search pills that sit
// directly under the map search bar. Tapping a pill runs a Places (New) Text
// Search for that category near the driver and reports the results up to the
// map, which drops them as tappable pins (tap a pin → route there). The first
// six pills (Gas → Parking) are always visible and scroll horizontally; a
// trailing "More" pill opens a sheet with the rest of the categories.
//
// Styling (2026-09-23, Jeff off a Mapbox screenshot — "chips good"): each category is a round
// dark-glass chip with a ring and glyph in ITS colour (src/poiPalette.ts) and the label beneath;
// the active chip fills with that colour. The results list repeats the same badge on every row so
// chip ↔ row ↔ map pin read as one family. Tapping the active chip again clears the pins (toggle off).
import React, { useRef, useState, useEffect } from "react";
import { View, Text, StyleSheet, TouchableOpacity, ScrollView, Modal, ActivityIndicator, Pressable, Animated, Easing } from "react-native";
import { MaterialCommunityIcons } from "@expo/vector-icons";
import { GOOGLE_MAPS_KEY } from "../api";
import { getSettings } from "../settings";
import { passesGasFilters, type Octane } from "../gasJockey";
import { GlassFill, hudTint, drawerTint } from "../Glass";
import { skin } from "../tierTheme";
import { poiColors } from "../poiPalette";
import { useWaveMetal, useWaveY } from "../ui/SkinWave";
import { PressableScale } from "../ui/PressableScale";
import { COLORS } from "../theme";

// `cat` is the chip's category key — it picks the pin's colour family (src/poiPalette.ts) on every surface.
export type PlaceResult = { id: string; lat: number; lng: number; label: string; price?: string; isGas?: boolean; cheapest?: boolean; address?: string; rating?: number; ratingCount?: number; distanceM?: number; cat?: string };

// Format a straight-line distance (m) for the results dropdown, in the driver's unit.
function fmtDist(m: number | undefined, unit: "kmh" | "mph"): string {
  if (m == null) return "";
  if (unit === "mph") { const mi = m / 1609.34; return (mi < 10 ? mi.toFixed(mi < 1 ? 2 : 1) : String(Math.round(mi))) + " mi"; }
  const km = m / 1000; return (km < 10 ? km.toFixed(km < 1 ? 2 : 1) : String(Math.round(km))) + " km";
}
// Rough drive-time estimate from straight-line distance (~32 km/h city average).
function fmtEta(m: number | undefined): string {
  if (m == null) return "";
  return `${Math.max(1, Math.round((m / 1000) / 32 * 60))} min`;
}
// Trim a Google formatted address to just street + city so the dropdown stays
// compact — drops the province/state, postal code, and country tail. Google
// returns e.g. "315 Linden St, San Francisco, CA 94102, USA" → keep the first
// two comma parts ("315 Linden St, San Francisco").
function shortAddr(s?: string): string | undefined {
  if (!s) return undefined;
  const parts = s.split(",").map((x) => x.trim()).filter(Boolean);
  return parts.length <= 2 ? parts.join(", ") : parts.slice(0, 2).join(", ");
}

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
    const fieldMask = "places.id,places.location,places.displayName,places.formattedAddress,places.rating,places.userRatingCount"
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
        const d = distM(origin.lat, origin.lng, lat, lng);
        return {
          v,
          dist: d,
          place: {
            id: p.id, lat, lng,
            label: p.displayName?.text || p.formattedAddress || query,
            address: shortAddr(p.formattedAddress),
            rating: typeof p.rating === "number" ? p.rating : undefined,
            ratingCount: typeof p.userRatingCount === "number" ? p.userRatingCount : undefined,
            price: v != null ? "$" + v.toFixed(2) : undefined,
            isGas: includeFuel,
            distanceM: d,
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
  // Tapping a result row routes there (same as tapping its map pin). Optional —
  // wired from the map; when absent the dropdown is read-only.
  onSelect?: (place: PlaceResult) => void;
};

export default function CategoryPills({ origin, onResults, onSelect }: Props) {
  const [activeKey, setActiveKey] = useState<string | null>(null);
  const [loadingKey, setLoadingKey] = useState<string | null>(null);
  const [moreOpen, setMoreOpen] = useState(false);
  // Results dropdown is only shown on a LONG-press (tap just drops pins).
  const [listOpen, setListOpen] = useState(false);
  // Results for the active category — drives the dropdown list (and the pins,
  // via onResults). Kept in sync with what the map shows.
  const [results, setResults] = useState<PlaceResult[]>([]);
  // Monotonic request id. Switching/clearing bumps it so a slower in-flight
  // search can't repopulate pins for a category the user has since left.
  const reqSeq = useRef(0);

  // Results dropdown drop-in animation.
  const dropAnim = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    if (activeKey) {
      dropAnim.setValue(0);
      Animated.timing(dropAnim, { toValue: 1, duration: 180, easing: Easing.out(Easing.cubic), useNativeDriver: true }).start();
    }
  }, [activeKey, dropAnim]);

  // The pill icons turn as the unlock wave's band crosses this row (src/skinWave.ts); 0.18 until measured.
  const wavePos = useWaveY(0.18);
  const accent = skin(useWaveMetal(wavePos.y.current)).accent;
  const unit = getSettings().speedUnit;
  const activeCat = activeKey ? [...PRIMARY, ...MORE].find((c) => c.key === activeKey) : undefined;

  const closeDropdown = () => {
    reqSeq.current++;
    setActiveKey(null);
    setLoadingKey(null);
    setResults([]);
    onResults([]);
    setListOpen(false);
  };

  const run = async (cat: Category) => {
    // Tapping the already-active pill clears the results (toggle off).
    if (activeKey === cat.key) {
      reqSeq.current++;            // cancel any in-flight search
      setActiveKey(null);
      setResults([]);
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
    setResults([]);
    onResults([]);
    setLoadingKey(cat.key);
    const found = (await textSearchNearby(cat.query, origin, cat.key === "gas")).map((p) => ({ ...p, cat: cat.key }));
    if (myReq !== reqSeq.current) return;  // a newer tap superseded this search
    setLoadingKey(null);
    setResults(found);
    onResults(found);
  };

  const renderPill = (cat: Category) => {
    const active = activeKey === cat.key;
    const loading = loadingKey === cat.key;
    const c = poiColors(cat.key);
    return (
      <PressableScale
        key={cat.key}
        testID={`cat-pill-${cat.key}`}
        // Chips sit 6 pt apart in a scroller: keep today's touch target, since a default slop would
        // take the neighbour's edge (Jeff, 2026-09-23: Apple-feel batch 1). Same for More.
        hitSlop={0}
        onPress={() => { setListOpen(false); run(cat); }}
        onLongPress={() => { setListOpen(true); if (activeKey !== cat.key) run(cat); }}
        delayLongPress={250}
        style={styles.chip}
      >
        <View style={[styles.chipCircle, { borderColor: c.bright }, active && { backgroundColor: c.bright }]}>
          {!active && <GlassFill tintColor={hudTint()} style={{ borderRadius: CHIP_D / 2, overflow: "hidden" }} />}
          {loading ? (
            <ActivityIndicator size="small" color={active ? "#1C1C1E" : c.bright} />
          ) : (
            <MaterialCommunityIcons name={cat.icon} size={24} color={active ? "#1C1C1E" : c.bright} />
          )}
        </View>
        <Text maxFontSizeMultiplier={1} style={[styles.chipLabel, active && styles.chipLabelActive]} numberOfLines={1}>{cat.label}</Text>
      </PressableScale>
    );
  };

  return (
    <View ref={wavePos.ref} onLayout={wavePos.onLayout} style={styles.wrap} pointerEvents="box-none">
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={styles.row}
        keyboardShouldPersistTaps="handled"
      >
        {PRIMARY.map(renderPill)}
        {/* More pill — always last, opens the overflow sheet. */}
        <PressableScale testID="cat-pill-more" hitSlop={0} onPress={() => setMoreOpen(true)} style={styles.chip}>
          <View style={[styles.chipCircle, { borderColor: "rgba(255,255,255,0.28)" }]}>
            <GlassFill tintColor={hudTint()} style={{ borderRadius: CHIP_D / 2, overflow: "hidden" }} />
            <MaterialCommunityIcons name="dots-horizontal" size={24} color="#F4F4F4" />
          </View>
          <Text maxFontSizeMultiplier={1} style={styles.chipLabel}>More</Text>
        </PressableScale>
      </ScrollView>

      {/* Results dropdown — animated panel listing the active category's hits
          (name, address, rating + count or gas premium price, time · distance). */}
      {activeKey && listOpen && (
        <Animated.View
          style={[
            styles.dropdown,
            { opacity: dropAnim, transform: [{ translateY: dropAnim.interpolate({ inputRange: [0, 1], outputRange: [-10, 0] }) }] },
          ]}
        >
          <GlassFill tintColor={drawerTint()} style={StyleSheet.absoluteFill} />
          <View style={styles.dropHeader}>
            <Text maxFontSizeMultiplier={1} style={styles.dropTitle}>{activeCat ? `${activeCat.label} Nearby` : "Nearby"}</Text>
            <TouchableOpacity onPress={closeDropdown} hitSlop={10} testID="results-close">
              <MaterialCommunityIcons name="close" size={20} color="#9A9A9E" />
            </TouchableOpacity>
          </View>
          {loadingKey ? (
            <View style={styles.dropLoading}>
              <ActivityIndicator size="small" color={accent} />
              <Text maxFontSizeMultiplier={1} style={styles.dropLoadingText}>Searching…</Text>
            </View>
          ) : results.length === 0 ? (
            <Text maxFontSizeMultiplier={1} style={styles.dropEmpty}>No results nearby</Text>
          ) : (
            <ScrollView style={{ maxHeight: 320 }} showsVerticalScrollIndicator={false} keyboardShouldPersistTaps="handled">
              {results.map((r, i) => {
                // The row's badge is the chip's twin (same colour, same glyph) and the number matches the
                // map pin. A gas price rides the meta line in the category colour; the cheapest station
                // goes brand green with the word, the way its pin goes bright on the map.
                const c = poiColors(r.cat ?? activeKey ?? undefined);
                return (
                <TouchableOpacity
                  key={r.id}
                  testID={`result-${i}`}
                  activeOpacity={onSelect ? 0.7 : 1}
                  onPress={() => onSelect?.(r)}
                  style={styles.resultRow}
                >
                  <View style={[styles.badge, { borderColor: c.bright }]}>
                    <MaterialCommunityIcons name={activeCat?.icon ?? "map-marker"} size={18} color={c.bright} />
                  </View>
                  <View style={styles.resultLeft}>
                    <View style={styles.resultTitleRow}>
                      <Text maxFontSizeMultiplier={1} style={styles.resultName} numberOfLines={1}>{i + 1}.  {r.label}</Text>
                      <Text maxFontSizeMultiplier={1} style={styles.resultDist} numberOfLines={1}>{fmtDist(r.distanceM, unit)}</Text>
                    </View>
                    {!!r.address && <Text maxFontSizeMultiplier={1} style={styles.resultAddr} numberOfLines={1}>{r.address}</Text>}
                    <View style={styles.metaRow}>
                      {/* Compact on purpose — the dropdown is ~300 pt of text width and a gas row also carries
                          its price here (sim, 2026-09-23: "246 reviews… Premium $2.42" clipped the reviews). */}
                      <Text maxFontSizeMultiplier={1} style={styles.meta} numberOfLines={1}>
                        {typeof r.rating === "number" ? `★ ${r.rating.toFixed(1)}${typeof r.ratingCount === "number" ? ` (${r.ratingCount})` : ""} · ` : ""}{fmtEta(r.distanceM)}
                      </Text>
                      {r.isGas && (
                        <Text maxFontSizeMultiplier={1} style={[styles.gasPrice, { color: r.cheapest ? "#2DEC86" : c.bright }]} numberOfLines={1}>
                          {r.price ? `Premium ${r.price}` : "Premium —"}{r.cheapest ? " · cheapest" : ""}
                        </Text>
                      )}
                    </View>
                  </View>
                  {onSelect && <MaterialCommunityIcons name="chevron-right" size={20} color="#5A5A5E" style={{ alignSelf: "center" }} />}
                </TouchableOpacity>
                );
              })}
            </ScrollView>
          )}
        </Animated.View>
      )}

      <Modal visible={moreOpen} transparent animationType="slide" onRequestClose={() => setMoreOpen(false)}>
        <Pressable style={styles.backdrop} onPress={() => setMoreOpen(false)}>
          <Pressable style={styles.sheet} onPress={() => {}}>
            <View style={styles.grip} />
            <Text maxFontSizeMultiplier={1} style={styles.sheetTitle}>More places</Text>
            <View style={styles.grid}>
              {MORE.map((cat) => (
                <TouchableOpacity
                  key={cat.key}
                  testID={`cat-more-${cat.key}`}
                  activeOpacity={0.8}
                  style={styles.gridItem}
                  onPress={() => { setMoreOpen(false); run(cat); }}
                >
                  <View style={[styles.gridIcon, { borderColor: poiColors(cat.key).bright }]}>
                    <MaterialCommunityIcons name={cat.icon} size={22} color={poiColors(cat.key).bright} />
                  </View>
                  <Text maxFontSizeMultiplier={1} style={styles.gridLabel} numberOfLines={1}>{cat.label}</Text>
                </TouchableOpacity>
              ))}
            </View>
            <TouchableOpacity onPress={() => setMoreOpen(false)} style={styles.doneBtn}>
              <Text maxFontSizeMultiplier={1} style={styles.doneText}>Done</Text>
            </TouchableOpacity>
          </Pressable>
        </Pressable>
      </Modal>
    </View>
  );
}

// The round category chip: Ø 56 pt (the mock Jeff approved 2026-09-23), a 44 pt+ touch target on its own.
const CHIP_D = 56;

const styles = StyleSheet.create({
  wrap: { marginTop: 8 },
  // Chips sit as close as the Crew button and the compass do (Jeff, 2026-09-23: "make the icons closer
  // together… same space as the crew/compass" — map.tsx fabStack gap is 10): the chip box is the circle
  // plus 3 pt a side, 4 pt apart, so circle edges are 10 pt apart. Labels run a little wider than the box
  // and centre on it.
  row: { gap: 4, paddingRight: 16, paddingLeft: 8, alignItems: "flex-start" },
  chip: { width: CHIP_D + 6, alignItems: "center", gap: 5 },
  chipCircle: {
    width: CHIP_D, height: CHIP_D, borderRadius: CHIP_D / 2,
    alignItems: "center", justifyContent: "center",
    // The ring is the category colour (set inline). Inside: the clear glass (GlassFill, which clips
    // itself) over a light dark floor — a 56 pt circle is a bigger surface than the old pill and
    // reads as thicker material (Apple-design §12), and map labels no longer print through the glyph.
    // The category colour replaces both when active.
    borderWidth: 2, backgroundColor: "rgba(20,22,26,0.38)",
    shadowColor: "#000", shadowOpacity: 0.25, shadowRadius: 4, shadowOffset: { width: 0, height: 2 }, elevation: 3,
  },
  chipLabel: { color: "#C7C7CC", fontSize: 11.5, fontWeight: "600", letterSpacing: 0.1, width: CHIP_D + 16, textAlign: "center" },
  chipLabelActive: { color: "#F4F4F4" },
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
    backgroundColor: "rgba(22,26,32,0.9)",
    borderWidth: 2,   // ring in the category's colour (set inline) — the chip's twin
    marginBottom: 6,
  },
  gridLabel: { color: COLORS.textDim, fontSize: 11, fontWeight: "600", textAlign: "center" },
  doneBtn: { marginTop: 6, alignSelf: "center", paddingHorizontal: 22, paddingVertical: 10, borderRadius: 999, backgroundColor: "rgba(255,255,255,0.10)" },
  doneText: { color: "#F4F4F4", fontWeight: "600", fontSize: 14 },

  // ===== Results dropdown =====
  dropdown: {
    marginTop: 8,
    alignSelf: "flex-start",
    width: "92%", maxWidth: 380,
    // Lighter translucent floor (was 0.97 opaque) so it reads as frosted glass; it
    // pops in inside an animated view where the real GlassView can't composite, so
    // this floor + a hairline is the panel. overflow clips the GlassFill.
    backgroundColor: "rgba(20,21,24,0.72)",
    borderRadius: 16, overflow: "hidden",
    borderWidth: StyleSheet.hairlineWidth, borderColor: "rgba(255,255,255,0.14)",
    paddingHorizontal: 14, paddingTop: 12, paddingBottom: 8,
    shadowColor: "#000", shadowOpacity: 0.4, shadowRadius: 16, shadowOffset: { width: 0, height: 8 },
    elevation: 16, zIndex: 50,
  },
  dropHeader: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", marginBottom: 4 },
  dropTitle: { color: "#F4F4F4", fontSize: 17, fontWeight: "700", letterSpacing: -0.2 },
  dropLoading: { flexDirection: "row", alignItems: "center", gap: 8, paddingVertical: 18, justifyContent: "center" },
  dropLoadingText: { color: "#9A9A9E", fontSize: 13 },
  dropEmpty: { color: "#9A9A9E", fontSize: 13, textAlign: "center", paddingVertical: 18 },
  resultRow: {
    flexDirection: "row", alignItems: "center", gap: 10,
    paddingVertical: 9,
    borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: "rgba(255,255,255,0.08)",
  },
  // The row badge: the chip's twin at 36 pt — dark fill, thin ring + glyph in the category colour.
  badge: { width: 36, height: 36, borderRadius: 18, borderWidth: 1.5, alignItems: "center", justifyContent: "center", backgroundColor: "rgba(22,26,32,0.9)" },
  resultLeft: { flex: 1 },
  resultTitleRow: { flexDirection: "row", alignItems: "baseline", gap: 8 },
  resultName: { flex: 1, color: "#F4F4F4", fontSize: 15, fontWeight: "600", letterSpacing: -0.2 },
  resultDist: { color: "#9A9A9E", fontSize: 13, fontWeight: "500" },
  resultAddr: { color: "rgba(244,244,244,0.7)", fontSize: 13, marginTop: 1 },
  metaRow: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 8, marginTop: 2 },
  meta: { color: "#9A9A9E", fontSize: 12, fontWeight: "500", letterSpacing: 0.2, flexShrink: 1 },
  gasPrice: { fontSize: 13, fontWeight: "800", letterSpacing: -0.1 },
});
