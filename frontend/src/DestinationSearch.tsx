// Cross-platform Places Autocomplete using the Places (New) REST endpoint on native,
// and the JS Maps lib (already loaded by ConvoyMap) on web.
import React, { useEffect, useRef, useState } from "react";
import { View, Text, StyleSheet, TextInput, TouchableOpacity, Platform, ScrollView, Keyboard, PanResponder, Image } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { COLORS } from "./theme";
import { geocodeQuery } from "./voiceBus";
import ConvoyWaveIcon from "./components/ConvoyWaveIcon";
import { useAuth } from "./auth";
import { GOOGLE_MAPS_KEY } from "./api";

const KEY = GOOGLE_MAPS_KEY;

type Suggestion = { place_id: string; description: string };
type Props = {
  origin?: { lat: number; lng: number };
  onSelect: (loc: { lat: number; lng: number; label: string }) => void;
  onClear?: () => void;
  initialValue?: string;
  // Tapping the round profile avatar on the right of the bar opens whatever
  // the consumer wants (typically the Hub screen).
  onProfilePress?: () => void;
  // Optional override for the right-side profile control. When provided, this
  // node is rendered in place of the default avatar button (used by the map
  // to drop in the global LogoMenu). Takes precedence over onProfilePress.
  profileSlot?: React.ReactNode;
  // When provided, the text field becomes a button: tapping it fires this
  // instead of typing inline (the map uses it to open the full-screen search
  // screen). The mic + logo remain fully interactive.
  onPressField?: () => void;
  // Tap the comms-wave icon (replaces the old mic) → open Comms.
  onCommsPress?: () => void;
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

// REST-based autocomplete via the Places API (New) — works on iOS/Android/Expo Go.
// The legacy /maps/api/place/* endpoints are NOT available to projects that
// first enabled Places after 1 Mar 2025 (convoy-497805's key was created later),
// so they return REQUEST_DENIED and the search silently showed no suggestions.
// Places (New) uses POST + a JSON body + an X-Goog-Api-Key header.
async function autocompleteRest(input: string, origin?: { lat: number; lng: number }, onDebug?: (s: string) => void): Promise<Suggestion[]> {
  try {
    const body: any = { input };
    if (origin) {
      body.locationBias = {
        circle: { center: { latitude: origin.lat, longitude: origin.lng }, radius: 50000.0 },
      };
    }
    const res = await fetch("https://places.googleapis.com/v1/places:autocomplete", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Goog-Api-Key": KEY },
      body: JSON.stringify(body),
    });
    const data = await res.json();
    onDebug?.(`HTTP ${res.status}${res.ok ? "" : " ERR"} key=\u2026${(KEY || "").slice(-5)} ${JSON.stringify(data).slice(0, 150)}`);
    // (New) returns { suggestions: [{ placePrediction: { placeId, text: { text } } }, ...] }.
    // Some entries can be queryPrediction (no place) — filter to placePrediction only.
    return (data.suggestions || [])
      .filter((s: any) => s.placePrediction)
      .slice(0, 5)
      .map((s: any) => ({
        place_id: s.placePrediction.placeId,
        description: s.placePrediction.text?.text ?? "",
      }));
  } catch (e) { onDebug?.(`THREW key=\u2026${(KEY || "").slice(-5)}: ${String(e).slice(0, 150)}`); return []; }
}

// Place Details via the Places API (New): GET /v1/places/{placeId} with a field
// mask header. Returns location + names we map back to our {lat,lng,label} shape.
async function placeDetailsRest(place_id: string): Promise<{ lat: number; lng: number; label: string } | null> {
  try {
    const res = await fetch(`https://places.googleapis.com/v1/places/${place_id}`, {
      method: "GET",
      headers: {
        "X-Goog-Api-Key": KEY,
        "X-Goog-FieldMask": "location,displayName,formattedAddress",
      },
    });
    const data = await res.json();
    if (!data.location) return null;
    return {
      lat: data.location.latitude,
      lng: data.location.longitude,
      label: data.displayName?.text || data.formattedAddress || "",
    };
  } catch { return null; }
}

