// src/CarDriveList.tsx
//
// The phone's face while a HEAD UNIT is navigating (Jeff, 2026-08-16: "when the
// carplay route is connected the phone switches to turn by turn written directions
// in sequential order"). Rendered by map.tsx INSTEAD of ConvoyMapbox whenever
// CarPlay/AA is attached and turn-by-turn is active — the map is on the car screen,
// so the phone showing a second live map buys nothing and costs half the measured
// heat load: unmounting the phone's Mapbox instance kills one of the two ~60 Hz
// camera pumps AND the entire second GL engine (heat probe, 2026-08-15: ~115
// setCamera/s from exactly two per-instance rAF loops).
//
// Deliberately DUMB: no map, no GL, no per-frame animation. Everything live in it
// (current step, distances, ETA) re-renders off the same tbt/coords ticks map.tsx
// already has. The only timer is the 5s manual-scroll hold below (Jeff, 2026-08-19:
// "you can manually scroll it too but it always snaps back to the next turn at the
// top") — it arms only on a user drag and never ticks otherwise.

import React, { useCallback, useEffect, useRef, useState } from "react";
import { FlatList, Platform, Pressable, StyleSheet, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Image } from "expo-image";
import { Ionicons } from "@expo/vector-icons";
import { LinearGradient } from "expo-linear-gradient";
import { GlassFill } from "./Glass";
import { ManeuverArrow, ManeuverBox, maneuverDir } from "./components/ManeuverArrow";
import { COLORS, ACTION } from "./theme";
import { useAccent, useAccentAlpha } from "./appSkin";
import { NavStep, maneuverVerb, fmtDistanceM, fmtManeuverDist, fmtEtaSec } from "./nav";
import { skipNext, skipPrev } from "./applePlayer";
import { spotify } from "./spotify";
import { useNowPlaying } from "./nowPlaying";
import { useSettings } from "./settings";
import ShareSheet, { SharePayload } from "./ShareSheet";

const strip = (h?: string) => (h || "").replace(/<[^>]+>/g, "").trim();

// Resolve an Apple artwork template/url to a concrete square image URL (same
// helper the Music screen uses — the API returns "{w}x{h}" templates).
const artURL = (raw?: string, size = 96): string | undefined =>
  raw && typeof raw === "string"
    ? raw.replace("{w}", String(size)).replace("{h}", String(size)).replace("{f}", "jpg")
    : undefined;

// How long a manual scroll owns the list before it snaps back to the next turn.
const SCROLL_HOLD_MS = 5000;
// Music row height — the list's bottom padding and the footer offset both need it,
// and only when a song is actually loaded (no song = no row = no dead space).
const MUSIC_ROW_H = 60;

// One construction for all four footer actions so they read as a family: the
// candy-apple ramp (bright → mid → deep) with an iOS-only tinted GlassFill sheen,
// clipped to r14 — literally what End and Arrived carried as floating squares before
// Jeff moved them down here. Android skips the glass for the same reason End always
// did (Say Phin's 8/18 screenshot: on Android the glass layer rendered the fill
// visibly inset/narrower than the tile around it).
function FooterBtn(props: {
  label: string;
  ramp: readonly [string, string, string];
  tint: string;
  border: string;
  textColor: string;
  onPress: () => void;
  accessibilityLabel: string;
}) {
  return (
    <Pressable
      onPress={props.onPress}
      style={[styles.footerBtn, { borderColor: props.border }]}
      // 4, not the 8 the old full-width ghost carried: at 8 each button's hit rect covered
      // the whole 8pt gap, and RN gives an overlap to the LATER sibling — so a tap a few
      // points right of End fired Arrived, which banks the drive as an arrival instead of
      // an End. Harmless when these were 50pt squares 20pt apart at the top of the screen;
      // not harmless now they are 88pt neighbours under a moving thumb. 4 + 4 meets exactly
      // at the middle of the gap with no overlap. (Pre-flight review, 2026-09-20.)
      hitSlop={4}
      accessibilityLabel={props.accessibilityLabel}
    >
      <LinearGradient
        colors={props.ramp}
        locations={[0, 0.5, 1]}
        style={[StyleSheet.absoluteFill, { borderRadius: 14 }]}
      />
      {Platform.OS === "ios" && (
        <GlassFill tintColor={props.tint} style={{ borderRadius: 14, overflow: "hidden" }} />
      )}
      {/* "Show map" is the longest label and the 375pt phone has the least room:
          (375 − 24 padding − 24 gaps) / 4 = 81.7pt per button against 72.0pt of
          14pt/800 text (measured against the system font's advance widths), so it
          fits with ~5pt each side. maxFontSizeMultiplier pins Dynamic Type out of
          it and adjustsFontSizeToFit is the belt to that braces. */}
      <Text
        style={[styles.footerBtnText, { color: props.textColor }]}
        numberOfLines={1}
        adjustsFontSizeToFit
        minimumFontScale={0.8}
        maxFontSizeMultiplier={1}
      >
        {props.label}
      </Text>
    </Pressable>
  );
}

