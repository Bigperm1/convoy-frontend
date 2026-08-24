// GarageHeroCarousel — the Garage hero as a swipeable showroom.
//
// Jeff, 2026-08-23: "have the hero shot a carousel with the arrow and the
// classes and the 3d model with the according lock on the classes and 3D model.
// but visible to make users wanting to upgrade."
//
// That last clause is the whole design. A locked page is NOT hidden, greyed to
// mush, or replaced by an upsell card — you see the actual thing you would get,
// full size and moving, with the tier's H sitting on it. You cannot want what
// you cannot see. The lock states the price; the page does the selling.
//
// Swiping changes the PREVIEW only. Landing on a page you own selects it;
// landing on one you don't opens the paywall — but only on a deliberate tap,
// never on the swipe itself, or browsing would fire the paywall at every page.

import React, { useCallback, useEffect, useRef, useState } from "react";
import {
  Dimensions,
  NativeScrollEvent,
  NativeSyntheticEvent,
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
  type StyleProp,
  type ViewStyle,
} from "react-native";
import * as Haptics from "expo-haptics";
import { TierLock } from "./PremiumBadge";
import { skin, type VisualTier } from "./tierTheme";

const { width: SCREEN_W } = Dimensions.get("window");

export type HeroPage = {
  key: string;
  /** What the page shows — rendered full-bleed inside the hero box. */
  render: () => React.ReactNode;
  /** Short name under the dots, e.g. "Arrow" / "Class" / "Your car". */
  label: string;
  /** Locked pages still render their content; they just wear the H. */
  locked?: boolean;
  /** Which metal the lock and label wear. Untiered pages pass "brand". */
  tier: VisualTier;
};

export default function GarageHeroCarousel({
  pages,
  index,
  onIndexChange,
  onSelect,
  height,
  style,
}: {
  pages: HeroPage[];
  index: number;
  onIndexChange: (i: number) => void;
  /** Deliberate tap on a page — select it, or open the paywall if locked. */
  onSelect: (page: HeroPage) => void;
  height: number;
  style?: StyleProp<ViewStyle>;
}) {
  const ref = useRef<ScrollView>(null);
  const [w] = useState(SCREEN_W);
  const settling = useRef(false);

  // Follow an index change driven from OUTSIDE (the appearance tiles below).
  useEffect(() => {
    if (settling.current) return;
    ref.current?.scrollTo({ x: index * w, animated: true });
  }, [index, w]);

  const onMomentumEnd = useCallback(
    (e: NativeSyntheticEvent<NativeScrollEvent>) => {
      const i = Math.round(e.nativeEvent.contentOffset.x / w);
      settling.current = true;
      if (i !== index && pages[i]) {
        Haptics.selectionAsync();
        onIndexChange(i);
      }
      // Release on the next tick so our own scrollTo doesn't fight the settle.
      setTimeout(() => { settling.current = false; }, 0);
    },
    [index, onIndexChange, pages, w],
  );

  return (
    <View style={[{ height }, style]}>
      <ScrollView
        ref={ref}
        horizontal
        pagingEnabled
        showsHorizontalScrollIndicator={false}
        onMomentumScrollEnd={onMomentumEnd}
        // The 3D page hosts a WebView; see CarHero3D's `interactive` prop for
        // why it must be non-interactive in here or this pager cannot win a
        // horizontal drag.
        style={{ height }}
      >
        {pages.map((p) => (
          <TouchableOpacity
            key={p.key}
            activeOpacity={0.95}
            onPress={() => onSelect(p)}
            style={{ width: w, height }}
          >
            {p.render()}
            {p.locked && p.tier !== "brand" && (
              <View style={styles.lock} pointerEvents="none">
                <TierLock tier={p.tier} size={30} />
              </View>
            )}
          </TouchableOpacity>
        ))}
      </ScrollView>

      {/* dots + the current page's name, tinted by its tier */}
      <View style={styles.footer} pointerEvents="none">
        <View style={styles.dots}>
          {pages.map((p, i) => (
            <View
              key={p.key}
              style={[
                styles.dot,
                i === index && { backgroundColor: skin(pages[index].tier).accent, width: 16 },
              ]}
            />
          ))}
        </View>
        <Text style={[styles.label, { color: skin(pages[index].tier).accent }]}>
          {pages[index].label}
          {pages[index].locked ? `  ·  ${skin(pages[index].tier).label}` : ""}
        </Text>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  lock: { position: "absolute", top: 12, right: 14, zIndex: 6 },
  footer: {
    position: "absolute",
    left: 0,
    right: 0,
    bottom: 6,
    alignItems: "center",
    gap: 6,
  },
  dots: { flexDirection: "row", alignItems: "center", gap: 5 },
  dot: {
    width: 6,
    height: 6,
    borderRadius: 3,
    backgroundColor: "rgba(255,255,255,0.22)",
  },
  label: { fontSize: 11.5, fontWeight: "800", letterSpacing: 1.1 },
});
