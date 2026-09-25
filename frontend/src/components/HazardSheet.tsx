// HazardSheet.tsx — the phone's Report panel: the head unit's Report grid, on the phone (Jeff, 2026-09-24:
// "WHERE IS THE HAZARDS BUTTON ON THE PHONE?" — the panel had shipped for CarPlay / Android Auto only, and the
// phone's own Police/Hazard drawer had been dormant since the police FAB became Crew on 07-23: reporting was voice-only).
//
// FOUR SURFACES: the tiles ARE the head unit's (src/carplay/hazardPanel.ts HAZARD_TILES, the report kinds only —
// the phone keeps its compass FAB, so no compass tile here), the art is the same direction-B Apple-symbol glyph
// set in the driver's metal (assets/carplay-glyphs/report), the shape is the Hairpin square (DESIGN.md § Shape:
// radius ≈ 28 % of height). A tile reports at the car's position from 5 s ago through map.tsx's reportHazard —
// the same POST /hazards the voice intents use — and closes the panel; the confirmation is the ReportToast pill.
//
// WHERE IT SITS (Jeff, 2026-09-24, off his screenshot of the first cut: "Make sure the hazard panel does not collide
// with anything else … Make sure on the phone the hazard panel is above the hazard button"): NOT a bottom sheet any
// more — that one lay across the weather HUD, the speedo, the FAB column and the tab bar. It is a floating card
// anchored ABOVE the right-hand FAB stack (map.tsx measures the stack and passes anchorBottom) and CENTRED on the
// screen (Jeff, 2026-09-25: "MAKE SURE ITS CENTERED"), in the map area where nothing else lives. Tap anywhere outside it to close (a transparent full-screen
// backdrop — no dimming, the map stays readable, like the weather forecast card).
//
// LOOK = the weather forecast card (Jeff: "Make the panel have the same background opacity as the weather panel"):
// the same translucent floor rgba(24,24,28,0.66), the same hairline, the same GlassFill tinted by hudTint(), the same
// pop (opacity + 12 pt rise + 0.94 scale). WeatherHUD.tsx styles.forecastCard is the reference — change both or neither.
import React, { useEffect, useRef, useState } from "react";
import { Image, Modal, Platform, Pressable, StyleSheet, Text, View, useWindowDimensions } from "react-native";
import { GlassFill, hudTint } from "../Glass";
import { PressableScale } from "../ui/PressableScale";
import { useAppSkin } from "../appSkin";
import { haptics } from "../haptics";
import { logEvent } from "../crashBreadcrumb";
import { HAZARD_TILES, HAZARD_PANEL_AUTO_CLOSE_MS, type HazardKind, type HazardGlyph } from "../carplay/hazardPanel";
import type { VisualTier } from "../tierTheme";

/** The report glyphs per metal — the same PNGs the head unit bakes into carButtonIcons.ts. */
export const HAZARD_ART: Record<Exclude<HazardGlyph, "hz_camera">, Record<VisualTier, number>> = {
  hz_police:  { brand: require("../../assets/carplay-glyphs/report/police_green.png"),  premium: require("../../assets/carplay-glyphs/report/police_silver.png"),  ultra: require("../../assets/carplay-glyphs/report/police_gold.png"),  diamond: require("../../assets/carplay-glyphs/report/police_diamond.png") },
  hz_crash:   { brand: require("../../assets/carplay-glyphs/report/crash_green.png"),   premium: require("../../assets/carplay-glyphs/report/crash_silver.png"),   ultra: require("../../assets/carplay-glyphs/report/crash_gold.png"),   diamond: require("../../assets/carplay-glyphs/report/crash_diamond.png") },
  hz_hazard:  { brand: require("../../assets/carplay-glyphs/report/hazard_green.png"),  premium: require("../../assets/carplay-glyphs/report/hazard_silver.png"),  ultra: require("../../assets/carplay-glyphs/report/hazard_gold.png"),  diamond: require("../../assets/carplay-glyphs/report/hazard_diamond.png") },
  hz_traffic: { brand: require("../../assets/carplay-glyphs/report/traffic_green.png"), premium: require("../../assets/carplay-glyphs/report/traffic_silver.png"), ultra: require("../../assets/carplay-glyphs/report/traffic_gold.png"), diamond: require("../../assets/carplay-glyphs/report/traffic_diamond.png") },
  hz_compass: { brand: require("../../assets/carplay-glyphs/report/compass_green.png"), premium: require("../../assets/carplay-glyphs/report/compass_silver.png"), ultra: require("../../assets/carplay-glyphs/report/compass_gold.png"), diamond: require("../../assets/carplay-glyphs/report/compass_diamond.png") },
};
/** The map button's own art: the hazard triangle in the metal (the head unit's car-hazards button). */
export const HAZARD_FAB_ART = HAZARD_ART.hz_hazard;

