import React, { useEffect, useRef, useState } from "react";
import { View, Text, StyleSheet, Animated, Easing, Platform } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { BlurView } from "expo-blur";
import { useRouter, usePathname } from "expo-router";
import { COLORS } from "./theme";
import { voiceBus, VoiceCommand } from "./voiceBus";

// Maps intent → tab route. Used for global "open_*" voice intents.
// Note: "open_drive" intentionally omitted — the Drive tab was replaced by the elevated voice CTA.
const ROUTE_MAP: Record<string, string> = {
  open_map: "/(app)/map",
  open_talk: "/(app)/talk",
  open_music: "/(app)/music",
  open_hub: "/(app)/hub",
};

type BannerState = {
  text: string;
  intent: string | null;
  query?: string;
} | null;

const intentLabel = (intent: string | null, query?: string) => {
  if (!intent) return null;
  if (intent === "navigate_to") return query ? `Navigating to ${query}` : "Navigating…";
  if (intent === "clear_route") return "Cleared route";
  if (intent === "report_police") return "Reporting Police";
  if (intent === "report_accident") return "Reporting Accident";
  if (intent === "report_road") return "Reporting Hazard";
  if (intent === "report_traffic") return "Reporting Traffic";
  if (intent === "open_map") return "Opening Map";
  if (intent === "open_talk") return "Opening Talk";
  if (intent === "open_drive") return "Opening Drive";
  if (intent === "open_music") return "Opening Music";
  if (intent === "open_hub") return "Opening Hub";
  return null;
};

export default function VoiceController() {
  const router = useRouter();
  const pathname = usePathname();
  const [banner, setBanner] = useState<BannerState>(null);
  const opacity = useRef(new Animated.Value(0)).current;
  const translateY = useRef(new Animated.Value(-20)).current;
  const hideTimer = useRef<any>(null);

  useEffect(() => {
    const unsubscribe = voiceBus.subscribe((cmd: VoiceCommand) => {
      // Route screen-switch intents globally
      if (cmd.intent && ROUTE_MAP[cmd.intent]) {
        router.push(ROUTE_MAP[cmd.intent] as any);
      }
      // Show banner with transcript + recognized action
      setBanner({ text: cmd.text || "", intent: cmd.intent, query: cmd.query });
    });
    return unsubscribe;
  }, [router]);

  useEffect(() => {
    if (!banner) return;
    Animated.parallel([
      Animated.timing(opacity, { toValue: 1, duration: 220, useNativeDriver: true }),
      Animated.timing(translateY, { toValue: 0, duration: 260, easing: Easing.out(Easing.cubic), useNativeDriver: true }),
    ]).start();
    if (hideTimer.current) clearTimeout(hideTimer.current);
    hideTimer.current = setTimeout(() => {
      Animated.parallel([
        Animated.timing(opacity, { toValue: 0, duration: 220, useNativeDriver: true }),
        Animated.timing(translateY, { toValue: -20, duration: 220, useNativeDriver: true }),
      ]).start(() => setBanner(null));
    }, 3200);
    return () => { if (hideTimer.current) clearTimeout(hideTimer.current); };
  }, [banner, opacity, translateY]);

  // Hide voice FAB on auth screens or where user is typing keyboards a lot (login/signup handled by route group)
  // (app) layout already gates this, so we trust we're in app-level.

  const action = banner ? intentLabel(banner.intent, banner.query) : null;
  const showBanner = !!banner && (!!banner.text || !!action);

  return (
    <>
      {/* Non-blocking transcript banner — the elevated mic CTA in the tab bar is the input */}
      {showBanner && (
        <Animated.View
          pointerEvents="none"
          style={[
            styles.bannerWrap,
            { opacity, transform: [{ translateY }] },
          ]}
        >
          <View style={styles.banner}>
            {Platform.OS === "ios" ? (
              <BlurView tint="dark" intensity={70} style={StyleSheet.absoluteFill} />
            ) : (
              <View style={[StyleSheet.absoluteFill, { backgroundColor: "rgba(20,20,22,0.92)" }]} />
            )}
            <View style={styles.bannerInner}>
              <View style={styles.bannerIcon}>
                <Ionicons
                  name={banner!.intent ? "checkmark-circle" : "mic"}
                  size={20}
                  color={COLORS.brand}
                />
              </View>
              <View style={{ flex: 1 }}>
                {!!banner!.text && (
                  <Text style={styles.transcript} numberOfLines={1}>"{banner!.text}"</Text>
                )}
                <Text style={[styles.action, { color: banner!.intent ? COLORS.brand : COLORS.textDim }]} numberOfLines={1}>
                  {action || "No command recognized"}
                </Text>
              </View>
            </View>
          </View>
        </Animated.View>
      )}
    </>
  );
}

const styles = StyleSheet.create({
  bannerWrap: {
    position: "absolute",
    // Sits just BELOW the floating search bar (ends ~y100 iOS / ~76 Android) and
    // the live pill beneath it, so the transcript banner is readable instead of
    // tucked up under the dynamic island where it was easy to miss.
    top: Platform.OS === "ios" ? 132 : 108,
    left: 12, right: 12,
    alignItems: "center",
    zIndex: 9999,
  },
  banner: {
    overflow: "hidden",
    borderRadius: 16,
    borderWidth: 1,
    borderColor: "rgba(45,236,134,0.35)",
    width: "100%",
    maxWidth: 460,
  },
  bannerInner: { flexDirection: "row", alignItems: "center", padding: 12, gap: 10 },
  bannerIcon: {
    width: 32, height: 32, borderRadius: 16,
    alignItems: "center", justifyContent: "center",
    backgroundColor: "rgba(45,236,134,0.16)",
  },
  transcript: { color: COLORS.text, fontSize: 13, fontWeight: "500" },
  action: { fontSize: 12, marginTop: 2, fontWeight: "600", letterSpacing: 0.2 },
});
