// Convoy Onboarding — 3-slide first-launch tour.
//
// Flow: index.tsx checks AsyncStorage on mount; if `convoy:onboarded:v1` is
// unset and there is no logged-in user, redirect here. After the user taps
// "Let's Roll" on slide 3, we set the flag and route to /(auth)/login.
//
// Implementation: a horizontal FlatList with paging + a synced dot indicator.
// FlatList (rather than ViewPager/Animated) keeps gesture handling free for
// future enhancements like swipe-down-to-dismiss without fighting native
// pager behavior on iOS.

import React, { useRef, useState, useCallback } from "react";
import {
  View, Text, StyleSheet, FlatList, TouchableOpacity, useWindowDimensions,
  Platform, StatusBar,
} from "react-native";
import { useRouter } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { LinearGradient } from "expo-linear-gradient";
import { SafeAreaView } from "react-native-safe-area-context";

export const ONBOARDING_KEY = "convoy:onboarded:v1";

// Convoy gold accent. Hardcoded here (not pulled from COLORS) so the brand
// palette of the onboarding stays consistent even if the theme is later
// retuned for dark/light variants.
const GOLD = "#FFD60A";
const GOLD_DIM = "#C9A800";
const BG = "#0A0A0F";

type Slide = {
  icon: keyof typeof Ionicons.glyphMap;
  title: string;
  body: string;
};

const SLIDES: Slide[] = [
  {
    icon: "car-sport",
    title: "Drive Together",
    body: "See your convoy in real time. Every car, every hazard, every turn.",
  },
  {
    icon: "radio",
    title: "Talk Hands-Free",
    body: "Push-to-talk walkie-talkie built for the road. HD audio when your crew is close.",
  },
  {
    icon: "flag",
    title: "Own the Road",
    body: "Report hazards, share music, and convoy as one.",
  },
];