// ALL FIVE tiles now, the compass included (Jeff, 2026-09-25: the phone's compass FAB became the 2D/3D button, so the
// compass rides inside the panel exactly as it does on the head units).
const PANEL_TILES = HAZARD_TILES.filter((t): t is typeof t & { glyph: keyof typeof HAZARD_ART } => t.glyph in HAZARD_ART);
const TILE_MAX = 64;                  // pt; the Hairpin square radius is 28 % of it
const TILE_GAP = 8;
const PAD_H = 12;
/** Five faces + gaps + padding: the card's natural width; capped to the window on a small phone (tiles shrink). */
const CARD_W = TILE_MAX * 5 + TILE_GAP * 4 + PAD_H * 2;
/** Side gutter the card keeps on a narrow phone (map.tsx styles.fabStack uses the same 12). */
const RIGHT_INSET = 12;
/** Air between the top button and the card. */
const GAP_ABOVE_STACK = 10;
/** The card's top edge never rises closer than this to the top of the window: the search bar / H button end ~104 pt
 *  down on an iPhone 16 Pro. Only bites on a short phone with the Drive drawer up (the FAB stack rides high then). */
const TOP_CLEAR = 120;
/** Until onLayout reports the real height (title + faces + labels + hint). */
const CARD_H_GUESS = 190;
// ⛔ THE CARD LIVES IN A transparent Modal — its own window — NOT in the map screen's view tree (2026-09-25, measured).
// As a plain absolutely-positioned sibling of the map (zIndex 301 over a backdrop at 300) the SAME component painted on
// some cold launches and not on others: open + auto-close receipts fired, anchor identical, nothing on screen — 0 of 8
// launches across four bundles vs 6 of 6 on two other bundles of near-identical code, native- and JS-driven opacity alike.
// Never root-caused. A Modal is composited above everything by UIKit / WindowManager, so it cannot lose that race, and
// its onRequestClose gives Android Back for free (no BackHandler — see the note below). The card's `bottom` is measured
// from the window's bottom edge, which is where the map screen's `bottom` (styles.fabStack) is measured from too.
// One report at a time (Codex review 2026-09-24): the panel closes on the tap, so React state cannot dedupe a second
// tap or a re-open during a slow POST — the CarPlay path has _reportInFlight for the same reason. Module-level so it
// survives the panel unmounting; released when the caller's promise settles.
let _reportBusy = false;

