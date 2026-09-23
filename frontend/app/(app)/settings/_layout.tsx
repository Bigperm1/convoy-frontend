import { Stack } from "expo-router";

// Nested stack for the menu-style Settings: the index (menu) pushes each
// sub-page (Map Mode, Scout & Alerts, Location Services, Legal, …). Registered in
// the (app) Tabs layout as a single hidden screen (name="settings", href:null),
// so all of this navigation happens inside the Settings tab slot.

// The index (menu) is this stack's anchor: expo-router reads this as the layout's
// initialRouteName (getRoutesCore: `anchor ?? initialRouteName`). It was added for the
// H menu's straight push to Map Layers (2026-09-23 menu reorganization, with
// { withAnchor: true }); Jeff took that row out the same day ("remove that and keep it
// in the settings"), so today every sub-page is reached from this index and nothing
// pushes into the stack from outside. It stays for a future deep link into a sub-page:
// pushed WITH { withAnchor: true }, the index is laid down under it and Back lands on the
// Settings menu. Without withAnchor, React Navigation seeds a freshly-mounted stack with
// the pushed screen alone and ignores this setting (@react-navigation/core
// useNavigationBuilder, getStateFromParams).
export const unstable_settings = { initialRouteName: "index" };

export default function SettingsLayout() {
  return <Stack screenOptions={{ headerShown: false, animation: "slide_from_right" }} />;
}
