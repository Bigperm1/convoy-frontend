import React, { useRef, useState, useEffect } from 'react';
import {
  View, Text, StyleSheet, TouchableOpacity, Modal, Pressable, Platform, Dimensions, Animated, Easing, Switch,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useRouter } from 'expo-router';
import * as Haptics from 'expo-haptics';
import ConvoyLogo from './ConvoyLogo';
import { useAuth } from '../auth';
import { useAccent, useAccentAlpha } from '../appSkin';
import { useSettings, getAvatarMode, setAvatarMode } from '../settings';

const OWNER_EMAIL = 'jwellsmorton@gmail.com';
// 230 → 276 for the Ghost-mode switch row (Jeff, 2026-09-23: menu reorganization).
// Sized from the font, not by eye: its subtitle "Hide me from the crew" measures
// ~129 px at 12 px in SF (macOS SFNS.ttf, regular), and the row also carries 16 px
// padding ×2 + a 36 px icon well + two 12 px gaps + the 51 px iOS switch. At 258 the
// subtitle would get ~115 px and ellipsize (numberOfLines={1}).
const CARD_W = 276;
const GAP = 8; // gap between the logo's bottom and the dropdown's top

type Item = {
  label: string;
  icon: keyof typeof Ionicons.glyphMap;
  route: string;
  /**
   * Push the target's layout anchor (its `unstable_settings.initialRouteName`)
   * underneath it. Only matters for a route INSIDE a nested stack: without it,
   * React Navigation builds that stack from the target alone, so Back has nowhere
   * inside the stack to go.
   */
  withAnchor?: boolean;
};

// ON THE ROAD — things a driver flips from the map without digging through
// Settings (Jeff, 2026-09-23: menu reorganization). Ghost mode is not a route, so
// it renders as its own switch row (GhostRow) under this one.
// Map Layers lives inside the Settings stack: withAnchor puts the Settings index
// beneath it (app/(app)/settings/_layout.tsx declares index as the anchor), so
// Back from Map Layers lands on the Settings menu.
const MAP_LAYERS: Item = {
  label: 'Map Layers', icon: 'layers', route: '/(app)/settings/map-layers', withAnchor: true,
};

// PLACES — the global destinations behind the logo. Club is the /(app)/hub route
// (clubs, meets and cruises); the row was labelled "Hub" until the 2026-09-23 menu
// reorganization. The Admin row is appended at runtime for the owner only (below).
const PLACES: Item[] = [
  { label: 'Garage',    icon: 'car-sport',        route: '/(app)/garage' },
  { label: 'Club',      icon: 'people',           route: '/(app)/hub' },
  { label: 'Drives',    icon: 'navigate',         route: '/(app)/trips' },
  { label: 'Settings',  icon: 'settings-sharp',   route: '/(app)/settings' },
];

// logo-menu-<label>, lowercased, spaces → dashes: "Map Layers" → logo-menu-map-layers.
// Single-word labels keep the ids they always had (logo-menu-garage, -settings, …).
const testIdFor = (label: string) => `logo-menu-${label.toLowerCase().replace(/\s+/g, '-')}`;

type Props = {
  /** Logo button size in px. Defaults to 32. */
  size?: number;
  /** Optional style override for the touchable wrapper. */
  style?: any;
  /**
   * Which side of the screen the dropdown anchors to:
   *  - 'left'  (default): card's left edge under the logo — used on the map,
   *    where the logo lives on the left of the header.
   *  - 'right': card's right edge under the logo — used on the Comms and Music
   *    headers, where the logo sits on the right.
   */
  align?: 'left' | 'right';
};

/**
 * Global brand-logo button that opens the H menu: ON THE ROAD (Map Layers, the
 * Ghost-mode switch) and PLACES (Garage, Club, Drives, Settings, owner-only Admin).
 * On open it measures the logo's on-screen position and drops the dropdown just
 * beneath it — so the menu's top lines up with the header's divider line — then
 * anchors it to the left or right edge per `align`. Self-contained: renders in a
 * transparent Modal so it floats above any screen and a tap outside dismisses.
 */