export default function HazardSheet({ visible, onClose, onReport, onCompass, dismiss, anchorBottom }: {
  visible: boolean;
  onClose: () => void;
  /** Returns the report's promise so the panel can hold off a second tap until it settles. */
  onReport: (kind: HazardKind) => Promise<unknown> | void;
  /** The Compass tile: recenter + face north (the old compass FAB's tap, 🔒 region intact in map.tsx). */
  onCompass: () => void;
  /** True while turn-by-turn is active: a panel left open at drive start (the speed auto-start, a car-session
   *  adoption) must not sit over guidance (Codex review 2026-09-24). */
  dismiss?: boolean;
  /** Distance from the map's bottom edge to the TOP of the FAB stack (map.tsx: controlsBottom + the measured stack
   *  height). The card's bottom edge sits GAP_ABOVE_STACK above it, so it never covers a button. */
  anchorBottom: number;
}) {
  const metal = useAppSkin();
  const { width: winW, height: winH } = useWindowDimensions();
  const [cardH, setCardH] = useState(CARD_H_GUESS);
  const cardRef = useRef<View>(null);
  // Close on the TRANSITION into turn-by-turn only (Codex review r2, 2026-09-24): a panel opened DURING a drive —
  // the whole point of a hazard report — must stay up; one left open when the drive auto-starts must not sit
  // over guidance. The previous value rides a ref, so the component stays mounted across visible=false.
  // map.tsx hands us a fresh onClose arrow every render (it re-renders on every location tick), so timers and
  // listeners read it through a ref and depend on `visible` only — otherwise each tick would restart the auto-close.
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  // Receipts (the head units log the same op= rows): open / close why=nav|auto|back|tap. Bounded by the user's taps.
  const close = (why: string) => { try { logEvent(`hazard-panel op=close surf=phone why=${why}`); } catch {} onCloseRef.current(); };
  const prevDismiss = useRef(!!dismiss);
  useEffect(() => {
    const was = prevDismiss.current;
    prevDismiss.current = !!dismiss;
    if (visible && dismiss && !was) close("nav");
  }, [visible, dismiss]);
  // Auto-close (Jeff, 2026-09-25: "MAKE SURE THE PANEL AUTO DISAPPEARS TOO"): a panel nobody taps folds itself away
  // after HAZARD_PANEL_AUTO_CLOSE_MS. The head units' grids do the same (carActions.ts armHazardsAutoPop).
  useEffect(() => {
    if (!visible) return;
    const t = setTimeout(() => close("auto"), HAZARD_PANEL_AUTO_CLOSE_MS);
    return () => clearTimeout(t);
  }, [visible]);
  // ⛔ NO ENTRANCE ANIMATION ON THIS CARD (2026-09-25, measured on the iPhone 16 Pro sim): every fade-in that starts the
  // card at opacity 0 — RN Animated with the native driver, RN Animated on the JS thread, and Reanimated's FadeInDown —
  // left it INVISIBLE on 13 of 15 cold launches (open + auto-close receipts fired, nothing painted), while the same build
  // with a static `opacity: 1` painted first time. Not root-caused; HYPOTHESIS: UI-thread prop updates after the mount
  // commit are not reaching this view in that state (the app's own frame pacing is the first suspect). Until that is
  // measured, the card simply appears. Gate D8 forbids an animated opacity here.
  // NO BackHandler here: Android Back is the Modal's onRequestClose (close("back")). A hardwareBackPress listener was
  // tried on 2026-09-25 and blamed for the unpainted panel; the later trials showed the paint failure was independent of
  // it (see the Modal note above), but the Modal makes it moot.
  useEffect(() => {
    if (!visible) return;
    try { logEvent(`hazard-panel op=open surf=phone anchor=${Math.round(anchorBottom)} winH=${Math.round(winH)}`); } catch {}
  }, [visible]);  // eslint-disable-line react-hooks/exhaustive-deps -- one row per open, not per tick
  if (!visible) return null;
  const cardW = Math.min(CARD_W, winW - RIGHT_INSET * 2);
  const tile = Math.min(TILE_MAX, Math.floor((cardW - PAD_H * 2 - TILE_GAP * 4) / 5));
  const tileRadius = Math.round(tile * 0.28);
  const glyphPt = Math.round(tile * 0.62);
  // Above the stack — unless that would push the card into the top bar (short phone, Drive drawer up): then it stops
  // TOP_CLEAR from the top and may touch the compass FAB, never the Hazards button below it.
  const bottom = Math.min(anchorBottom + GAP_ABOVE_STACK, Math.max(0, winH - TOP_CLEAR - cardH));
  return (
    <Modal transparent visible animationType="none" onRequestClose={() => close("back")} statusBarTranslucent hardwareAccelerated>
      {/* Tap anywhere outside the card to close. Transparent on purpose: the map stays readable, the way the weather
          forecast card leaves it. Covers the FAB stack too, so a stray tap on Crew while the panel is up just closes it. */}
      <Pressable testID="hazard-sheet-backdrop" style={StyleSheet.absoluteFill} onPress={() => close("tap")} accessibilityLabel="Close" />
      <View
        testID="hazard-sheet"
        ref={cardRef}
        onLayout={(e) => {
          const { x, y, width, height } = e.nativeEvent.layout;
          const h = Math.round(height); if (h > 0 && h !== cardH) setCardH(h);
          // Receipt: where the card actually landed, in its own frame and in the window (bench diagnosis, 2026-09-25).
          try { cardRef.current?.measureInWindow?.((wx, wy, ww, wh) => { try { logEvent(`hazard-panel layout x=${Math.round(x)} y=${Math.round(y)} w=${Math.round(width)} h=${h} win=${Math.round(wx)},${Math.round(wy)},${Math.round(ww)},${Math.round(wh)}`); } catch {} }); } catch {}
        }}
        style={[
          styles.card,
          {
            width: cardW,
            left: Math.round((winW - cardW) / 2),
            bottom,
          },
        ]}
      >
        <GlassFill tintColor={hudTint()} style={StyleSheet.absoluteFill} />
        <Text maxFontSizeMultiplier={1.2} style={styles.title}>Report</Text>
        <View style={styles.row}>
          {PANEL_TILES.map((t) => (
            <PressableScale
              key={t.id}
              testID={t.kind ? `report-${t.kind}` : "report-compass"}
              hitSlop={0}   // the faces sit 8 pt apart; the default 12 pt slop let an edge tap report the neighbour (Codex r3)
              style={styles.tile}
              accessibilityLabel={t.kind ? `Report ${t.title}` : "Compass"}
              onPress={() => {
                if (t.kind == null) { haptics.snap(); onCompass(); onCloseRef.current(); return; }
                if (_reportBusy) return;
                haptics.snap();
                _reportBusy = true;
                Promise.resolve(onReport(t.kind)).catch(() => {}).finally(() => { _reportBusy = false; });
              }}
            >
              <View style={[styles.tileFace, { width: tile, height: tile, borderRadius: tileRadius }]}>
                <Image source={HAZARD_ART[t.glyph][metal]} style={{ width: glyphPt, height: glyphPt }} resizeMode="contain" />
              </View>
              <Text maxFontSizeMultiplier={1.2} style={styles.label}>{t.title}</Text>
            </PressableScale>
          ))}
        </View>
        <Text maxFontSizeMultiplier={1.2} style={styles.hint}>Pinned where you were 5 seconds ago. The crew sees it right away.</Text>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  // = WeatherHUD.tsx styles.forecastCard (floor, hairline, radius, shadow), plus the absolute anchor.
  card: {
    position: "absolute",
    paddingHorizontal: PAD_H,
    paddingTop: 12,
    paddingBottom: 12,
    borderRadius: 16,
    overflow: "hidden",
    // Translucent frosted floor. The card pops inside an animated (transform + opacity) view, where the iOS-26
    // GlassView won't composite — so this View bg is what actually renders the frosted panel (readable), with the
    // GlassFill adding real glass on top wherever it does paint. SAME VALUE as the weather forecast card.
    backgroundColor: "rgba(24,24,28,0.66)",
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: "rgba(255,255,255,0.14)",
    ...Platform.select({
      ios: { shadowColor: "#000", shadowOpacity: 0.45, shadowRadius: 12, shadowOffset: { width: 0, height: 6 } },
      android: { elevation: 10 },
    }),
  },
  title: { color: "#F4F4F4", fontSize: 17, fontWeight: "700", letterSpacing: -0.2, textAlign: "center", marginBottom: 10 },
  row: { flexDirection: "row", justifyContent: "space-between", gap: TILE_GAP },
  tile: { flex: 1, alignItems: "center", gap: 6 },
  tileFace: {
    backgroundColor: "rgba(255,255,255,0.07)", borderWidth: StyleSheet.hairlineWidth, borderColor: "rgba(255,255,255,0.16)",
    alignItems: "center", justifyContent: "center",
  },
  label: { color: "#E5E5EA", fontSize: 13, fontWeight: "600" },
  hint: { color: "#8E8E93", fontSize: 11.5, textAlign: "center", marginTop: 10 },
});
