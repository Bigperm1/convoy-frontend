// ⚠ TEMPORARY PREVIEW SCREEN — delete after Jeff picks a Hub direction.
// Static mock data, no network. Exists only so the concepts can be judged as real
// screens on the simulator instead of a browser mockup (Jeff's standing rule).
import React, { useState } from "react";
import { View, Text, ScrollView, StyleSheet, TouchableOpacity, Image, Platform } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { Ionicons, MaterialCommunityIcons } from "@expo/vector-icons";
import { LinearGradient } from "expo-linear-gradient";
import { router } from "expo-router";
import { COLORS } from "../../src/theme";
import { useAccent, useAccentAlpha, useAppSkinColors, useAppSkin } from "../../src/appSkin";
import { CandyCta } from "../../src/components/CandyCta";

const CAR = require("../../assets/vehicles/v3/heavy_metal.png");
const BANNER = require("../../assets/cars/classes/muscle_grabber_blue.jpg");

/* ── mock data ─────────────────────────────────────────────── */
const NEXT = { title: "Sea to Sky Cruise", when: "SATURDAY · 9:00 AM", where: "Meet: Park & Ride, Horseshoe Bay", going: 12, kind: "cruise" as const };
const FEED = [
  { kind: "cruise" as const, title: "Sea to Sky Cruise", when: "Sat · 9:00 AM", where: "Horseshoe Bay", n: 12, going: true },
  { kind: "meet" as const, title: "Cars & Coffee", when: "Sun · 8:30 AM", where: "Blue Chip, Deep Cove", n: 31, going: false },
  { kind: "cruise" as const, title: "Fraser Valley Run", when: "Sep 4 · 10:00 AM", where: "Fort Langley", n: 7, going: false },
  { kind: "meet" as const, title: "Track Day — Mission", when: "Sep 12 · 7:00 AM", where: "Mission Raceway", n: 18, going: true },
];
const CLUBS = [{ name: "YVRGRC", n: 9, active: true }, { name: "Track Rats", n: 42, active: false }];

/* ── shared bits ───────────────────────────────────────────── */
function DriverBand({ accent }: { accent: string }) {
  return (
    <TouchableOpacity style={s.band} activeOpacity={0.85}>
      <Image source={CAR} style={s.bandCar} resizeMode="contain" />
      <View style={{ flex: 1 }}>
        <Text style={s.bandName}>Jeff</Text>
        <Text style={[s.bandCarTxt, { color: accent }]}>2025 Toyota GR Corolla</Text>
      </View>
      <Ionicons name="chevron-forward" size={20} color="#5A5A5E" />
    </TouchableOpacity>
  );
}

function RouteGlyph({ color, kind }: { color: string; kind: "cruise" | "meet" }) {
  // kind is the card's SHAPE, not a tab: a cruise draws a route, a meet draws a place.
  return (
    <View style={s.glyphWell}>
      {kind === "cruise" ? (
        <MaterialCommunityIcons name="map-marker-path" size={22} color={color} />
      ) : (
        <MaterialCommunityIcons name="map-marker-radius" size={22} color={color} />
      )}
    </View>
  );
}