export default function LogoMenu({ size = 32, style, align = 'left' }: Props) {
  const router = useRouter();
  const { user } = useAuth();
  const accent = useAccent();
  const cardBorder = useAccentAlpha(0.25);
  const iconWell = useAccentAlpha(0.10);
  const [open, setOpen] = useState(false);
  const btnRef = useRef<any>(null);
  const [anchor, setAnchor] = useState<{ x: number; y: number; w: number; h: number } | null>(null);

  // Drop-down entrance: backdrop fades while the card slides + scales down from
  // just under the logo (vs the old instant appear).
  const drop = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    if (open) {
      drop.setValue(0);
      Animated.spring(drop, { toValue: 1, useNativeDriver: true, tension: 120, friction: 14 }).start();
    }
  }, [open, drop]);
  const closeMenu = (after?: () => void) => {
    Animated.timing(drop, { toValue: 0, duration: 130, easing: Easing.in(Easing.quad), useNativeDriver: true })
      .start(({ finished }) => { if (finished) { setOpen(false); after?.(); } });
  };

  // Owner-only Admin entry (roster + password resets). Appended to the menu
  // only for the app owner's account so regular drivers never see it.
  const isOwner = (user?.email || '').trim().toLowerCase() === OWNER_EMAIL;
  const places: Item[] = isOwner
    ? [...PLACES, { label: 'Admin', icon: 'shield-checkmark', route: '/(app)/admin' }]
    : PLACES;

  const openMenu = () => {
    Haptics.selectionAsync();
    const node = btnRef.current;
    // Measure the logo so the dropdown can drop right under it. measureInWindow
    // returns window-space coords, matching the Modal's coordinate space.
    if (node && typeof node.measureInWindow === 'function') {
      node.measureInWindow((x: number, y: number, w: number, h: number) => {
        setAnchor({ x, y, w, h });
        setOpen(true);
      });
    } else {
      setAnchor(null);
      setOpen(true);
    }
  };

  const go = (item: Item) => {
    Haptics.selectionAsync();
    // Animate the menu out, then navigate so the close doesn't fight the route
    // transition on slower devices.
    const opts = item.withAnchor ? { withAnchor: true } : undefined;
    closeMenu(() => setTimeout(() => router.push(item.route as any, opts), 10));
  };

  const renderRow = (item: Item, last: boolean) => (
    <TouchableOpacity
      key={item.label}
      style={[styles.row, last && styles.rowLast]}
      activeOpacity={0.7}
      onPress={() => go(item)}
      testID={testIdFor(item.label)}
    >
      <View style={[styles.rowIcon, { backgroundColor: iconWell }]}>
        <Ionicons name={item.icon} size={20} color={accent} />
      </View>
      <Text style={styles.rowLabel}>{item.label}</Text>
      <Ionicons name="chevron-forward" size={18} color="#555" />
    </TouchableOpacity>
  );

  const screenW = Dimensions.get('window').width;
  const fallbackTop = Platform.OS === 'ios' ? 96 : 64;
  const top = anchor ? anchor.y + anchor.h + GAP : fallbackTop;
  const horiz =
    align === 'right'
      ? { right: Math.max(12, screenW - (anchor ? anchor.x + anchor.w : screenW - 16)) }
      : { left: Math.max(12, Math.min(anchor ? anchor.x : 16, screenW - CARD_W - 12)) };

  return (
    <>
      <TouchableOpacity
        ref={btnRef}
        onPress={openMenu}
        activeOpacity={0.8}
        hitSlop={10}
        style={style}
        testID="logo-menu-btn"
      >
        {/* The glass for this button is provided by the page-level backing that
            wraps LogoMenu (e.g. mapLogoBacking on the map) — NOT here. A GlassFill
            inside would stack a second glass layer under the outer one and render
            a darker inner disc. So the logo mark sits directly on the backing glass. */}
        <ConvoyLogo size={size} />
      </TouchableOpacity>

      <Modal
        visible={open}
        transparent
        animationType="none"
        onRequestClose={() => closeMenu()}
      >
        {/* Backdrop — tap anywhere outside the card to dismiss. */}
        <Pressable style={styles.backdrop} onPress={() => closeMenu()}>
          <Animated.View pointerEvents="none" style={[styles.backdropFill, { opacity: drop }]} />
          {/* Card — drops down from under the logo (slide + scale + fade). The
              inner Pressable stops taps inside from closing the menu. */}
          <Animated.View
            style={[
              styles.card,
              { top },
              horiz,
              { borderColor: cardBorder },
              {
                opacity: drop,
                transform: [
                  { translateY: drop.interpolate({ inputRange: [0, 1], outputRange: [-14, 0] }) },
                  { scale: drop.interpolate({ inputRange: [0, 1], outputRange: [0.96, 1] }) },
                ],
              },
            ]}
          >
            <Pressable onPress={() => {}}>
              <Text style={styles.sectionLabel}>ON THE ROAD</Text>
              {renderRow(MAP_LAYERS, false)}
              <GhostRow accent={accent} iconWell={iconWell} />
              <View style={styles.sectionDivider} />
              <Text style={styles.sectionLabel}>PLACES</Text>
              {places.map((item, i) => renderRow(item, i === places.length - 1))}
            </Pressable>
          </Animated.View>
        </Pressable>
      </Modal>
    </>
  );
}

