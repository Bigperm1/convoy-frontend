import React, { useRef, useState } from 'react';
import {
  View, Text, StyleSheet, TouchableOpacity, Modal, Pressable, Platform, Dimensions,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useRouter } from 'expo-router';
import * as Haptics from 'expo-haptics';
import ConvoyLogo from './ConvoyLogo';
import { useAuth } from '../auth';

const YELLOW = '#2DEC86';
const OWNER_EMAIL = 'jwellsmorton@gmail.com';
const CARD_W = 230;
const GAP = 8; // gap between the logo's bottom and the dropdown's top

type Item = {
  label: string;
  icon: keyof typeof Ionicons.glyphMap;
  route: string;
};

// The global destinations behind the logo. Community points at the Hub (which
// hosts community create/discover/admin); the Admin row is appended at runtime
// for the owner only (see below).
const ITEMS: Item[] = [
  { label: 'Garage',    icon: 'car-sport',        route: '/(app)/garage' },
  { label: 'Community', icon: 'people',           route: '/(app)/hub' },
  { label: 'Settings',  icon: 'settings-sharp',   route: '/(app)/settings' },
];

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
 * Global brand-logo button that opens a Garage / Community / Settings menu.
 * On open it measures the logo's on-screen position and drops the dropdown just
 * beneath it — so the menu's top lines up with the header's divider line — then
 * anchors it to the left or right edge per `align`. Self-contained: renders in a
 * transparent Modal so it floats above any screen and a tap outside dismisses.
 */
export default function LogoMenu({ size = 32, style, align = 'left' }: Props) {
  const router = useRouter();
  const { user } = useAuth();
  const [open, setOpen] = useState(false);
  const btnRef = useRef<any>(null);
  const [anchor, setAnchor] = useState<{ x: number; y: number; w: number; h: number } | null>(null);

  // Owner-only Admin entry (roster + password resets). Appended to the menu
  // only for the app owner's account so regular drivers never see it.
  const isOwner = (user?.email || '').trim().toLowerCase() === OWNER_EMAIL;
  const items: Item[] = isOwner
    ? [...ITEMS, { label: 'Admin', icon: 'shield-checkmark', route: '/(app)/admin' }]
    : ITEMS;

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

  const go = (route: string) => {
    Haptics.selectionAsync();
    setOpen(false);
    // Defer navigation a tick so the modal close animation doesn't fight the
    // route transition on slower devices.
    setTimeout(() => router.push(route as any), 10);
  };

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
        <ConvoyLogo size={size} />
      </TouchableOpacity>

      <Modal
        visible={open}
        transparent
        animationType="fade"
        onRequestClose={() => setOpen(false)}
      >
        {/* Backdrop — tap anywhere outside the card to dismiss. */}
        <Pressable style={styles.backdrop} onPress={() => setOpen(false)}>
          {/* Card — absolutely positioned under the logo; stop propagation so
              taps inside don't close it. */}
          <Pressable style={[styles.card, { top }, horiz]} onPress={() => {}}>
            <View style={styles.cardHeader}>
              <ConvoyLogo size={22} />
              <Text style={styles.cardTitle}>Convoy</Text>
            </View>
            {items.map((item, i) => (
              <TouchableOpacity
                key={item.label}
                style={[styles.row, i === items.length - 1 && styles.rowLast]}
                activeOpacity={0.7}
                onPress={() => go(item.route)}
                testID={`logo-menu-${item.label.toLowerCase()}`}
              >
                <View style={styles.rowIcon}>
                  <Ionicons name={item.icon} size={20} color={YELLOW} />
                </View>
                <Text style={styles.rowLabel}>{item.label}</Text>
                <Ionicons name="chevron-forward" size={18} color="#555" />
              </TouchableOpacity>
            ))}
          </Pressable>
        </Pressable>
      </Modal>
    </>
  );
}

const styles = StyleSheet.create({
  backdrop: {
    flex: 1,
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
  rowIcon: {
    width: 36, height: 36, borderRadius: 10,
    backgroundColor: 'rgba(45,236,134,0.10)',
    alignItems: 'center', justifyContent: 'center',
  },
  rowLabel: { flex: 1, color: '#F4F4F4', fontSize: 16, fontWeight: '600' },
});