/* ── CONCEPT A — "Roll Call" ───────────────────────────────── */
function ConceptA() {
  const tier = useAppSkin();
  const accent = useAccent();
  const well = useAccentAlpha(0.14);
  const hair = useAccentAlpha(0.35);
  const sk = useAppSkinColors();
  const [chip, setChip] = useState("All");
  const chips = ["Going", "All", "Meets", "Cruises", "Clubs"];
  return (
    <>
      <DriverBand accent={accent} />

      {/* NEXT UP — the only large coloured object; answers "what's on" with zero taps */}
      <View style={s.hero}>
        {/* No banner is the COMMON case, so the default hero is the skin itself:
            a metal wash + the kind's own glyph, not a grey hole. */}
        <LinearGradient colors={[useAccentAlpha(0.30), useAccentAlpha(0.10), "rgba(0,0,0,0.96)"]}
          start={{ x: 0, y: 0 }} end={{ x: 0.9, y: 1 }} style={StyleSheet.absoluteFill} />
        <MaterialCommunityIcons name="map-marker-path" size={190} color={useAccentAlpha(0.10)}
          style={{ position: "absolute", right: -34, top: -14 }} />
        <View style={[s.countdown, { backgroundColor: accent }]}>
          <Text style={s.countdownTxt}>{NEXT.when}</Text>
        </View>
        <View style={s.heroFoot}>
          <Text style={s.heroTitle}>{NEXT.title}</Text>
          <Text style={s.heroSub}>{NEXT.where}</Text>
          <View style={s.heroRow}>
            <View style={s.avatars}>
              {[0, 1, 2].map((i) => (
                <Image key={i} source={CAR} style={[s.avatar, { marginLeft: i ? -10 : 0 }]} resizeMode="contain" />
              ))}
            </View>
            <Text style={s.heroGoing}>{NEXT.going} going</Text>
            <View style={{ flex: 1 }} />
            <CandyCta label="I'm in" icon="checkmark" tier={tier} height={40} style={{ width: 116 }} />
          </View>
        </View>
      </View>

      {/* YOUR CLUBS — a rail, so one club reads deliberate not lonely */}
      <Text style={s.label}>YOUR CLUBS</Text>
      <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={s.rail}>
        {CLUBS.map((c) => (
          <View key={c.name} style={s.clubChip}>
            <View style={[s.crest, { backgroundColor: well, borderColor: c.active ? accent : "transparent" }]}>
              <MaterialCommunityIcons name="shield-star" size={26} color={accent} />
            </View>
            <Text style={s.clubName} numberOfLines={1}>{c.name}</Text>
            <Text style={s.clubN}>{c.n}</Text>
          </View>
        ))}
        <View style={s.clubChip}>
          <View style={[s.crest, { borderColor: "rgba(255,255,255,0.18)", borderStyle: "dashed" }]}>
            <Ionicons name="search" size={22} color="#7A7A7E" />
          </View>
          <Text style={s.clubName}>Find</Text>
        </View>
      </ScrollView>

      {/* ONE chip rail replaces BOTH old nav rows */}
      <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={s.chipRail}>
        {chips.map((c) => {
          const on = c === chip;
          return (
            <TouchableOpacity key={c} onPress={() => setChip(c)} activeOpacity={0.85}
              style={[s.chip, on ? { backgroundColor: accent, borderColor: accent } : null]}>
              <Text style={[s.chipTxt, on && { color: sk.ink, fontWeight: "800" }]}>{c}</Text>
            </TouchableOpacity>
          );
        })}
      </ScrollView>

      {/* ONE time-ordered sheet — meets and cruises interleaved */}
      <View style={s.sheet}>
        {FEED.map((e, i) => (
          <View key={e.title} style={[s.row, i > 0 ? { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: "rgba(255,255,255,0.08)" } : null]}>
            <RouteGlyph color={accent} kind={e.kind} />
            <View style={{ flex: 1 }}>
              <Text style={s.rowTitle} numberOfLines={1}>{e.title}</Text>
              <Text style={s.rowSub} numberOfLines={1}>
                <Text style={{ color: accent, fontWeight: "700" }}>{e.when}</Text>
                <Text>{"  ·  " + e.where}</Text>
              </Text>
            </View>
            {e.going
              ? <View style={[s.goingPill, { backgroundColor: well, borderColor: hair }]}><Text style={[s.goingTxt, { color: accent }]}>GOING</Text></View>
              : <View style={s.countWell}><Text style={s.countTxt}>{e.n}</Text></View>}
          </View>
        ))}
      </View>
      <View style={{ height: 90 }} />
    </>
  );
}

