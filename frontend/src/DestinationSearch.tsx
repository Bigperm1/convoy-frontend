// Places Autocomplete search box for web (Google Places JS API)
import React, { useEffect, useRef, useState } from "react";
import { View, Text, StyleSheet, TextInput, TouchableOpacity, FlatList, Platform } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { COLORS } from "./theme";

const KEY = process.env.EXPO_PUBLIC_GOOGLE_MAPS_KEY as string;

type Suggestion = { place_id: string; description: string };

type Props = {
  origin?: { lat: number; lng: number };
  onSelect: (loc: { lat: number; lng: number; label: string }) => void;
  onClear?: () => void;
  initialValue?: string;
};

let _placesService: any = null;
let _autocompleteService: any = null;
let _sessionToken: any = null;
let _googleReadyPromise: Promise<void> | null = null;

function ensureGoogle(): Promise<void> {
  if (typeof window === "undefined") return Promise.reject("No window");
  if ((window as any).google?.maps?.places) return Promise.resolve();
  if (_googleReadyPromise) return _googleReadyPromise;
  _googleReadyPromise = new Promise<void>((resolve, reject) => {
    const id = "gmaps-places";
    if (document.getElementById(id)) {
      const wait = () => {
        if ((window as any).google?.maps?.places) resolve();
        else setTimeout(wait, 100);
      };
      wait(); return;
    }
    const s = document.createElement("script");
    s.id = id;
    s.src = `https://maps.googleapis.com/maps/api/js?key=${KEY}&libraries=places`;
    s.async = true;
    s.onload = () => resolve();
    s.onerror = () => reject(new Error("Failed to load Google Maps Places"));
    document.head.appendChild(s);
  });
  return _googleReadyPromise;
}

export default function DestinationSearch({ origin, onSelect, onClear, initialValue }: Props) {
  const [text, setText] = useState(initialValue || "");
  const [suggestions, setSuggestions] = useState<Suggestion[]>([]);
  const [open, setOpen] = useState(false);
  const tRef = useRef<any>(null);

  useEffect(() => {
    if (Platform.OS !== "web") return;
    ensureGoogle().then(() => {
      const g = (window as any).google;
      if (!g?.maps?.places) return;
      _autocompleteService = new g.maps.places.AutocompleteService();
      _placesService = new g.maps.places.PlacesService(document.createElement("div"));
      _sessionToken = new g.maps.places.AutocompleteSessionToken();
    }).catch(() => {});
  }, []);

  const queryAutocomplete = (q: string) => {
    if (!q || !_autocompleteService) { setSuggestions([]); return; }
    _autocompleteService.getPlacePredictions(
      {
        input: q,
        sessionToken: _sessionToken,
        ...(origin ? { location: new (window as any).google.maps.LatLng(origin.lat, origin.lng), radius: 50000 } : {}),
      },
      (preds: any[]) => {
        if (!preds) { setSuggestions([]); return; }
        setSuggestions(preds.slice(0, 5).map((p) => ({ place_id: p.place_id, description: p.description })));
      }
    );
  };

  const onChangeText = (q: string) => {
    setText(q); setOpen(true);
    if (tRef.current) clearTimeout(tRef.current);
    tRef.current = setTimeout(() => queryAutocomplete(q), 220);
  };

  const pick = (s: Suggestion) => {
    if (!_placesService) return;
    _placesService.getDetails({ placeId: s.place_id, fields: ["geometry", "name", "formatted_address"], sessionToken: _sessionToken }, (place: any, status: string) => {
      if (status !== "OK" || !place?.geometry) return;
      const lat = place.geometry.location.lat();
      const lng = place.geometry.location.lng();
      const label = place.name ? `${place.name}` : (place.formatted_address || s.description);
      setText(label); setOpen(false); setSuggestions([]);
      _sessionToken = new (window as any).google.maps.places.AutocompleteSessionToken();
      onSelect({ lat, lng, label });
    });
  };

  const clear = () => { setText(""); setSuggestions([]); setOpen(false); onClear?.(); };

  if (Platform.OS !== "web") {
    return null;
  }

  return (
    <View style={styles.wrap} pointerEvents="box-none">
      <View style={styles.bar}>
        <Ionicons name="search" size={18} color={COLORS.textDim} />
        <TextInput
          testID="destination-input"
          value={text}
          onChangeText={onChangeText}
          placeholder="Search destination"
          placeholderTextColor={COLORS.textMute}
          style={styles.input}
          onFocus={() => setOpen(true)}
        />
        {!!text && (
          <TouchableOpacity testID="destination-clear" onPress={clear}>
            <Ionicons name="close-circle" size={20} color={COLORS.textDim} />
          </TouchableOpacity>
        )}
      </View>
      {open && suggestions.length > 0 && (
        <View style={styles.list}>
          {suggestions.map((s) => (
            <TouchableOpacity key={s.place_id} testID={`sug-${s.place_id}`} style={styles.row} onPress={() => pick(s)}>
              <Ionicons name="location" size={16} color={COLORS.primary} />
              <Text style={styles.rowText} numberOfLines={1}>{s.description}</Text>
            </TouchableOpacity>
          ))}
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: {},
  bar: {
    flexDirection: "row", alignItems: "center", gap: 8,
    backgroundColor: "rgba(28,28,30,0.92)", paddingHorizontal: 14, paddingVertical: 10,
    borderRadius: 14, borderWidth: 1, borderColor: COLORS.hairlineStrong,
  },
  input: { flex: 1, color: COLORS.text, fontSize: 15, padding: 0 },
  list: { backgroundColor: "rgba(28,28,30,0.96)", borderRadius: 12, marginTop: 8, borderWidth: 1, borderColor: COLORS.hairline, overflow: "hidden" },
  row: { flexDirection: "row", alignItems: "center", gap: 10, padding: 12 },
  rowText: { color: COLORS.text, flex: 1, fontSize: 14 },
});