/**
 * Ghost mode, flipped in place — the menu stays open. On = ghost (hidden from the
 * crew). Writes through the same setAvatarMode the Visibility & Comms page and the
 * map's avatar panel use, and reads through the same useSettings listener, so all
 * three stay in step. Its own component on purpose: the Modal renders nothing while
 * the menu is closed, so this settings subscription only exists while it is open —
 * the logo button itself never re-renders on unrelated settings writes.
 *
 * The switch claims the touch responder itself (react-native Switch.js sets
 * onStartShouldSetResponder → true), so a tap on it reaches neither the row's
 * Pressable (no double flip) nor the backdrop (no close). Tapping the rest of the
 * row flips it too — a bigger target than the switch alone, from the driver's seat.
 */
function GhostRow({ accent, iconWell }: { accent: string; iconWell: string }) {
  const [settings] = useSettings();
  const ghost = getAvatarMode(settings) === 'ghost';
  const setGhost = (on: boolean) => { void setAvatarMode(on ? 'ghost' : 'visible'); };
  return (
    <Pressable
      style={({ pressed }) => [styles.row, styles.rowLast, pressed && styles.rowPressed]}
      onPress={() => { Haptics.selectionAsync(); setGhost(!ghost); }}
      accessibilityRole="switch"
      accessibilityLabel="Ghost mode"
      accessibilityHint="Hide me from the crew"
      accessibilityState={{ checked: ghost }}
      testID="logo-menu-ghost"
    >
      <View style={[styles.rowIcon, { backgroundColor: iconWell }]}>
        <Ionicons name="eye-off" size={20} color={accent} />
      </View>
      <View style={styles.rowText}>
        <Text style={styles.rowTitle} numberOfLines={1}>Ghost mode</Text>
        <Text style={styles.rowSub} numberOfLines={1}>Hide me from the crew</Text>
      </View>
      {/* Display-only: the ROW is the one control. A live Switch inside the Pressable toggled twice on a
          tap on the switch (onValueChange, then the row's onPress from the re-rendered closure) and
          landed back where it started — seen on the iPhone sim, 2026-09-23. */}
      <View pointerEvents="none">
        <Switch
          value={ghost}
          trackColor={{ false: '#3A3A3C', true: accent }}
          thumbColor="#FFFFFF"
          ios_backgroundColor="#3A3A3C"
        />
      </View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  backdrop: {
    flex: 1,
  },
  backdropFill: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: 'rgba(0,0,0,0.45)',
  },
  card: {
    position: 'absolute',
    width: CARD_W,
    backgroundColor: '#161618',
    borderRadius: 18,
    borderWidth: 1,
    borderColor: 'rgba(45,236,134,0.25)',
    overflow: 'hidden',
    shadowColor: '#000',
    shadowOpacity: 0.5,
    shadowRadius: 24,
    shadowOffset: { width: 0, height: 12 },
    elevation: 24,
  },
  cardHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingHorizontal: 16,
    paddingTop: 14,
    paddingBottom: 10,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: '#2a2a2e',
  },
  cardTitle: { color: '#F4F4F4', fontSize: 16, fontWeight: '700', letterSpacing: 0.2 },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingHorizontal: 16,
    height: 54,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: '#222',
  },
  rowLast: { borderBottomWidth: 0 },
  rowPressed: { opacity: 0.7 },
  rowText: { flex: 1 },
  // rowLabel without its flex:1 — inside the rowText column a flex:1 title would
  // try to grow vertically; the column already takes the row's free width.
  rowTitle: { color: '#F4F4F4', fontSize: 16, fontWeight: '600' },
  rowSub: { color: '#808080', fontSize: 12, marginTop: 2 },
  // Same voice as settingsKit's SectionLabel (textDim, 12/600, 0.6 tracking), inset
  // to the card's 16 px row padding.
  sectionLabel: {
    color: '#808080', fontSize: 12, fontWeight: '600', letterSpacing: 0.6,
    paddingHorizontal: 16, paddingTop: 12, paddingBottom: 4,
  },
  sectionDivider: { height: StyleSheet.hairlineWidth, backgroundColor: '#2a2a2e' },
  rowIcon: {
    width: 36, height: 36, borderRadius: 10,
    backgroundColor: 'rgba(45,236,134,0.10)',
    alignItems: 'center', justifyContent: 'center',
  },
  rowLabel: { flex: 1, color: '#F4F4F4', fontSize: 16, fontWeight: '600' },
});