export default function DestinationSearch({ origin, onSelect, onClear, initialValue, onProfilePress, profileSlot, onPressField, onCommsPress }: Props) {
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

  // Profile avatar identity. The in-bar mic/voice machinery was removed — the
  // comms-wave icon now opens Comms via onCommsPress.
  const { user } = useAuth();

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
          {/* Convoy logo on the LEFT = the menu button (Google puts its 'G'
              here). Tapping opens the Convoy menu, which drops below the bar.
              Falls back to a search glyph if no logo slot was provided. */}
          {profileSlot ? (
            <View style={styles.logoSlot}>{profileSlot}</View>
          ) : (
            <Ionicons name="search" size={18} color="rgba(235,235,245,0.55)" />
          )}
          {onPressField ? (
            <TouchableOpacity
              testID="destination-open-search"
              style={styles.fieldTap}
              activeOpacity={0.7}
              onPress={onPressField}
            >
              <Text style={styles.fieldTapText} numberOfLines={1}>Search here</Text>
            </TouchableOpacity>
          ) : (
            <TextInput
              testID="destination-input"
              value={text}
              onChangeText={onChangeText}
              placeholder="Search here"
              placeholderTextColor="#808080"
              style={styles.input}
              onFocus={() => setOpen(true)}
              returnKeyType="go"
              onSubmitEditing={submit}
              blurOnSubmit={false}
            />
          )}
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
              <Ionicons name="close-circle" size={20} color="rgba(235,235,245,0.6)" />
            </TouchableOpacity>
          )}
          {/* Comms-wave icon (replaces the old mic) — tap to open Comms. */}
          <TouchableOpacity
            testID="search-comms"
            onPress={onCommsPress}
            activeOpacity={0.7}
            hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
            style={styles.micBtn}
          >
            <ConvoyWaveIcon size={26} color="#2DEC86" />
          </TouchableOpacity>
        </View>
        {/* Logo/menu now lives on the LEFT inside the bar — no right-side control. */}
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
              <Ionicons name="location" size={16} color={COLORS.brand} />
              <Text style={styles.rowText} numberOfLines={1}>{s.description}</Text>
            </TouchableOpacity>
          ))}
        </ScrollView>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  // Full-width wrapper — the parent `topBar` View in map.tsx now owns the
  // safe-area paddingTop and horizontal gutters, so this just needs to
  // stretch across the available space.
  wrap: {
    width: '100%',
  },
  // Outer row — flex-row containing the white pill (flex:1) AND the profile
  // avatar (34×34) as siblings. marginTop/marginHorizontal are 0 because
  // the parent `topBar` View in map.tsx now owns those spacings.
  searchRow: {
    flexDirection: 'row',
    alignItems: 'center',
    marginHorizontal: 0,
    marginTop: 0,
  },
  // Google-Maps-style white pill. Uses paddingVertical (7) instead of a fixed
  // height so the pill stays a tad slimmer; borderRadius 28 keeps the round
  // pill aesthetic. flex:1 lets the bar absorb all leftover horizontal space
  // while the avatar holds its 34px footprint to the right.
  bar: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    backgroundColor: 'rgba(34,35,38,0.96)',
    paddingLeft: 8,
    paddingRight: 14,
    paddingVertical: 7,
    borderRadius: 28,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: 'rgba(255,255,255,0.12)',
    shadowColor: '#000',
    shadowOpacity: 0.3,
    shadowRadius: 8,
    shadowOffset: { width: 0, height: 3 },
    elevation: 5,
  },
  // Dark charcoal text on white surface — high contrast for readability.
  input: { flex: 1, fontSize: 16, color: '#F4F4F4', paddingVertical: 0 },
  // Read-only tappable field — the map passes onPressField to open the
  // full-screen search. Mirrors the input's flex + font so the bar is identical.
  fieldTap: { flex: 1, justifyContent: 'center', paddingVertical: 2 },
  fieldTapText: { fontSize: 16, color: '#808080' },
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
    width: 38, height: 38, borderRadius: 19,
    alignItems: 'center', justifyContent: 'center',
    marginLeft: 2,
  },
  // Recording: fills hot red with a glowing halo so the press reads as a big,
  // dynamic "transmitting" state (like the comms PTT press), white glyph on top.
  micBtnRecording: {
    backgroundColor: '#FF3B30',
    shadowColor: '#FF3B30', shadowOpacity: 0.9, shadowRadius: 12, shadowOffset: { width: 0, height: 0 },
    elevation: 10,
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
  // Wrapper that keeps a custom profileSlot (e.g. LogoMenu) on the same
  // vertical centerline as the search pill, matching the avatar's gutter.
  avatarSlot: { marginLeft: 10, alignSelf: 'center' },
  // Leading logo/menu button inside the bar (left), Google 'G' position.
  logoSlot: { alignSelf: 'center', marginRight: 2 },
  // Suggestion list — white surface harmonizes with the new bar; dark text.
  // Offset by the row's horizontal padding (12) so it visually aligns under
  // the pill rather than under the avatar.
  list: { backgroundColor: "rgba(28,28,30,0.98)", borderRadius: 14, marginTop: 8, marginHorizontal: 12, borderWidth: StyleSheet.hairlineWidth, borderColor: "rgba(255,255,255,0.10)", overflow: "hidden", shadowColor: "#000", shadowOpacity: 0.3, shadowRadius: 6, shadowOffset: { width: 0, height: 2 }, elevation: 3 },
  row: { flexDirection: "row", alignItems: "center", gap: 10, padding: 12 },
  rowText: { color: "#F4F4F4", flex: 1, fontSize: 14 },
});
