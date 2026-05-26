// Cross-platform Places Autocomplete using the Places (New) REST endpoint on native,
// and the JS Maps lib (already loaded by ConvoyMap) on web.
import React, { useEffect, useRef, useState } from "react";
import { View, Text, StyleSheet, TextInput, TouchableOpacity, Platform, ScrollView, Keyboard, PanResponder, Animated, Easing, Image } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { COLORS } from "./theme";
import { geocodeQuery } from "./voiceBus";
import { useVoice } from "./useVoice";
import { useAuth } from "./auth";

const KEY = process.env.EXPO_PUBLIC_GOOGLE_MAPS_KEY as string;

type Suggestion = { place_id: string; description: string };
type Props = {
  origin?: { lat: number; lng: number };
  onSelect: (loc: { lat: number; lng: number; label: string }) => void;
  onClear?: () => void;
  initialValue?: string;
  // Tapping the round profile avatar on the right of the bar opens whatever
  // the consumer wants (typically the Hub screen).
  onProfilePress?: () => void;
};

let _placesService: any = null;
let _autocompleteService: any = null;
let _sessionToken: any = null;
let _googleReadyPromise: Promise<void> | null = null;

function ensureGoogleWeb(): Promise<void> {
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

// REST-based autocomplete (works on iOS/Android/Expo Go)
async function autocompleteRest(input: string, origin?: { lat: number; lng: number }): Promise<Suggestion[]> {
  const url = new URL("https://maps.googleapis.com/maps/api/place/autocomplete/json");
  url.searchParams.set("input", input);
  url.searchParams.set("key", KEY);
  if (origin) {
    url.searchParams.set("location", `${origin.lat},${origin.lng}`);
    url.searchParams.set("radius", "50000");
  }
  try {
    const res = await fetch(url.toString());
    const data = await res.json();
    if (data.status !== "OK") return [];
    return (data.predictions || []).slice(0, 5).map((p: any) => ({ place_id: p.place_id, description: p.description }));
  } catch { return []; }
}

async function placeDetailsRest(place_id: string): Promise<{ lat: number; lng: number; label: string } | null> {
  const url = new URL("https://maps.googleapis.com/maps/api/place/details/json");
  url.searchParams.set("place_id", place_id);
  url.searchParams.set("fields", "geometry/location,name,formatted_address");
  url.searchParams.set("key", KEY);
  try {
    const res = await fetch(url.toString());
    const data = await res.json();
    if (data.status !== "OK") return null;
    const r = data.result;
    return {
      lat: r.geometry.location.lat,
      lng: r.geometry.location.lng,
      label: r.name || r.formatted_address,
    };
  } catch { return null; }
}

export default function DestinationSearch({ origin, onSelect, onClear, initialValue, onProfilePress }: Props) {
  const [text, setText] = useState(initialValue || "");
  const [suggestions, setSuggestions] = useState<Suggestion[]>([]);
  const [open, setOpen] = useState(false);
  const tRef = useRef<any>(null);

  useEffect(() => {
    if (Platform.OS !== "web") return;
    ensureGoogleWeb().then(() => {
      const g = (window as any).google;
      if (!g?.maps?.places) return;
      _autocompleteService = new g.maps.places.AutocompleteService();
      _placesService = new g.maps.places.PlacesService(document.createElement("div"));
      _sessionToken = new g.maps.places.AutocompleteSessionToken();
    }).catch(() => {});
  }, []);

  const queryAutocomplete = async (q: string) => {
    if (!q) { setSuggestions([]); return; }
    if (Platform.OS === "web") {
      if (!_autocompleteService) return;
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
    } else {
      const list = await autocompleteRest(q, origin);
      setSuggestions(list);
    }
  };

  const onChangeText = (q: string) => {
    setText(q); setOpen(true);
    if (tRef.current) clearTimeout(tRef.current);
    tRef.current = setTimeout(() => queryAutocomplete(q), 220);
  };

  const pick = async (s: Suggestion) => {
    if (Platform.OS === "web") {
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
    } else {
      const detail = await placeDetailsRest(s.place_id);
      if (!detail) return;
      setText(detail.label); setOpen(false); setSuggestions([]);
      onSelect(detail);
    }
  };

  const clear = () => { setText(""); setSuggestions([]); setOpen(false); onClear?.(); };

  // --- In-bar mic (PTT) + profile avatar ---
  // Press-and-hold the yellow mic to record a voice command. Same pipeline the
  // old elevated tab-bar mic used: useVoice() → transcribe → voiceBus broadcast.
  // The mic lives inside the search bar (Google Maps-style) and the round
  // profile avatar sits at the very right of the bar.
  const voice = useVoice();
  const { user } = useAuth();
  const micPulse = useRef(new Animated.Value(1)).current;
  useEffect(() => {
    if (voice.recording) {
      Animated.loop(
        Animated.sequence([
          Animated.timing(micPulse, { toValue: 1.18, duration: 420, easing: Easing.out(Easing.quad), useNativeDriver: true }),
          Animated.timing(micPulse, { toValue: 1.04, duration: 420, easing: Easing.in(Easing.quad), useNativeDriver: true }),
        ])
      ).start();
    } else {
      micPulse.stopAnimation();
      micPulse.setValue(1);
    }
  }, [voice.recording, micPulse]);
  const onMicPressIn = async () => { await voice.start(); };
  const onMicPressOut = async () => {
    const uri = await voice.stop();
    if (uri) await voice.transcribe(uri); // result broadcast on voiceBus → VoiceController banner + routing
  };

  // Profile avatar — for now everyone falls back to the generic person icon
  // (the user model doesn't yet ship a stored avatar field on the server).
  // The component is structured so that the day a user uploads a profile
  // picture, only the conditional `avatarUri` needs to point at the new field.
  const avatarUri: string | null = (user as any)?.avatar_b64
    ? `data:image/jpeg;base64,${(user as any).avatar_b64}`
    : null;

  // Enter-to-go fallback: if there's an autocomplete suggestion, pick the first;
  // otherwise free-form geocode the typed text. Also gives the destination
  // search a "press Enter / Go" affordance which works in headless tests.
  const submit = async () => {
    const q = text.trim();
    if (!q) return;
    if (suggestions.length > 0) { pick(suggestions[0]); return; }
    const loc = await geocodeQuery(q, origin);
    if (!loc) return;
    setText(loc.label); setOpen(false); setSuggestions([]);
    onSelect(loc);
  };

  // Swipe-down-to-dismiss keyboard on the search bar itself.
  // The suggestions ScrollView already uses keyboardDismissMode="on-drag",
  // but a vertical swipe over the input/Go-button row needs its own handler
  // since RN doesn't bubble pan events out of TextInput on iOS. Threshold:
  // 12px downward dy = clear intent (avoid accidental dismiss on tap jitter).
  const dismissPan = useRef(
    PanResponder.create({
      onStartShouldSetPanResponder: () => false,
      onMoveShouldSetPanResponder: (_e, g) => g.dy > 12 && Math.abs(g.dy) > Math.abs(g.dx) * 1.2,
      onPanResponderMove: () => { Keyboard.dismiss(); },
    })
  ).current;

  return (
    <View style={styles.wrap} pointerEvents="box-none">
      {/* Outer row — fixed 48px tall, vertically centers the white search pill
          AND the profile avatar so they sit on the same baseline regardless
          of which inner control is rendered. The avatar lives OUTSIDE the
          white pill (Google Maps style) so the pill can collapse around its
          own content without affecting avatar placement. */}
      <View style={styles.searchRow} pointerEvents="box-none">
        <View style={styles.bar} {...dismissPan.panHandlers}>
          {/* Charcoal search glyph on the left — Google Maps style anchor.
              Dark color (#5F6368) works against the new white pill bar. */}
          <Ionicons name="search" size={18} color="#5F6368" />
          <TextInput
            testID="destination-input"
            value={text}
            onChangeText={onChangeText}
            placeholder="Search destination"
            placeholderTextColor="#80868B"
            style={styles.input}
            onFocus={() => setOpen(true)}
            returnKeyType="go"
            onSubmitEditing={submit}
            blurOnSubmit={false}
          />
          {/* Submit / clear — only shown when there's text in the field, so the
              mic occupies a stable position on the right at all times. */}
          {!!text.trim() && (
            <TouchableOpacity
              testID="destination-go"
              onPress={submit}
              style={styles.goBtn}
            >
              <Ionicons name="arrow-forward" size={18} color="#fff" />
            </TouchableOpacity>
          )}
          {!!text && (
            <TouchableOpacity testID="destination-clear" onPress={clear}>
              <Ionicons name="close-circle" size={20} color="#5F6368" />
            </TouchableOpacity>
          )}
          {/* PTT mic — yellow circle, press-and-hold like Google Maps' voice
              search. Pulses while recording so users have a clear visual cue. */}
          <Animated.View style={{ transform: [{ scale: micPulse }] }}>
            <TouchableOpacity
              testID="search-mic"
              onPressIn={onMicPressIn}
              onPressOut={onMicPressOut}
              activeOpacity={0.85}
              style={[styles.micBtn, voice.recording && styles.micBtnRec]}
            >
              <Ionicons
                name={voice.recording ? "radio" : "mic"}
                size={16}
                color={voice.recording ? "#fff" : "#1a1a1a"}
              />
            </TouchableOpacity>
          </Animated.View>
        </View>
        {/* Profile avatar — opens the Hub screen. OUTSIDE the white pill, to
            the right, with marginLeft 10 so it visually reads as a separate
            element (mirrors Google Maps). alignSelf: "center" keeps it on
            the row's vertical centerline alongside the pill. */}
        <TouchableOpacity
          testID="search-profile"
          onPress={onProfilePress}
          activeOpacity={0.8}
          style={styles.avatarBtn}
        >
          {avatarUri ? (
            <Image source={{ uri: avatarUri }} style={styles.avatarImg} />
          ) : (
            <Ionicons name="person" size={18} color="#fff" />
          )}
        </TouchableOpacity>
      </View>
      {open && suggestions.length > 0 && (
        <ScrollView
          // Swipe-to-dismiss-keyboard: a downward drag in the suggestions list
          // tells RN to drop the keyboard. Native = "on-drag", web ignores.
          keyboardDismissMode="on-drag"
          keyboardShouldPersistTaps="handled"
          style={styles.list}
          // List can grow up to ~5 rows; ScrollView hands off scrolling cleanly.
        >
          {suggestions.map((s) => (
            <TouchableOpacity key={s.place_id} testID={`sug-${s.place_id}`} style={styles.row} onPress={() => { Keyboard.dismiss(); pick(s); }}>
              <Ionicons name="location" size={16} color={COLORS.primary} />
              <Text style={styles.rowText} numberOfLines={1}>{s.description}</Text>
            </TouchableOpacity>
          ))}
        </ScrollView>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: {},
  // Outer row — fixed 48px tall, respects iOS/Android safe area via marginTop.
  // Houses the white search pill (flex:1) PLUS the profile avatar (34×34) as
  // sibling children. NO absolute positioning — pure flex row.
  searchRow: {
    flexDirection: 'row',
    alignItems: 'center',
    marginHorizontal: 12,
    marginTop: Platform.OS === 'ios' ? 56 : 36,
    height: 48,
  },
  // Google-Maps-style white pill — flex:1 absorbs all leftover horizontal
  // space while the avatar holds its 34px footprint to the right.
  bar: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    height: 46,
    borderRadius: 23,
    backgroundColor: '#FFFFFF',
    paddingHorizontal: 12,
    shadowColor: '#000',
    shadowOpacity: 0.15,
    shadowRadius: 8,
    shadowOffset: { width: 0, height: 2 },
    elevation: 5,
  },
  // Dark charcoal text on white surface — high contrast for readability.
  input: { flex: 1, fontSize: 16, color: '#1C1C1E', paddingVertical: 0 },
  // The Go arrow stays in Convoy blue accent so the submit affordance is
  // unmistakable on the light bar.
  goBtn: {
    width: 28, height: 28, borderRadius: 14,
    backgroundColor: COLORS.primary,
    alignItems: "center", justifyContent: "center",
  },
  goBtnDisabled: { opacity: 0.35 },
  // Yellow PTT mic — 30×30 circle, inline child of the bar (NOT absolute).
  // marginLeft 6 keeps it tight against the input text.
  micBtn: {
    width: 30, height: 30, borderRadius: 15,
    backgroundColor: '#FFD60A',
    alignItems: 'center', justifyContent: 'center',
    marginLeft: 6,
  },
  // When actively recording the mic flips to a hot red to mirror the legacy
  // tab-bar mic's "now broadcasting" affordance.
  micBtnRec: { backgroundColor: "#FF3B30" },
  // Profile avatar — 34×34 circle to the RIGHT of the search pill (OUTSIDE
  // the white surface). Sibling of `.bar` inside `.searchRow` so it stays
  // vertically centered with no absolute positioning.
  avatarBtn: {
    width: 34, height: 34, borderRadius: 17,
    marginLeft: 10,
    borderWidth: 2, borderColor: '#FFFFFF',
    alignSelf: 'center',
    backgroundColor: '#5F6368',
    alignItems: 'center', justifyContent: 'center',
    overflow: 'hidden',
    shadowColor: '#000', shadowOpacity: 0.18, shadowRadius: 4, shadowOffset: { width: 0, height: 2 }, elevation: 3,
  },
  avatarImg: { width: 34, height: 34 },
  // Suggestion list — white surface harmonizes with the new bar; dark text.
  // Offset by the row's horizontal padding (12) so it visually aligns under
  // the pill rather than under the avatar.
  list: { backgroundColor: "#FFFFFF", borderRadius: 14, marginTop: 8, marginHorizontal: 12, borderWidth: StyleSheet.hairlineWidth, borderColor: "rgba(0,0,0,0.08)", overflow: "hidden", shadowColor: "#000", shadowOpacity: 0.15, shadowRadius: 6, shadowOffset: { width: 0, height: 2 }, elevation: 3 },
  row: { flexDirection: "row", alignItems: "center", gap: 10, padding: 12 },
  rowText: { color: "#202124", flex: 1, fontSize: 14 },
});
