// Placeholder route for the "voice" tab. The actual interaction is the elevated mic CTA
// in the tab bar (see VoiceTabButton). Pressing the button records audio in place — it does
// NOT navigate here. If a user lands here via deep-link, send them back to the map.
import { Redirect } from "expo-router";
export default function VoicePlaceholder() {
  return <Redirect href="/(app)/map" />;
}
