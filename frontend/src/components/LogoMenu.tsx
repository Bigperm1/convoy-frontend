import React, { useState } from 'react';
import {
  View, Text, StyleSheet, TouchableOpacity, Modal, Pressable, Platform,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useRouter } from 'expo-router';
import * as Haptics from 'expo-haptics';
import ConvoyLogo from './ConvoyLogo';

const YELLOW = '#FFD60A';

type Item = {
  label: string;
  icon: keyof typeof Ionicons.glyphMap;
  route: string;
};

// The four global destinations behind the logo. Community + Profile both point
// at the Hub for now (Hub already hosts community create/discover/admin and the
// profile editor); they'll be repointed when dedicated screens exist.
const ITEMS: Item[] = [
  { label: 'Garage',    icon: 'car-sport',        route: '/(app)/garage' },
  { label: 'Community', icon: 'people',           route: '/(app)/hub' },
  { label: 'Settings',  icon: 'settings-sharp',   route: '/(app)/settings' },
  { label: 'Profile',   icon: 'person-circle',    route: '/(app)/hub' },
];

type Props = {
  /** Logo button size in px. Defaults to 32. */
  size?: number;
  /** Optional style override for the touchable wrapper. */
  style?: any;
};

/**
 * Global brand-logo button that opens a Garage / Community / Settings / Profile
 * menu. Fully self-contained — owns its own open/close state and renders the
 * menu in a transparent Modal so it floats above any screen layout and a tap
 * outside dismisses it. Drop <LogoMenu /> into any header; no parent state.
 */
export default function LogoMenu({ size = 32, style }: Props) {
  const router = useRouter();
  const [open, setOpen] = useState(false);

  const openMenu = () => {
    Haptics.selectionAsync();
    setOpen(true);
  };

  const go = (route: string) => {
    Haptics.selectionAsync();
    setOpen(false);
    // Defer navigation a tick so the modal close animation doesn't fight the
    // route transition on slower devices.
    setTimeout(() => router.push(route as any), 10);
  };

  return (
    <>
      <TouchableOpacity
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
          {/* Card — stop propagation so taps inside don't close it. */}
          <Pressable style={styles.card} onPress={() => {}}>
            <View style={styles.cardHeader}>
              <ConvoyLogo size={22} />
              <Text style={styles.cardTitle}>Convoy</Text>
            </View>
            {ITEMS.map((item, i) => (
              <TouchableOpacity
                key={item.label}
                style={[styles.row, i === ITEMS.length - 1 && styles.rowLast]}
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
    // Anchor the card to the top-left, just under the status bar, near where
    // the logo lives in the headers.
    paddingTop: Platform.OS === 'ios' ? 96 : 64,
    paddingHorizontal: 16,
    alignItems: 'flex-start',
  },
  card: {
    width: 230,
    backgroundColor: '#161618',
    borderRadius: 18,
    borderWidth: 1,
    borderColor: 'rgba(255,214,10,0.25)',
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
  cardTitle: { color: '#fff', fontSize: 16, fontWeight: '700', letterSpacing: 0.2 },
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
    backgroundColor: 'rgba(255,214,10,0.10)',
    alignItems: 'center', justifyContent: 'center',
  },
  rowLabel: { flex: 1, color: '#fff', fontSize: 16, fontWeight: '600' },
});