export default function Onboarding() {
  const router = useRouter();
  const listRef = useRef<FlatList<Slide>>(null);
  const [page, setPage] = useState(0);
  // useWindowDimensions auto-updates on rotation / resize so paging stays
  // perfectly synced. Dimensions.get('window') is a one-shot read at module
  // import time and was misaligning slides when the OS reported a different
  // viewport than what was cached at module load.
  const { width: SCREEN_W } = useWindowDimensions();

  const finish = useCallback(async () => {
    // Persist the flag BEFORE navigating so the index gate doesn't race-loop
    // back here on the next mount. AsyncStorage writes complete synchronously
    // enough that the next render reads the truth.
    try { await AsyncStorage.setItem(ONBOARDING_KEY, "1"); } catch {}
    router.replace("/(auth)/login");
  }, [router]);

  const skip = finish;
  const next = useCallback(() => {
    if (page < SLIDES.length - 1) {
      listRef.current?.scrollToIndex({ index: page + 1, animated: true });
    } else {
      finish();
    }
  }, [page, finish]);

  // FlatList paging emits scroll events at every pixel — we only care when a
  // page snaps into view, so we read currentlyViewableItems via onMomentumEnd.
  const onMomentumEnd = (e: any) => {
    const x = e.nativeEvent.contentOffset.x;
    const newPage = Math.round(x / SCREEN_W);
    if (newPage !== page) setPage(newPage);
  };

  return (
    <View style={styles.root}>
      {Platform.OS === "android" && <StatusBar barStyle="light-content" backgroundColor={BG} />}
      {/* Background radial glow — a faint gold halo behind the icon to make
          the slide feel premium without distracting from the copy. */}
      <View pointerEvents="none" style={styles.glowWrap}>
        <LinearGradient
          colors={["rgba(255,214,10,0.18)", "rgba(255,214,10,0.00)"]}
          style={styles.glow}
          start={{ x: 0.5, y: 0.35 }}
          end={{ x: 0.5, y: 1 }}
        />
      </View>

      <SafeAreaView edges={["top", "bottom"]} style={styles.safe}>
        {/* Top bar — Skip aligned right, mirrors iOS standards.
            Horizontal padding lives HERE (not on SafeAreaView) so the
            FlatList below can be edge-to-edge — that way page snapping uses
            the exact viewport width and slides land perfectly centered. */}
        <View style={styles.topBar}>
          <Text style={styles.brand}>CONVOY</Text>
          {page < SLIDES.length - 1 && (
            <TouchableOpacity onPress={skip} hitSlop={12} testID="onboarding-skip">
              <Text style={styles.skip}>Skip</Text>
            </TouchableOpacity>
          )}
        </View>

        <FlatList
          ref={listRef}
          data={SLIDES}
          horizontal
          pagingEnabled
          showsHorizontalScrollIndicator={false}
          onMomentumScrollEnd={onMomentumEnd}
          keyExtractor={(item, idx) => `${idx}-${item.title}`}
          // Items match SCREEN_W exactly — no fractional rounding errors.
          getItemLayout={(_, index) => ({ length: SCREEN_W, offset: SCREEN_W * index, index })}
          // FlatList sits flush against the screen edges so the page snap
          // distance equals the live SCREEN_W. The slide CONTENT is then
          // centered both axes by its own flex/justifyContent rules.
          style={styles.list}
          contentContainerStyle={{ alignItems: "stretch" }}
          renderItem={({ item, index }) => (
            <View style={[styles.slide, { width: SCREEN_W }]} testID={`onboarding-slide-${index}`}>
              <View style={styles.slideInner}>
                {/* Car-silhouette illustration — Ionicons stand-in for now;
                    upgrade to a custom SVG once we have brand artwork. */}
                <View style={styles.iconWrap}>
                  <View style={styles.iconRing} />
                  <View style={styles.iconCore}>
                    <Ionicons name={item.icon} size={72} color={GOLD} />
                  </View>
                </View>
                <Text style={styles.title}>{item.title}</Text>
                <Text style={styles.body}>{item.body}</Text>
              </View>
            </View>
          )}
        />

        {/* Dot indicator. */}
        <View style={[styles.dotsRow, styles.bottomGutter]}>
          {SLIDES.map((_, i) => (
            <View
              key={i}
              style={[
                styles.dot,
                i === page && styles.dotActive,
              ]}
            />
          ))}
        </View>

        <View style={styles.bottomGutter}>
          <TouchableOpacity
            style={styles.cta}
            onPress={next}
            activeOpacity={0.85}
            testID="onboarding-next"
          >
            <LinearGradient
              colors={[GOLD, GOLD_DIM]}
              start={{ x: 0, y: 0 }} end={{ x: 1, y: 1 }}
              style={StyleSheet.absoluteFill}
            />
            <Text style={styles.ctaText}>
              {page < SLIDES.length - 1 ? "Continue" : "Let's Roll  →"}
            </Text>
          </TouchableOpacity>
        </View>
      </SafeAreaView>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: BG },
  glowWrap: { ...StyleSheet.absoluteFillObject, alignItems: "center" },
  glow: {
    position: "absolute",
    top: -200,
    width: 700,
    height: 700,
    borderRadius: 350,
  },
  // SafeAreaView is full-bleed (no horizontal padding) so the FlatList can
  // hit screen edges and pagingEnabled snaps cleanly.
  safe: { flex: 1 },
  topBar: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingTop: 8,
    paddingBottom: 12,
    paddingHorizontal: 24,
  },
  brand: {
    color: GOLD,
    fontSize: 16,
    fontWeight: "800",
    letterSpacing: 4,
  },
  skip: {
    color: "rgba(255,255,255,0.55)",
    fontSize: 14,
    fontWeight: "600",
    letterSpacing: 0.3,
  },

  // FlatList sits flush with screen edges; vertical flex is what shrinks
  // around the topBar / dots / CTA. `flexGrow: 0` is critical otherwise
  // RN tries to give the list infinite height inside flexbox.
  list: { flexGrow: 0, flexShrink: 1, alignSelf: "stretch" },

  // Each slide is exactly viewport-wide and centers its inner content.
  slide: {
    alignItems: "center",
    justifyContent: "center",
  },
  // Inner padded card — keeps copy from kissing the edges, while the OUTER
  // slide stays SCREEN_W exactly so paging arithmetic is bulletproof.
  slideInner: {
    paddingHorizontal: 32,
    alignItems: "center",
    justifyContent: "center",
  },
  iconWrap: {
    width: 220,
    height: 220,
    alignItems: "center",
    justifyContent: "center",
    marginBottom: 40,
  },
  iconRing: {
    position: "absolute",
    width: 220,
    height: 220,
    borderRadius: 110,
    borderWidth: 1,
    borderColor: "rgba(255,214,10,0.20)",
  },
  iconCore: {
    width: 140,
    height: 140,
    borderRadius: 70,
    backgroundColor: "rgba(255,214,10,0.08)",
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: "rgba(255,214,10,0.40)",
    alignItems: "center",
    justifyContent: "center",
  },
  title: {
    color: "#FFFFFF",
    fontSize: 32,
    fontWeight: "800",
    letterSpacing: -0.6,
    textAlign: "center",
    marginBottom: 16,
  },
  body: {
    color: "rgba(255,255,255,0.72)",
    fontSize: 16,
    lineHeight: 24,
    textAlign: "center",
    maxWidth: 320,
    fontWeight: "500",
  },

  bottomGutter: { paddingHorizontal: 24 },
  dotsRow: {
    flexDirection: "row",
    justifyContent: "center",
    gap: 8,
    marginTop: 12,
    marginBottom: 20,
  },
  dot: {
    width: 8, height: 8, borderRadius: 4,
    backgroundColor: "rgba(255,255,255,0.18)",
  },
  dotActive: {
    backgroundColor: GOLD,
    width: 24,
  },

  cta: {
    height: 56,
    borderRadius: 16,
    overflow: "hidden",
    alignItems: "center",
    justifyContent: "center",
    marginBottom: 12,
    ...Platform.select({
      ios: { shadowColor: GOLD, shadowOpacity: 0.32, shadowRadius: 18, shadowOffset: { width: 0, height: 6 } },
      android: { elevation: 8 },
      web: { boxShadow: "0 6px 18px rgba(255,214,10,0.32)" } as any,
    }),
  },
  ctaText: {
    color: "#0A0A0F",
    fontSize: 17,
    fontWeight: "800",
    letterSpacing: 0.4,
  },
});
