// The Showroom — one swipeable surface for the whole appearance ladder.
// Arrow (free) → the class archetypes (premium) → Your Car (ULTRA).
//
// STAGED (Jeff approved the concept 8/20 evening): registered href:null,
// linked from nowhere. This replaces the garage's flat class grid once the
// remaining class bakes land and it passes Jeff's device review. Selection is
// LOCAL state only until the class-3D map rendering exists — wiring the picks
// into settings ships with that work.
//
// Design: full-width hero cards, snap paging with scale/fade depth, palette
// dots that swap the hero live, the Ultra card closing the lineup so every
// colour-change swipe walks past it. Locked cards wear the badge; the locked
// Ultra card opens the Apple-esque Garage Scan pitch.

import React, { useMemo, useRef, useState } from "react";
import {
  Animated,
  Dimensions,
  SafeAreaView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from "react-native";
import { Image } from "expo-image";
import { useRouter } from "expo-router";
import { LinearGradient } from "expo-linear-gradient";
import { Ionicons } from "@expo/vector-icons";
import * as Haptics from "expo-haptics";
import { COLORS } from "../../src/theme";
import { PremiumBadge, useFeature, openPaywall } from "../../src/PremiumBadge";
import { CLASS_MODEL_3D, ICONIC_PALETTE, type ClassPaletteEntry } from "../../src/classModels";

const { width: SCREEN_W } = Dimensions.get("window");
const CARD_W = Math.round(SCREEN_W * 0.82);
const CARD_GUTTER = 10;
const SNAP = CARD_W + CARD_GUTTER * 2;
const SIDE_PAD = (SCREEN_W - CARD_W) / 2 - CARD_GUTTER;

// Per-colour hero art. Authored classes use their real per-colour renders;
// Muscle uses the tint-rendered set (same math as the live map tint).
const HEROES: Record<string, Record<string, any>> = {
  hatchback: {
    "Heavy Metal": require("../../assets/cars/gr_corolla/heavy_metal.jpg"),
    "Supersonic Red": require("../../assets/cars/gr_corolla/supersonic_red.jpg"),
    "Icecap White": require("../../assets/cars/gr_corolla/icecap_white.jpg"),
    "Blue Flame": require("../../assets/cars/gr_corolla/blue_flame.jpg"),
    "Black Onyx": require("../../assets/cars/gr_corolla/black_onyx.jpg"),
    Gravel: require("../../assets/cars/gr_corolla/gravel_grmn27.jpg"),
  },
  supercar: {
    "Guards Red": require("../../assets/cars/gt3rs/guards_red.jpg"),
    "GT Silver": require("../../assets/cars/gt3rs/gt_silver.jpg"),
    "Carrara White": require("../../assets/cars/gt3rs/carrara_white.jpg"),
    "Jet Black": require("../../assets/cars/gt3rs/jet_black.jpg"),
    "Miami Blue": require("../../assets/cars/gt3rs/miami_blue.jpg"),
    "Python Green": require("../../assets/cars/gt3rs/python_green.jpg"),
    "Shark Blue": require("../../assets/cars/gt3rs/shark_blue.jpg"),
  },
  exotic: {
    "Whitest White": require("../../assets/cars/lfa/whitest_white.jpg"),
    "Absolutely Red": require("../../assets/cars/lfa/absolutely_red.jpg"),
    "Pearl Yellow": require("../../assets/cars/lfa/pearl_yellow.jpg"),
    "Pearl Blue": require("../../assets/cars/lfa/pearl_blue.jpg"),
    "Matte Black": require("../../assets/cars/lfa/matte_black.jpg"),
  },
  muscle: {
    "Nardo Grey": require("../../assets/cars/classes/muscle_nardo_grey.jpg"),
    "Rosso Corsa": require("../../assets/cars/classes/muscle_rosso_corsa.jpg"),
    "Giallo Modena": require("../../assets/cars/classes/muscle_giallo_modena.jpg"),
    "Verde Mantis": require("../../assets/cars/classes/muscle_verde_mantis.jpg"),
    "Bayside Blue": require("../../assets/cars/classes/muscle_bayside_blue.jpg"),
    "Midnight Purple": require("../../assets/cars/classes/muscle_midnight_purple.jpg"),
    "British Racing Green": require("../../assets/cars/classes/muscle_brg.jpg"),
    "Championship White": require("../../assets/cars/classes/muscle_championship_white.jpg"),
    "Arancio Borealis": require("../../assets/cars/classes/muscle_arancio.jpg"),
    "Shadow Black": require("../../assets/cars/classes/muscle_shadow_black.jpg"),
  },
};

type Card =
  | { kind: "arrow"; title: string; sub: string }
  | { kind: "class"; classKey: string; title: string; sub: string; palette: ClassPaletteEntry[] }
  | { kind: "soon"; title: string; sub: string }
  | { kind: "ultra"; title: string; sub: string };

const CARDS: Card[] = [
  { kind: "arrow", title: "Arrow", sub: "The classic. Always free." },
  { kind: "class", classKey: "hatchback", title: "Hot Hatch", sub: "GR Corolla", palette: CLASS_MODEL_3D.hatchback!.palette },
  { kind: "class", classKey: "muscle", title: "Muscle", sub: "V8 coupe", palette: ICONIC_PALETTE },
  { kind: "class", classKey: "supercar", title: "Supercar", sub: "911 GT3 RS", palette: CLASS_MODEL_3D.supercar!.palette },
  { kind: "class", classKey: "exotic", title: "Exotic", sub: "LFA", palette: CLASS_MODEL_3D.exotic!.palette },
  { kind: "soon", title: "Sedan", sub: "In the paint booth" },
  { kind: "soon", title: "Electric", sub: "In the paint booth" },
  { kind: "soon", title: "Truck", sub: "In the paint booth" },
  { kind: "soon", title: "Jeep", sub: "In the paint booth" },
  { kind: "ultra", title: "Your Car", sub: "The one in your driveway" },
];

export default function Showroom() {
  const router = useRouter();
  const scrollX = useRef(new Animated.Value(0)).current;
  const classUnlocked = useFeature("class_marker");
  const ultraUnlocked = useFeature("car_3d");
  // colour selection per class card, by palette name
  const [picks, setPicks] = useState<Record<string, string>>({});

  const pickColor = (classKey: string, name: string) => {
    Haptics.selectionAsync();
    setPicks((p) => ({ ...p, [classKey]: name }));
  };

  const renderCard = (card: Card, i: number) => {
    const inputRange = [(i - 1) * SNAP, i * SNAP, (i + 1) * SNAP];
    const scale = scrollX.interpolate({ inputRange, outputRange: [0.92, 1, 0.92], extrapolate: "clamp" });
    const opacity = scrollX.interpolate({ inputRange, outputRange: [0.55, 1, 0.55], extrapolate: "clamp" });

    let body: React.ReactNode = null;
    let locked = false;
    let onLockedPress: (() => void) | undefined;

    if (card.kind === "arrow") {
      body = (
        <View style={styles.arrowStage}>
          <Ionicons name="navigate" size={96} color={COLORS.brand} style={{ transform: [{ rotate: "45deg" }] }} />
        </View>
      );
    } else if (card.kind === "class") {
      locked = !classUnlocked;
      onLockedPress = () => openPaywall("class_marker");
      const palette = card.palette;
      const picked = picks[card.classKey] ?? palette[0].name;
      const hero = HEROES[card.classKey]?.[picked] ?? Object.values(HEROES[card.classKey] ?? {})[0];
      body = (
        <>
          <Image source={hero} style={styles.hero} contentFit="cover" transition={220} />
          <View style={styles.dots}>
            {palette.map((c) => (
              <TouchableOpacity
                key={c.name}
                onPress={() => (locked ? onLockedPress?.() : pickColor(card.classKey, c.name))}
                hitSlop={6}
                style={[styles.dot, { backgroundColor: c.hex }, picked === c.name && styles.dotOn]}
              />
            ))}
          </View>
          <Text style={styles.colorName}>{picked}</Text>
        </>
      );
    } else if (card.kind === "soon") {
      body = (
        <View style={styles.arrowStage}>
          <Ionicons name="construct" size={54} color={COLORS.textDim} />
        </View>
      );
    } else {
      // ultra
      locked = !ultraUnlocked;
      onLockedPress = () => router.push("/(app)/garage-scan" as any);
      body = (
        <View style={styles.arrowStage}>
          <LinearGradient
            colors={["rgba(45,236,134,0.22)", "rgba(45,236,134,0.02)"]}
            style={styles.ultraGlow}
          />
          <Ionicons name="scan" size={64} color={COLORS.brand} />
          <Text style={styles.ultraLine}>Authored for your exact make, model and colour — or scanned from your driveway.</Text>
        </View>
      );
    }

    return (
      <Animated.View key={card.title} style={[styles.card, { transform: [{ scale }], opacity }]}>
        <TouchableOpacity
          activeOpacity={0.92}
          disabled={!locked && card.kind !== "ultra"}
          onPress={() => {
            if (locked) onLockedPress?.();
            else if (card.kind === "ultra") router.push("/(app)/garage" as any);
          }}
          style={{ flex: 1 }}
        >
          <LinearGradient
            colors={card.kind === "ultra" ? ["#12241B", "#0B0F0D"] : ["#17181C", "#0D0E11"]}
            style={styles.cardInner}
          >
            {locked && (
              <View style={styles.badge}>
                <PremiumBadge size="sm" />
              </View>
            )}
            {body}
            <View style={styles.cardFooter}>
              <Text style={styles.cardTitle}>{card.title}</Text>
              <Text style={styles.cardSub}>{card.sub}</Text>
            </View>
          </LinearGradient>
        </TouchableOpacity>
      </Animated.View>
    );
  };

  const cards = useMemo(() => CARDS, []);

  return (
    <SafeAreaView style={styles.safe}>
      <View style={styles.headerRow}>
        <TouchableOpacity onPress={() => router.back()} hitSlop={10} style={styles.backBtn}>
          <Ionicons name="chevron-back" size={24} color={COLORS.text} />
        </TouchableOpacity>
        <Text style={styles.screenTitle}>Showroom</Text>
        <View style={styles.backBtn} />
      </View>

      <Animated.ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        snapToInterval={SNAP}
        decelerationRate="fast"
        contentContainerStyle={{ paddingHorizontal: SIDE_PAD, alignItems: "center" }}
        onScroll={Animated.event([{ nativeEvent: { contentOffset: { x: scrollX } } }], { useNativeDriver: true })}
        scrollEventThrottle={16}
        onMomentumScrollEnd={() => Haptics.selectionAsync()}
        style={{ flexGrow: 0 }}
      >
        {cards.map(renderCard)}
      </Animated.ScrollView>

      <Text style={styles.hint}>Swipe the lineup · tap a colour</Text>
    </SafeAreaView>
  );
}

const CARD_H = Math.round(CARD_W * 1.18);

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: COLORS.bg, justifyContent: "center" },
  headerRow: {
    position: "absolute",
    top: 54,
    left: 0,
    right: 0,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: 16,
  },
  backBtn: { width: 40, height: 40, justifyContent: "center" },
  screenTitle: { color: COLORS.text, fontSize: 17, fontWeight: "700" },

  card: { width: CARD_W, height: CARD_H, marginHorizontal: CARD_GUTTER },
  cardInner: {
    flex: 1,
    borderRadius: 26,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: COLORS.hairlineStrong,
    overflow: "hidden",
    justifyContent: "flex-start",
  },
  badge: { position: "absolute", top: 14, right: 14, zIndex: 5 },

  hero: { width: "100%", height: CARD_H * 0.56 },
  dots: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 10,
    justifyContent: "center",
    paddingHorizontal: 18,
    marginTop: 16,
  },
  dot: {
    width: 24,
    height: 24,
    borderRadius: 12,
    borderWidth: 2,
    borderColor: "rgba(255,255,255,0.18)",
  },
  dotOn: { borderColor: COLORS.brand, transform: [{ scale: 1.15 }] },
  colorName: { color: COLORS.textDim, fontSize: 12.5, textAlign: "center", marginTop: 10 },

  arrowStage: { height: CARD_H * 0.62, alignItems: "center", justifyContent: "center", gap: 14 },
  ultraGlow: { ...StyleSheet.absoluteFillObject },
  ultraLine: { color: COLORS.textDim, fontSize: 13, textAlign: "center", paddingHorizontal: 28, lineHeight: 19 },

  cardFooter: { position: "absolute", left: 20, bottom: 18 },
  cardTitle: { color: COLORS.text, fontSize: 22, fontWeight: "800" },
  cardSub: { color: COLORS.textDim, fontSize: 13, marginTop: 1 },

  hint: { color: COLORS.textMute, fontSize: 12, textAlign: "center", marginTop: 18 },
});