/* ── CONCEPT B — "The Clubhouse" ───────────────────────────── */
function ConceptB() {
  const tier = useAppSkin();
  const accent = useAccent();
  const well = useAccentAlpha(0.14);
  return (
    <>
      {/* Club marquee — the club is the screen, not a row in a directory */}
      <View style={s.marquee}>
        <Image source={BANNER} style={StyleSheet.absoluteFill as any} resizeMode="cover" />
        <LinearGradient colors={["rgba(0,0,0,0.25)", "rgba(0,0,0,0.9)"]} style={StyleSheet.absoluteFill} />
        <View style={s.marqueeFoot}>
          <View style={[s.crestBig, { borderColor: accent }]}>
            <MaterialCommunityIcons name="shield-star" size={30} color={accent} />
          </View>
          <View style={{ flex: 1 }}>
            <Text style={s.clubTitle}>YVRGRC</Text>
            <Text style={s.clubMeta}>9 members · Vancouver</Text>
          </View>
          <TouchableOpacity style={[s.switcher, { borderColor: accent }]}>
            <Ionicons name="swap-horizontal" size={16} color={accent} />
          </TouchableOpacity>
        </View>
      </View>

      <Text style={s.label}>THIS WEEKEND</Text>
      <View style={s.sheet}>
        {FEED.slice(0, 2).map((e, i) => (
          <View key={e.title} style={[s.row, i > 0 ? { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: "rgba(255,255,255,0.08)" } : null]}>
            <RouteGlyph color={accent} kind={e.kind} />
            <View style={{ flex: 1 }}>
              <Text style={s.rowTitle}>{e.title}</Text>
              <Text style={s.rowSub}><Text style={{ color: accent, fontWeight: "700" }}>{e.when}</Text><Text>{"  ·  " + e.where}</Text></Text>
            </View>
            <CandyCta label="Join" tier={tier} height={34} style={{ width: 76 }} />
          </View>
        ))}
      </View>

      {/* Standings — structurally cannot be empty: every member seeded */}
      <Text style={s.label}>STANDINGS</Text>
      <View style={s.sheet}>
        {[["Jeff", "188.5"], ["Enablewhore", "171.0"], ["Rodrigo", "164.2"]].map(([n, v], i) => (
          <View key={n} style={[s.row, i > 0 ? { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: "rgba(255,255,255,0.08)" } : null]}>
            <View style={[s.rank, { backgroundColor: i === 0 ? accent : "rgba(255,255,255,0.08)" }]}>
              <Text style={[s.rankTxt, i === 0 && { color: "#1A1206" }]}>{i + 1}</Text>
            </View>
            <Image source={CAR} style={s.rosterCar} resizeMode="contain" />
            <Text style={[s.rowTitle, { flex: 1 }]}>{n}</Text>
            <Text style={[s.pb, { color: accent }]}>{v}<Text style={s.pbUnit}> km/h</Text></Text>
          </View>
        ))}
      </View>

      <Text style={s.label}>MEMBERS</Text>
      <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={s.rail}>
        {["Jeff", "Olaf", "Rodrigo", "Say Phin", "Ni GR"].map((n) => (
          <View key={n} style={s.clubChip}>
            <View style={[s.crest, { backgroundColor: well }]}><Image source={CAR} style={s.memberCar} resizeMode="contain" /></View>
            <Text style={s.clubName} numberOfLines={1}>{n}</Text>
          </View>
        ))}
      </ScrollView>
      <View style={{ height: 90 }} />
    </>
  );
}

export default function HubPreview() {
  const [v, setV] = useState<"A" | "B">("A");
  const accent = useAccent();
  const sk = useAppSkinColors();
  return (
    <SafeAreaView style={s.safe}>
      <View style={s.top}>
        <TouchableOpacity onPress={() => router.back()} hitSlop={12}><Ionicons name="chevron-back" size={26} color="#EDEDED" /></TouchableOpacity>
        <Text style={s.h1}>Hub</Text>
        <View style={{ flex: 1 }} />
        {(["A", "B"] as const).map((k) => (
          <TouchableOpacity key={k} onPress={() => setV(k)}
            style={[s.ab, v === k && { backgroundColor: accent, borderColor: accent }]}>
            <Text style={[s.abTxt, v === k && { color: sk.ink }]}>{k}</Text>
          </TouchableOpacity>
        ))}
      </View>
      <ScrollView contentContainerStyle={s.scroll} showsVerticalScrollIndicator={false}>
        {v === "A" ? <ConceptA /> : <ConceptB />}
      </ScrollView>
      {/* Create is a FAB, not a permanent full-width row */}
      <TouchableOpacity style={s.fab} activeOpacity={0.9}>
        <LinearGradient colors={sk.colors as any} locations={sk.locations as any} style={StyleSheet.absoluteFill as any} />
        <Ionicons name="add" size={30} color={sk.ink} />
      </TouchableOpacity>
    </SafeAreaView>
  );
}

