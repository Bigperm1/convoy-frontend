// WeatherHUD â compact on-map weather chip shown when the weather layer is on.
// Displays current temperature, conditions icon, wind and precip at a glance.
import React, { useState, useEffect } from "react";
import { View, Text, StyleSheet, Platform, TouchableOpacity } from "react-native";
import { Ionicons, MaterialCommunityIcons } from "@expo/vector-icons";
import type { WeatherCondition, ForecastDay } from "../weatherLayer";
import { weatherKind, windDirectionLabel, type WeatherKind } from "../weatherLayer";

type Props = {
  weather: WeatherCondition;
  unit: 'kmh' | 'mph';
  compact?: boolean;
  // 7-day outlook for the tappable compact chip popup (driver's location).
  forecast?: ForecastDay[] | null;
};

// Two-tone weather glyph — composes layered vector icons so each condition
// reads with its natural colors: sun yellow, cloud grey, rain blue, lightning
// yellow, snow pale-blue. Driven by weatherKind() off the live conditions.
const WX = {
  sun: "#FFD60A",
  moon: "#DCE3F0",
  cloud: "#AEB4BD",
  cloudDark: "#8E949E",
  rain: "#5AC8FA",
  bolt: "#FFD60A",
  snow: "#EAF6FF",
};

function WeatherGlyph({ kind, size }: { kind: WeatherKind; size: number }) {
  const S = size;
  const layer = (
    align: "flex-start" | "center" | "flex-end",
    justify: "flex-start" | "center" | "flex-end",
    node: React.ReactNode
  ) => (
    <View style={{ position: "absolute", left: 0, right: 0, top: 0, bottom: 0, alignItems: align, justifyContent: justify }}>
      {node}
    </View>
  );
  let body: React.ReactNode;
  switch (kind) {
    case "clear-day":
      body = layer("center", "center", <Ionicons name="sunny" size={S} color={WX.sun} />);
      break;
    case "clear-night":
      body = layer("center", "center", <Ionicons name="moon" size={S * 0.92} color={WX.moon} />);
      break;
    case "cloudy":
      body = layer("center", "center", <Ionicons name="cloud" size={S * 0.95} color={WX.cloud} />);
      break;
    case "fog":
      body = layer("center", "center", <MaterialCommunityIcons name="weather-fog" size={S} color={WX.cloud} />);
      break;
    case "partly-night":
      body = (
        <>
          {layer("flex-end", "flex-start", <Ionicons name="moon" size={S * 0.5} color={WX.moon} />)}
          {layer("flex-start", "flex-end", <Ionicons name="cloud" size={S * 0.8} color={WX.cloud} />)}
        </>
      );
      break;
    case "rain":
      body = (
        <>
          {layer("center", "flex-start", <Ionicons name="cloud" size={S * 0.78} color={WX.cloud} />)}
          {layer("center", "flex-end",
            <View style={{ flexDirection: "row", gap: S * 0.12 }}>
              <Ionicons name="water" size={S * 0.3} color={WX.rain} />
              <Ionicons name="water" size={S * 0.3} color={WX.rain} />
            </View>
          )}
        </>
      );
      break;
    case "snow":
      body = (
        <>
          {layer("center", "flex-start", <Ionicons name="cloud" size={S * 0.78} color={WX.cloud} />)}
          {layer("center", "flex-end", <MaterialCommunityIcons name="snowflake" size={S * 0.4} color={WX.snow} />)}
        </>
      );
      break;
    case "thunder":
      body = (
        <>
          {layer("center", "flex-start", <Ionicons name="cloud" size={S * 0.78} color={WX.cloudDark} />)}
          {layer("center", "flex-end", <Ionicons name="flash" size={S * 0.52} color={WX.bolt} />)}
        </>
      );
      break;
    case "partly-day":
    default:
      body = (
        <>
          {layer("flex-end", "flex-start", <Ionicons name="sunny" size={S * 0.6} color={WX.sun} />)}
          {layer("flex-start", "flex-end", <Ionicons name="cloud" size={S * 0.8} color={WX.cloud} />)}
        </>
      );
      break;
  }
  return <View style={{ width: S, height: S }}>{body}</View>;
}

