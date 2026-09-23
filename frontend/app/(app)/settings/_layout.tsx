import { Stack } from "expo-router";

// Nested stack for the menu-style Settings: the index (menu) pushes each
// sub-page (Map Mode, Scout & Alerts, Location Services, Legal, …). Registered in
// the (app) Tabs layout as a single hidden screen (name="settings", href:null),
// so all of this navigation happens inside the Settings tab slot.

// The index (menu) is this stack's anchor. Since the 2026-09-23 menu reorganization
// (Jeff) the H menu pushes straight to Map Layers, deep inside this stack; expo-router
// reads this as the layout's initialRouteName (getRoutesCore: `anchor ??
// initialRouteName`), and LogoMenu's push passes { withAnchor: true } so the index is
// laid down UNDER Map Layers and Back lands on the Settings menu. Without withAnchor,
// React Navigation seeds a freshly-mounted stack with the pushed screen alone and
// ignores this setting (@react-navigation/core useNavigationBuilder, getStateFromParams).
export const unstable_settings = { initialRouteName: "index" };

export default function SettingsLayout() {
  return <Stack screenOptions={{ headerShown: false, animation: "slide_from_right" }} />;
}
