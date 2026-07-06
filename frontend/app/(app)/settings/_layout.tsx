import { Stack } from "expo-router";

// Nested stack for the menu-style Settings: the index (menu) pushes each
// sub-page (Map Mode, Scout Voice, Location Services, Legal, …). Registered in
// the (app) Tabs layout as a single hidden screen (name="settings", href:null),
// so all of this navigation happens inside the Settings tab slot.
export default function SettingsLayout() {
  return <Stack screenOptions={{ headerShown: false, animation: "slide_from_right" }} />;
}
