// WeatherHUD — compact on-map weather chip shown when the weather layer is on.
// Displays current temperature, conditions icon, wind and precip at a glance.
import React from "react";
import { View, Text, StyleSheet, Platform } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import type { WeatherCondition } from "../weatherLayer";
import { weatherIconName, windDirectionLabel } from "../weatherLayer";

type Props = {
  weather: WeatherCondition;
  unit: 'kmh' | 'mph';
};

export default function WeatherHUD({ weather, unit }: Props) {
  const temp = unit === 'mph'
    ? `${Math.round(weather.tempF)}°F`
    : `${Math.round(weather.tempC)}°C`;
  const wind = unit === 'mph'
    ? `${Math.round(weather.windSpeedMph)} mph ${windDirectionLabel(weather.windDirectionDeg)}`
    : `${Math.round(weather.windSpeedKph)} km/h ${windDirectionLabel(weather.windDirectionDeg)}`;

  return (
    <View style={styles.chip}>
      <Ionicons name={weatherIconName(weather)} size={18} color="#FFD60A" />
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
  temp: { color: "#fff", fontSize: 15, fontWeight: "700" },
  wind: { color: "rgba(255,255,255,0.6)", fontSize: 11, fontWeight: "500" },
  precip: { color: "#5AC8FA", fontSize: 11, fontWeight: "600" },
  divider: { width: StyleSheet.hairlineWidth, height: 16, backgroundColor: "rgba(255,255,255,0.15)", marginHorizontal: 2 },
});
