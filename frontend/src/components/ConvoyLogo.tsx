// ConvoyLogo — the Hairpin H tile (the app's brand mark button).
//
// ── IT WEARS THE APP SKIN (Jeff, 2026-08-27) ─────────────────────────────────
// "the hairpin logo in the top right corner changes from green to silver to gold
//  based on the skin that is used."
//
// DESIGN.md's carve-out list ("anything pinned to a baked green asset") names the
// WORDMARK and the APP ICON as staying green — and they still do. This tile is
// neither: it is the map/Comms/Music menu BUTTON, i.e. chrome, and the locked rule
// for chrome is that it wears YOUR metal. The app icon on the home screen and the
// green wordmark on the login lockup are untouched.
//
// ── WHY THREE BAKED FILES AND NOT A TINT ─────────────────────────────────────
// The mark is a rendered 3D object — a bevelled H glowing over a black city grid —
// not a flat glyph. `tintColor` flattens every non-transparent pixel to one colour,
// which would delete the bevel, the glow spill and the ground. So the metals are
// baked the same way DESIGN.md records for the tier locks: a green-dominance mask,
// re-metalled with the tier ramp, KEEPING the original bevel's relative luma so the
// mark still reads dimensional. Only the H moves; the ground stays black.
// Generated 2026-08-27 (see the session record for the mask script).
//
// 512², not the original's 1024²: this renders at 32-38pt, so 512 is already ~4x
// the @3x pixel need and saves ~1.1 MB of bundle over two files.

import React from 'react';
import { Image, ImageStyle, StyleProp } from 'react-native';
import { useAppSkin } from '../appSkin';
import type { VisualTier } from '../tierTheme';

// Static requires — Metro needs literal paths, and all three ship in the bundle.
const TILE: Record<VisualTier, any> = {
  brand: require('../../assets/HAIRPIN.png'),
  premium: require('../../assets/HAIRPIN-silver.png'),
  ultra: require('../../assets/HAIRPIN-gold.png'),
};

interface Props {
  size?: number;
  style?: StyleProp<ImageStyle>;
  /** Force a metal. Omit (the normal case) to follow the driver's app skin. */
  tier?: VisualTier;
}

export default function ConvoyLogo({ size = 120, style, tier }: Props) {
  const skin = useAppSkin();
  const t = tier ?? skin;
  return (
    <Image
      source={TILE[t] ?? TILE.brand}
      style={[{ width: size, height: size, borderRadius: size * 0.28 }, style]}
      resizeMode="cover"
    />
  );
}