export default function CarDriveList(props: {
  steps: NavStep[];
  stepIndex: number;            // tbt.stepIndex — the step the driver is ON; +1 is the upcoming maneuver
  distanceToManeuverM: number;
  distanceRemainingM: number;
  etaSeconds: number;
  arrivalText: string;          // formatted clock time — fmtClock lives in map.tsx
  destinationLabel?: string;
  // Mid-drive reroute offer. The map used to be the tap surface for these (they draw
  // inline on the route line, ConvoyMapbox ~:3173) — with the map unmounted, the
  // voice yes/no still works but a muted driver would have NO way to answer. This
  // banner is that tap fallback.
  offer?: { title: string; subtitle: string } | null;
  onOfferAccept?: () => void;
  onOfferDismiss?: () => void;
  onShowMap: () => void;
  onEnd: () => void;
  onArrived?: () => void;   // candy-orange Arrived — declares arrival by hand
  // ADD STOP (Olaf, 2026-09-19: "would be nice to have a button that stands out to add a
  // stop on the phone screen … hard to find and end up having to just start a new route").
  // Optional so the button simply isn't there when the parent has nothing to wire it to.
  onAddStop?: () => void;
}) {
  const { steps, stepIndex } = props;
  // The tab bar is position:'absolute' (app/(app)/_layout.tsx ~:285, 86pt iOS / 84pt
  // Android + bottom inset), so screen content flows UNDER it — which put this
  // footer's "Show map" beneath the bottom chrome on iOS (Jeff's 8/17 photo). Lift
  // the footer to sit ON the tab bar's top edge; keep numbers in sync with _layout.
  const insets = useSafeAreaInsets();
  const tabBarH = (Platform.OS === "ios" ? 86 : 84) + (Platform.OS === "android" ? insets.bottom : 0);
  // The row that matters is the UPCOMING maneuver — same +1 convention as the
  // phone banner and the car strip (map.tsx:4406).
  const upcomingIdx = Math.min(stepIndex + 1, Math.max(0, steps.length - 1));
  const listRef = useRef<FlatList<NavStep>>(null);

  // ── SNAP-TO-TOP (Jeff, 2026-08-19: "the next turn is always at the top,
  // everything cycles to the top; manual scroll allowed but it snaps back") ────
  // The upcoming step rides AT THE TOP (viewPosition 0) and each completed turn
  // animates the list up one row — the "cycling" is the scroll animation itself.
  // A manual drag takes ownership for SCROLL_HOLD_MS, then the list glides back.
  const upcomingIdxRef = useRef(upcomingIdx);
  const holdingRef = useRef(false);
  const holdTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const snapToCurrent = useCallback((animated = true) => {
    try { listRef.current?.scrollToIndex({ index: upcomingIdxRef.current, animated, viewPosition: 0 }); } catch {}
  }, []);
  useEffect(() => {
    upcomingIdxRef.current = upcomingIdx;
    if (!holdingRef.current) snapToCurrent();
  }, [upcomingIdx, snapToCurrent]);
  useEffect(() => () => { if (holdTimer.current) clearTimeout(holdTimer.current); }, []);
  const onDragStart = useCallback(() => {
    holdingRef.current = true;
    if (holdTimer.current) clearTimeout(holdTimer.current);
  }, []);
  const onDragSettle = useCallback(() => {
    if (!holdingRef.current) return;
    if (holdTimer.current) clearTimeout(holdTimer.current);
    holdTimer.current = setTimeout(() => {
      holdingRef.current = false;
      snapToCurrent();
    }, SCROLL_HOLD_MS);
  }, [snapToCurrent]);

  // ── Now-playing row (Jeff, 2026-08-19: "put in a music player between the show
  // map and system drawer at the bottom" — art + share + transport).
  // SOURCE-AGNOSTIC on purpose: useNowPlaying is the same unified hook the map's
  // banner uses, so this row follows settings.musicSource (Apple Music OR
  // Spotify). It started on the Apple-only hooks, which would have shown a
  // Spotify driver an EMPTY footer the moment the map banner was hidden in
  // car-list mode — one player replacing the other has to cover both sources.
  // No song (either source) → no row, and nothing shifts.
  const { song, isPlaying, toggle } = useNowPlaying() as { song: any; isPlaying: boolean; toggle: () => void };
  const [settings] = useSettings();
  const isSpotify = settings?.musicSource === "spotify";
  const next = useCallback(() => { if (isSpotify) void spotify.next(); else skipNext(); }, [isSpotify]);
  const prev = useCallback(() => { if (isSpotify) void spotify.previous(); else skipPrev(); }, [isSpotify]);
  const [sharePayload, setSharePayload] = useState<SharePayload | null>(null);
  const hasMusic = !!song;
  const art = artURL(song?.artworkUrl ?? song?.artwork?.url, 96);
  // App skin: the next-turn wash follows the user's chrome accent (silver/gold at
  // tier), at the SAME opacities the brand-green rgba carried.
  const accent = useAccent();
  const washStrong = useAccentAlpha(0.20);
  const washFade = useAccentAlpha(0.02);

  return (
    <View style={styles.root} pointerEvents="auto">
      <View style={styles.header}>
        <Text style={[styles.onCar, { color: accent }]}>NAVIGATION IS ON YOUR CAR SCREEN</Text>
        {/* ONE line, always (Jeff, 2026-08-16: "the AM is on its own and doesn't look
            polished") — same auto-shrink pattern as the speedo numbers: a long ETA or
            "11:41 PM" scales the whole line down instead of wrapping its tail. */}
        <Text style={styles.eta} numberOfLines={1} adjustsFontSizeToFit minimumFontScale={0.6}>
          {fmtEtaSec(props.etaSeconds)} · {fmtDistanceM(props.distanceRemainingM)} · arrive {props.arrivalText}
        </Text>
        {!!props.destinationLabel && <Text style={styles.dest} numberOfLines={1}>{props.destinationLabel}</Text>}
      </View>
      {!!props.offer && (
        <View style={styles.offer}>
          <View style={styles.rowBody}>
            <Text style={styles.offerTitle}>{props.offer.title}</Text>
            <Text style={styles.offerSub} numberOfLines={1}>{props.offer.subtitle}</Text>
          </View>
          <Pressable onPress={props.onOfferDismiss} style={styles.btnGhostSm} hitSlop={8}>
            <Text style={styles.btnGhostText}>No</Text>
          </Pressable>
          <Pressable onPress={props.onOfferAccept} style={styles.btnGoSm} hitSlop={8}>
            <Text style={styles.btnGoText}>Switch</Text>
          </Pressable>
        </View>
      )}
      <FlatList
        ref={listRef}
        data={steps}
        keyExtractor={(_, i) => String(i)}
        onScrollBeginDrag={onDragStart}
        onScrollEndDrag={onDragSettle}
        onMomentumScrollEnd={onDragSettle}
        // Variable-height rows: scrollToIndex throws for a not-yet-rendered index.
        // Land near it by average offset, then retry once rendered — a missed snap
        // is cosmetic, never worth a crash.
        onScrollToIndexFailed={(info) => {
          try { listRef.current?.scrollToOffset({ offset: Math.max(0, info.averageItemLength * info.index), animated: false }); } catch {}
          setTimeout(() => { if (!holdingRef.current) snapToCurrent(); }, 250);
        }}
        contentContainerStyle={[styles.listPad, { paddingBottom: tabBarH + 84 + (hasMusic ? MUSIC_ROW_H : 0) }]}
        renderItem={({ item, index }) => {
          const current = index === upcomingIdx;
          const past = index < upcomingIdx;
          return (
            <View style={[styles.row, current && [styles.rowCurrent, { borderLeftColor: accent }], past && styles.rowPast]}>
              {/* Gradient wash for the NEXT-turn row (8/20, with the ManeuverBox pass):
                  green glow strongest at the arrow edge, fading across — replaces the
                  flat rgba fill that read as a plain stripe. */}
              {current && (
                <LinearGradient
                  colors={[washStrong, washFade]}
                  start={{ x: 0, y: 0.5 }} end={{ x: 1, y: 0.5 }}
                  style={StyleSheet.absoluteFill}
                />
              )}
              {/* Green square arrow — the EXACT component + colors the banner's
                  maneuver box uses (ManeuverArrow, dark glyph on brand green), so
                  the two can never disagree about a turn's direction. */}
              <ManeuverBox size={30} radius={8}>
                <ManeuverArrow dir={maneuverDir(strip(item.html), item.maneuver)} size={20} color="#0B0B0C" />
              </ManeuverBox>
              <View style={styles.rowBody}>
                <Text style={[styles.rowText, current && styles.rowTextCurrent]}>
                  {strip(item.html) || maneuverVerb(item.maneuver)}
                </Text>
              </View>
              <Text style={[styles.rowDist, current && [styles.rowDistCurrent, { color: accent }]]}>
                {current ? fmtManeuverDist(props.distanceToManeuverM) : item.distance_text}
              </Text>
            </View>
          );
        }}
      />
      <View style={[styles.footer, { bottom: tabBarH }]}>
        {/* THE ACTION ROW (Jeff, 2026-09-20: "on the turnbyturn phone screen lets move the
            end/arrived/shop map/add stop to the bottom replacing the current full width show
            map"). End and Arrived used to float as 50x50 squares up under the logo — two
            thumb-stretches from where the hand actually rests — and Add stop had no home on
            this face at all. Four equal buttons, same candy construction the squares
            carried, so nothing new had to be invented. Order + colours re-cut 2026-09-22 to
            mirror the map drawer — see the note inside the row. */}
        <View style={styles.footerRow}>
          {/* SAME SEQUENCE AS THE MAP DRAWER (Jeff, 2026-09-22: "match the map drawer setup …
              far right -> end, next -> arrived, next -> add stop, far left -> show map"). The
              drawer reads blue · green · orange · red left to right; so does this row now, so
              the two faces of the same drive are one picture. The only swap is which job the
              blue and the green carry: here the go-to-the-other-face button is BLUE and Add
              stop is GREEN (his colours), on the drawer it is the reverse. End stays hard
              right under the thumb on both. */}
          <FooterBtn
            label="Show map"
            // Blue: the middle stop is COLORS.primary so the app gains no second blue (theme.ts's
            // ACTION discipline: one red, one green). Not a tier colour either (DESIGN.md).
            ramp={["#4AA8FF", COLORS.primary, "#0A4DA0"]}
            tint={COLORS.primary}
            border="rgba(120,190,255,0.9)"
            textColor="#FFFFFF"
            onPress={props.onShowMap}
            accessibilityLabel="Show map"
          />
          {props.onAddStop && (
            <FooterBtn
              label="Add stop"
              // The SAME green as StepDrawer's "directions" tile — one green, one blue, one
              // orange, one red across both faces.
              ramp={["#3DFF9A", "#1FC96E", "#0E8F4C"]}
              tint="#1FC96E"
              border="rgba(120,255,180,0.9)"
              textColor="#04150B"
              onPress={props.onAddStop}
              accessibilityLabel="Add a stop"
            />
          )}
          {props.onArrived && (
            <FooterBtn
              label="Arrived"
              ramp={["#FFB03B", "#FF8A00", "#C25E00"]}
              tint="#FF8A00"
              border="rgba(255,190,110,0.95)"
              textColor="#2A1200"
              onPress={props.onArrived}
              accessibilityLabel="I have arrived"
            />
          )}
          <FooterBtn
            label="End"
            ramp={["#FF3B5C", "#E4002B", "#B00020"]}
            tint="#E4002B"
            border="rgba(255,90,120,0.9)"
            textColor="#FFFFFF"
            onPress={props.onEnd}
            accessibilityLabel="End navigation"
          />
        </View>
        {hasMusic && (
          <View style={styles.musicRow}>
            {art ? (
              <Image source={{ uri: art }} style={styles.musicArt} contentFit="cover" />
            ) : (
              <View style={[styles.musicArt, styles.musicArtEmpty]}>
                <Ionicons name="musical-notes" size={18} color="#9BA1A6" />
              </View>
            )}
            <View style={{ flex: 1, minWidth: 0 }}>
              <Text style={styles.musicTitle} numberOfLines={1}>{song?.title ?? song?.name ?? "Now Playing"}</Text>
              <Text style={styles.musicSub} numberOfLines={1}>{song?.artistName ?? song?.artist ?? ""}</Text>
            </View>
            <Pressable
              onPress={() => setSharePayload({
                kind: "music",
                title: song?.title ?? song?.name,
                artist: song?.artistName ?? song?.artist,
                artworkUrl: song?.artworkUrl ?? song?.artwork?.url,
                url: song?.url,
              })}
              hitSlop={8}
            >
              <Ionicons name="share-outline" size={20} color={ACTION.share} />
            </Pressable>
            <Pressable onPress={prev} hitSlop={8} style={{ marginLeft: 16 }}>
              <Ionicons name="play-skip-back" size={20} color="#F4F4F4" />
            </Pressable>
            <Pressable onPress={toggle} hitSlop={8} style={{ marginHorizontal: 14 }}>
              <Ionicons name={isPlaying ? "pause" : "play"} size={26} color="#F4F4F4" />
            </Pressable>
            <Pressable onPress={next} hitSlop={8}>
              <Ionicons name="play-skip-forward" size={20} color="#F4F4F4" />
            </Pressable>
          </View>
        )}
      </View>
      {/* The floating END and ARRIVED squares that used to live here — 50x50 r14, stacked
          under the Hairpin logo at the top right since 8/16 and 9/12 — are GONE: both are
          footer buttons now (Jeff, 2026-09-20). The logo still floats there on its own; it
          is map.tsx's, at zIndex 100, and the header's paddingRight clears it. */}
      <ShareSheet
        visible={!!sharePayload}
        onClose={() => setSharePayload(null)}
        share={sharePayload}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  // Opaque, above the map overlays (they stay mounted beneath; zIndex wins among
  // siblings). Modals/sheets still present above via the native modal layer.
  root: { ...StyleSheet.absoluteFillObject, backgroundColor: COLORS.bg, zIndex: 50, elevation: 50 },
  // paddingRight clears the floating Hairpin logo on the right edge — and now ONLY the
  // logo: it is 50 wide at right 12, so 62 is the hard minimum and 70 leaves a gutter.
  // Was 76 while the End/Arrived squares hung beneath the logo; those are in the footer
  // now (2026-09-20), which hands the one-line ETA readout 6pt back before it shrinks.
  header: { paddingTop: Platform.OS === "ios" ? 64 : 40, paddingLeft: 20, paddingRight: 70, paddingBottom: 14, borderBottomWidth: 1, borderBottomColor: COLORS.hairline },
  onCar: { color: COLORS.brand, fontSize: 12, fontWeight: "800", letterSpacing: 1.2 },
  eta: { color: "#F4F4F4", fontSize: 22, fontWeight: "800", marginTop: 8 },
  dest: { color: "#9BA1A6", fontSize: 14, fontWeight: "600", marginTop: 2 },
  listPad: { paddingVertical: 8 },
  row: { flexDirection: "row", alignItems: "center", paddingVertical: 14, paddingHorizontal: 20, gap: 12 },
  // Fill comes from the gradient wash in renderItem; this keeps the brand spine.
  rowCurrent: { borderLeftWidth: 3, borderLeftColor: COLORS.brand, overflow: "hidden" },
  rowPast: { opacity: 0.35 },
  rowBody: { flex: 1, minWidth: 0 },
  rowText: { color: "#D7DBDE", fontSize: 16, fontWeight: "600" },
  rowTextCurrent: { color: "#FFFFFF", fontSize: 18, fontWeight: "800" },
  rowDist: { color: "#9BA1A6", fontSize: 13, fontWeight: "700" },
  rowDistCurrent: { color: COLORS.brand, fontSize: 15, fontWeight: "800" },
  // `bottom` is set inline (tab bar height + inset — see tabBarH above). Still a
  // COLUMN: the action row, then (when a song is loaded) the now-playing row —
  // "between the show map and the system drawer at the bottom". The music row did
  // not move; the row above it went from one full-width ghost to four candy buttons.
  footer: {
    position: "absolute", left: 0, right: 0,
    backgroundColor: COLORS.bg, borderTopWidth: 1, borderTopColor: COLORS.hairline,
  },
  // 20/12 became 12/8 to buy the four labels their width: at 375pt that is
  // (375 − 24 − 24) / 4 = 81.7pt each, and at 430pt 95.5pt. The old 20/12 would have
  // left 74.7pt against a 72.0pt "Show map" — under 1.5pt of air per side.
  footerRow: { flexDirection: "row", gap: 8, paddingHorizontal: 12, paddingTop: 12, paddingBottom: 12 },
  musicRow: {
    flexDirection: "row", alignItems: "center", height: MUSIC_ROW_H,
    paddingHorizontal: 20, gap: 12, borderTopWidth: 1, borderTopColor: COLORS.hairline,
  },
  musicArt: { width: 40, height: 40, borderRadius: 8, backgroundColor: "#1C1C1E" },
  musicArtEmpty: { alignItems: "center", justifyContent: "center" },
  musicTitle: { color: "#F4F4F4", fontSize: 14, fontWeight: "700" },
  musicSub: { color: "#9BA1A6", fontSize: 12, fontWeight: "600", marginTop: 1 },
  // btnGhostText survives on its own: the reroute-offer banner's "No" still uses it.
  btnGhostText: { color: "#F4F4F4", fontSize: 16, fontWeight: "700" },
  // r14, not the old ghost button's r12 — the radius is the shape language the logo
  // tile, the car strip and StepDrawer's tiles all share. Container transparent +
  // clipped: the colour is the candy gradient child.
  footerBtn: {
    flex: 1, height: 48, borderRadius: 14,
    backgroundColor: "transparent", overflow: "hidden", borderWidth: 1,
    alignItems: "center", justifyContent: "center",
  },
  // 14pt where the old full-width label was 16: the widest label ("Show map") measures
  // 72.0pt at 14/800 against 81.7pt of button on a 375pt phone. 15pt would leave 5.7pt.
  footerBtnText: { fontSize: 14, fontWeight: "800", letterSpacing: 0.1 },
  offer: {
    flexDirection: "row", alignItems: "center", gap: 10, marginHorizontal: 16, marginTop: 10,
    padding: 12, borderRadius: 12, borderWidth: 1, borderColor: COLORS.brandDim,
    backgroundColor: "rgba(45,236,134,0.10)",
  },
  offerTitle: { color: "#FFFFFF", fontSize: 15, fontWeight: "800" },
  offerSub: { color: "#9BA1A6", fontSize: 12, fontWeight: "600", marginTop: 1 },
  btnGhostSm: { height: 38, paddingHorizontal: 14, borderRadius: 10, borderWidth: 1, borderColor: COLORS.hairlineStrong, alignItems: "center", justifyContent: "center" },
  btnGoSm: { height: 38, paddingHorizontal: 16, borderRadius: 10, backgroundColor: COLORS.brand, alignItems: "center", justifyContent: "center" },
  btnGoText: { color: "#04160C", fontSize: 15, fontWeight: "800" },
});
