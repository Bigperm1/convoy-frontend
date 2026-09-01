// Apple-inspired liquid glass dark theme
export const COLORS = {
  bg: "#000000",
  bgElev: "#0C0C0E",
  surface: "rgba(28,28,30,0.72)",
  surfaceSolid: "#1C1C1E",
  surface2: "rgba(44,44,46,0.6)",
  hairline: "rgba(255,255,255,0.08)",
  hairlineStrong: "rgba(255,255,255,0.16)",
  primary: "#0A84FF", // system blue
  primaryDim: "#0064D1",
  brand: "#2DEC86", // Convoy green — the logo/mic accent, our signature color (from new_logo_icons.png)
  brandDim: "#00C46A",
  accent: "#5E5CE6", // indigo
  success: "#30D158",
  warning: "#FF9F0A",
  danger: "#FF453A",
  text: "#F4F4F4",
  textDim: "#808080",
  textMute: "#808080",
};

// ── ACTION COLOURS — one meaning per colour, everywhere in the app ──────────────
// Jeff, 2026-08-31: "make the bookmark candy red and the share system green so they
// stick out more... make this system wide."
//
// These two actions sit side by side in the drive sheet header and used to be the same
// off-white as the close button — three identical glyphs, none of them readable at a
// glance from the driver's seat. Colour is the fastest thing the eye resolves, so save
// and share each get one and keep it on every surface they appear on.
//
// NOT tier colours: gold and silver mean an entitlement (see src/tierTheme.ts and
// DESIGN.md) and must never be spent on an ordinary button. These are the same candy red
// and brand green already used by End and the turn-by-turn tile, so the app keeps ONE
// red and ONE green rather than accumulating a second set.
export const ACTION = {
  // Candy red — the bright top of the End button's ramp.
  save: "#FF3B5C",
  // Brand green, straight from COLORS.brand.
  share: "#2DEC86",
};

export const FONT = {
  // System font on iOS = San Francisco; on Android = Roboto.
  // Using undefined lets RN pick the default system font.
  display: undefined as any,
  text: undefined as any,
};

export const SHADOW = {
  glass: {
    shadowColor: "#000",
    shadowOpacity: 0.5,
    shadowRadius: 24,
    shadowOffset: { width: 0, height: 12 },
    elevation: 8,
  },
  glow: (color: string) => ({
    shadowColor: color,
    shadowOpacity: 0.55,
    shadowRadius: 16,
    shadowOffset: { width: 0, height: 0 },
    elevation: 6,
  }),
};