const s = StyleSheet.create({
  safe: { flex: 1, backgroundColor: COLORS.bg },
  top: { flexDirection: "row", alignItems: "center", gap: 10, paddingHorizontal: 16, paddingBottom: 6 },
  h1: { color: "#fff", fontSize: 30, fontWeight: "800", letterSpacing: -0.5 },
  ab: { width: 34, height: 30, borderRadius: 9, borderWidth: 1, borderColor: "#2A2A2A", alignItems: "center", justifyContent: "center" },
  abTxt: { color: "#9A9A9E", fontWeight: "800", fontSize: 13 },
  scroll: { paddingHorizontal: 16, paddingTop: 4 },

  band: { flexDirection: "row", alignItems: "center", gap: 12, paddingVertical: 10, marginBottom: 12 },
  bandCar: { width: 52, height: 40 },
  bandName: { color: "#fff", fontSize: 19, fontWeight: "800" },
  bandCarTxt: { fontSize: 12.5, fontWeight: "600", marginTop: 1 },

  hero: { height: 208, borderRadius: 22, overflow: "hidden", justifyContent: "flex-end", marginBottom: 20 },
  countdown: { position: "absolute", top: 12, left: 12, paddingHorizontal: 10, paddingVertical: 5, borderRadius: 8 },
  countdownTxt: { color: "#1A1206", fontSize: 11, fontWeight: "900", letterSpacing: 0.5 },
  heroFoot: { padding: 14 },
  heroTitle: { color: "#fff", fontSize: 21, fontWeight: "800" },
  heroSub: { color: "#C7C7CC", fontSize: 12.5, marginTop: 2 },
  heroRow: { flexDirection: "row", alignItems: "center", gap: 10, marginTop: 12 },
  avatars: { flexDirection: "row" },
  avatar: { width: 26, height: 22 },
  heroGoing: { color: "#C7C7CC", fontSize: 12, fontWeight: "600" },

  label: { color: "#7A7A7E", fontSize: 11, fontWeight: "700", letterSpacing: 1.1, marginBottom: 10 },
  rail: { gap: 14, paddingBottom: 20 },
  clubChip: { alignItems: "center", width: 64 },
  crest: { width: 56, height: 56, borderRadius: 18, alignItems: "center", justifyContent: "center", borderWidth: 2, borderColor: "transparent", backgroundColor: "rgba(255,255,255,0.06)" },
  clubName: { color: "#EDEDED", fontSize: 11, fontWeight: "700", marginTop: 6 },
  clubN: { color: "#7A7A7E", fontSize: 10 },
  memberCar: { width: 34, height: 26 },

  chipRail: { gap: 8, paddingBottom: 14 },
  chip: { paddingHorizontal: 15, paddingVertical: 9, borderRadius: 999, borderWidth: 1, borderColor: "rgba(255,255,255,0.12)", backgroundColor: "rgba(255,255,255,0.06)" },
  chipTxt: { color: "#C7C7CC", fontSize: 13.5, fontWeight: "600" },

  sheet: { backgroundColor: "rgba(20,20,22,0.92)", borderRadius: 20, borderWidth: StyleSheet.hairlineWidth, borderColor: "rgba(255,255,255,0.1)", overflow: "hidden", marginBottom: 22 },
  row: { flexDirection: "row", alignItems: "center", gap: 12, paddingHorizontal: 14, paddingVertical: 13 },
  glyphWell: { width: 42, height: 42, borderRadius: 13, backgroundColor: "rgba(255,255,255,0.06)", alignItems: "center", justifyContent: "center" },
  rowTitle: { color: "#fff", fontSize: 15, fontWeight: "700" },
  rowSub: { color: "#8A8A8E", fontSize: 12, marginTop: 2 },
  goingPill: { paddingHorizontal: 9, paddingVertical: 4, borderRadius: 7, borderWidth: StyleSheet.hairlineWidth },
  goingTxt: { fontSize: 10, fontWeight: "900", letterSpacing: 0.4 },
  countWell: { minWidth: 30, height: 26, borderRadius: 8, backgroundColor: "rgba(255,255,255,0.07)", alignItems: "center", justifyContent: "center", paddingHorizontal: 7 },
  countTxt: { color: "#C7C7CC", fontSize: 12, fontWeight: "700" },

  marquee: { height: 172, borderRadius: 22, overflow: "hidden", justifyContent: "flex-end", marginBottom: 20 },
  marqueeFoot: { flexDirection: "row", alignItems: "center", gap: 12, padding: 14 },
  crestBig: { width: 54, height: 54, borderRadius: 17, borderWidth: 2, alignItems: "center", justifyContent: "center", backgroundColor: "rgba(0,0,0,0.45)" },
  clubTitle: { color: "#fff", fontSize: 23, fontWeight: "800" },
  clubMeta: { color: "#C7C7CC", fontSize: 12.5, marginTop: 1 },
  switcher: { width: 38, height: 38, borderRadius: 12, borderWidth: 1, alignItems: "center", justifyContent: "center" },
  rank: { width: 24, height: 24, borderRadius: 8, alignItems: "center", justifyContent: "center" },
  rankTxt: { color: "#C7C7CC", fontSize: 12, fontWeight: "800" },
  rosterCar: { width: 40, height: 30 },
  pb: { fontSize: 17, fontWeight: "800" },
  pbUnit: { fontSize: 10, color: "#8A8A8E", fontWeight: "600" },

  fab: { position: "absolute", right: 18, bottom: 26, width: 58, height: 58, borderRadius: 29, overflow: "hidden", alignItems: "center", justifyContent: "center",
    ...Platform.select({ ios: { shadowColor: "#000", shadowOpacity: 0.5, shadowRadius: 12, shadowOffset: { width: 0, height: 6 } }, android: { elevation: 8 } }) },
});