export default function WeatherHUD({ weather, unit, compact, forecast }: Props) {
  const DEG = "\u00B0";
  const [open, setOpen] = useState(false);
  // Auto-collapse the 7-day forecast back to the compact chip 5s after it opens.
  // Keyed on `open`, so each (re)open restarts a fresh 5s timer.
  useEffect(() => {
    if (!open) return;
    const t = setTimeout(() => setOpen(false), 5000);
    return () => clearTimeout(t);
  }, [open]);
  const temp = unit === 'mph'
    ? `${Math.round(weather.tempF)}${DEG}F`
    : `${Math.round(weather.tempC)}${DEG}C`;
  const wind = unit === 'mph'
    ? `${Math.round(weather.windSpeedMph)} mph ${windDirectionLabel(weather.windDirectionDeg)}`
    : `${Math.round(weather.windSpeedKph)} km/h ${windDirectionLabel(weather.windDirectionDeg)}`;

  if (compact) {
    const tempVal = (c: number, f: number) => (unit === 'mph' ? Math.round(f) : Math.round(c));
    return (
      <View style={styles.compactWrap}>
        {open && (
          <View style={styles.forecastCard}>
            <Text style={styles.forecastTitle}>7-Day Forecast</Text>
            {forecast && forecast.length > 0 ? (
              forecast.slice(0, 7).map((d) => (
                <View key={d.startMs} style={styles.forecastRow}>
                  <Text style={styles.forecastDay} numberOfLines={1}>{d.label}</Text>
                  <View style={styles.forecastGlyph}>
                    <WeatherGlyph kind={d.kind} size={22} />
                  </View>
                  <Text style={styles.forecastPrecip}>
                    {d.precipProbability > 0 ? `${d.precipProbability}%` : ''}
                  </Text>
                  <Text style={styles.forecastHi}>{tempVal(d.hiC, d.hiF)}{DEG}</Text>
                  <Text style={styles.forecastLo}>{tempVal(d.loC, d.loF)}{DEG}</Text>
                </View>
              ))
            ) : (
              <Text style={styles.forecastLoading}>Loading forecast…</Text>
            )}
          </View>
        )}
        <TouchableOpacity
          activeOpacity={0.8}
          onPress={() => setOpen((o) => !o)}
          style={styles.compactChip}
          testID="weather-chip"
        >
          <WeatherGlyph kind={weatherKind(weather)} size={26} />
          <Text style={styles.compactTemp} numberOfLines={1} adjustsFontSizeToFit minimumFontScale={0.7}>{temp}</Text>
        </TouchableOpacity>
      </View>
    );
  }

  return (
    <View style={styles.chip}>
      <WeatherGlyph kind={weatherKind(weather)} size={20} />
      <Text style={styles.temp}>{temp}</Text>
      <View style={styles.divider} />
      <Ionicons name="arrow-up-circle-outline" size={13} color="rgba(255,255,255,0.55)" style={{ transform: [{ rotate: `${weather.windDirectionDeg}deg` }] }} />
      <Text style={styles.wind}>{wind}</Text>
      {weather.precipProbability > 0 && (
        <>
          <View style={styles.divider} />
          <Ionicons name="water-outline" size={13} color="#5AC8FA" />
          <Text style={styles.precip}>{weather.precipProbability}%</Text>
        </>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  chip: {
    flexDirection: "row",
    alignItems: "center",
    gap: 5,
    backgroundColor: "rgba(12,12,16,0.88)",
    borderRadius: 22,
    paddingHorizontal: 12,
    paddingVertical: 7,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: "rgba(255,255,255,0.12)",
    ...Platform.select({
      ios: { shadowColor: "#000", shadowOpacity: 0.4, shadowRadius: 8, shadowOffset: { width: 0, height: 3 } },
      android: { elevation: 6 },
    }),
  },
  temp: { color: "#F4F4F4", fontSize: 15, fontWeight: "700" },
  wind: { color: "#808080", fontSize: 11, fontWeight: "500" },
  precip: { color: "#5AC8FA", fontSize: 11, fontWeight: "600" },
  divider: { width: StyleSheet.hairlineWidth, height: 16, backgroundColor: "rgba(255,255,255,0.15)", marginHorizontal: 2 },
  // ===== Tappable compact chip + 7-day forecast popup =====
  // Column wrapper: the forecast card sits ABOVE the chip and the chip stays
  // bottom-anchored (the map mounts this in a bottom-anchored absolute box, so
  // adding the card grows the box upward). flex-start keeps both left edges
  // aligned with the weather icon.
  compactWrap: { alignItems: "flex-start" },
  forecastCard: {
    width: 224,
    marginBottom: 8,
    paddingHorizontal: 12,
    paddingVertical: 10,
    borderRadius: 16,
    backgroundColor: "rgba(12,12,16,0.95)",
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: "rgba(255,255,255,0.14)",
    ...Platform.select({
      ios: { shadowColor: "#000", shadowOpacity: 0.45, shadowRadius: 12, shadowOffset: { width: 0, height: 6 } },
      android: { elevation: 10 },
    }),
  },
  forecastTitle: {
    color: "#808080", fontSize: 11, fontWeight: "700",
    letterSpacing: 0.4, textTransform: "uppercase", marginBottom: 6, marginLeft: 2,
  },
  forecastRow: { flexDirection: "row", alignItems: "center", paddingVertical: 5, gap: 8 },
  forecastDay: { width: 40, color: "#F4F4F4", fontSize: 13, fontWeight: "600" },
  forecastGlyph: { width: 26, height: 24, alignItems: "center", justifyContent: "center" },
  forecastPrecip: { flex: 1, color: "#5AC8FA", fontSize: 11, fontWeight: "600" },
  forecastHi: { width: 32, color: "#F4F4F4", fontSize: 13, fontWeight: "700", textAlign: "right" },
  forecastLo: { width: 30, color: "#808080", fontSize: 13, fontWeight: "600", textAlign: "right" },
  forecastLoading: { color: "#808080", fontSize: 12, paddingVertical: 8, textAlign: "center" },
  // Compact temp-only chip — matches the SpeedPill box (size + opacity) so the
  // weather + speed chips stack cleanly in the bottom-left HUD column.
  compactChip: {
    width: 84,
    height: 60,
    paddingHorizontal: 8,
    paddingVertical: 8,
    borderRadius: 16,
    backgroundColor: "rgba(22,22,24,0.92)",
    alignItems: "center",
    justifyContent: "center",
    borderWidth: 1,
    borderColor: "rgba(255,255,255,0.12)",
    ...Platform.select({
      ios: { shadowColor: "#000", shadowOpacity: 0.3, shadowRadius: 5, shadowOffset: { width: 0, height: 2 } },
      android: { elevation: 5 },
    }),
  },
  compactTemp: { color: "#F4F4F4", fontSize: 18, fontWeight: "800", letterSpacing: -0.3, marginTop: 2 },
});
