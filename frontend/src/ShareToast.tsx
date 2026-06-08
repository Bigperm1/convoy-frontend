import React, { useEffect, useRef, useState, useCallback } from "react";
import { Animated, StyleSheet, Text, TouchableOpacity, View, Platform } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { BlurView } from "expo-blur";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useRouter } from "expo-router";
import * as Haptics from "expo-haptics";
import { COLORS } from "./theme";
import { shareBus, type ShareEvent, type ShareKind } from "./shareBus";
import { shareInbox } from "./shareInbox";

const KIND_ICON: Record<ShareKind, any> = {
  music: "musical-notes",
  route: "navigate",
  comm: "mic",
};
const KIND_TAB: Record<ShareKind, string> = {
  music: "/(app)/music",
  route: "/(app)/map",
  comm: "/(app)/talk",
};
const KIND_CTA: Record<ShareKind, string> = {
  music: "Open",
  route: "View",
  comm: "Listen",
};

/**
 * Global toast for an incoming share (a member sent you a song / route / clip).
 * Mounted once in the (app) layout so it appears on any tab. Fed by `shareBus`,
 * which both the live WebSocket frame (livePtt.ts) and the foreground push
 * handler (_layout.tsx) emit to. Tapping it routes to the relevant tab.
 */
export default function ShareToast() {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const [event, setEvent] = useState<ShareEvent | null>(null);
  const slide = useRef(new Animated.Value(-140)).current;
  const hideTimer = useRef<any>(null);
  const lastKey = useRef<string>("");
  const lastAt = useRef<number>(0);

  const dismiss = useCallback(() => {
    if (hideTimer.current) clearTimeout(hideTimer.current);
    Animated.timing(slide, { toValue: -140, duration: 220, useNativeDriver: true }).start(
      () => setEvent(null)
    );
  }, [slide]);

  // Subscribe to the bus. Dedup identical events arriving within 4s — the WS
  // frame and the push notification can both fire for the same share.
  useEffect(() => {
    return shareBus.on((e) => {
      const key = `${e.fromId}|${e.kind}|${e?.payload?.title || e?.payload?.name || ""}`;
      const now = Date.now();
      if (key === lastKey.current && now - lastAt.current < 4000) return;
      lastKey.current = key;
      lastAt.current = now;
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => {});
      setEvent(e);
    });
  }, []);

  // Animate in + auto-dismiss after 5s whenever a new event lands.
  useEffect(() => {
    if (!event) return;
    Animated.spring(slide, { toValue: 0, useNativeDriver: true, friction: 8, tension: 70 }).start();
    if (hideTimer.current) clearTimeout(hideTimer.current);
    hideTimer.current = setTimeout(dismiss, 5000);
    return () => {
      if (hideTimer.current) clearTimeout(hideTimer.current);
    };
  }, [event, slide, dismiss]);

  if (!event) return null;

  const k = event.kind;
  const p = event.payload || {};
  const what =
    k === "music"
      ? p.title
        ? `${p.title}${p.artist ? "  ·  " + p.artist : ""}`
        : "a song"
      : k === "route"
        ? p.name || p.dest_label || "a route"
        : "a clip";
  const verb = k === "route" ? "shared a route" : k === "comm" ? "shared a clip" : "shared a song";

  const open = () => {
    dismiss();
    // Stash the payload so the destination screen can act on it (route → set
    // destination + Drive preview; music → search + play), then ping in case
    // that screen is already mounted, and navigate to its tab.
    if (k === "route" && typeof p.dest_lat === "number" && typeof p.dest_lng === "number") {
      shareInbox.setRoute({ lat: p.dest_lat, lng: p.dest_lng, label: p.dest_label || p.name || "Shared route" });
    } else if (k === "music" && (p.title || p.url)) {
      shareInbox.setMusic({ title: p.title, artist: p.artist, url: p.url });
    } else if (k === "comm" && p.id) {
      shareInbox.setComm({ id: p.id, channel: p.channel });
    }
    router.push((KIND_TAB[k] || "/(app)/map") as any);
    shareInbox.ping();
  };

  return (
    <Animated.View
      style={[styles.wrap, { top: insets.top + 8, transform: [{ translateY: slide }] }]}
      pointerEvents="box-none"
    >
      <View style={styles.card}>
        {Platform.OS !== "web" ? (
          <BlurView tint="dark" intensity={64} style={StyleSheet.absoluteFill} />
        ) : (
          <View style={[StyleSheet.absoluteFill, { backgroundColor: "rgba(20,20,24,0.96)" }]} />
        )}
        <View style={styles.iconWrap}>
          <Ionicons name={KIND_ICON[k] || "share-social"} size={20} color="#fff" />
        </View>
        <TouchableOpacity activeOpacity={0.85} style={{ flex: 1 }} onPress={open}>
          <Text style={styles.from} numberOfLines={1}>
            {event.fromHandle || "A driver"} {verb}
          </Text>
          <Text style={styles.what} numberOfLines={1}>{what}</Text>
        </TouchableOpacity>
        <TouchableOpacity onPress={open} style={styles.cta} activeOpacity={0.85}>
          <Text style={styles.ctaText}>{KIND_CTA[k] || "Open"}</Text>
        </TouchableOpacity>
        <TouchableOpacity onPress={dismiss} hitSlop={8} style={styles.close}>
          <Ionicons name="close" size={18} color={COLORS.textDim} />
        </TouchableOpacity>
      </View>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  wrap: { position: "absolute", left: 12, right: 12, zIndex: 100 },
  card: {
    flexDirection: "row",
    alignItems: "center",
    gap: 11,
    paddingHorizontal: 12,
    paddingVertical: 11,
    borderRadius: 16,
    overflow: "hidden",
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: "rgba(255,255,255,0.16)",
    shadowColor: "#000",
    shadowOpacity: 0.4,
    shadowRadius: 12,
    shadowOffset: { width: 0, height: 6 },
    elevation: 12,
  },
  iconWrap: {
    width: 38,
    height: 38,
    borderRadius: 19,
    backgroundColor: COLORS.primary,
    alignItems: "center",
    justifyContent: "center",
  },
  from: { color: COLORS.textDim, fontSize: 12, fontWeight: "600" },
  what: { color: COLORS.text, fontSize: 15, fontWeight: "700", marginTop: 1 },
  cta: {
    backgroundColor: "rgba(255,255,255,0.14)",
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderRadius: 10,
  },
  ctaText: { color: "#fff", fontWeight: "800", fontSize: 13 },
  close: { padding: 2 },
});
