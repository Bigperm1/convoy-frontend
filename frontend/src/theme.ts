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
  brand: "#FFD60A", // Convoy yellow — the logo/mic accent, our signature color
  brandDim: "#FFC700",
  accent: "#5E5CE6", // indigo
  success: "#30D158",
  warning: "#FF9F0A",
  danger: "#FF453A",
  text: "#F4F4F4",
  textDim: "#808080",
  textMute: "#808080",
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
