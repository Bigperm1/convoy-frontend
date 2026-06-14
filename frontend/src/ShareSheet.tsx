import React, { useEffect, useState, useCallback } from "react";
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  Modal,
  ScrollView,
  ActivityIndicator,
  Platform,
} from "react-native";
import { Image } from "expo-image";
import { Ionicons } from "@expo/vector-icons";
import { BlurView } from "expo-blur";
import * as Haptics from "expo-haptics";
import { COLORS } from "./theme";
import { api, formatErr } from "./api";
import { getSettings } from "./settings";
import { getVehiclePngOrDefault } from "./vehicleAssets";

// A share payload is discriminated by `kind`. The music player passes a
// "music" payload; the map (routes) and comms screens can reuse this same
// sheet later by passing "route" / "comm" payloads.
export type SharePayload =
  | { kind: "music"; title?: string; artist?: string; url?: string; artworkUrl?: string }
  | { kind: "route"; name?: string; dest_label?: string; dest_lat?: number; dest_lng?: number; polyline?: string }
  | { kind: "comm"; id?: string; channel?: string };

type Member = {
  id: string;
  handle: string;
  car_color?: string;
  car_make?: string;
  car_model?: string;
  is_admin?: boolean;
};

type Props = {
  visible: boolean;
  onClose: () => void;
  share: SharePayload | null;
};

/**
 * Slide-up "share to members" sheet. On open it resolves the user's active
 * community (falling back to their first community), pulls the member roster
 * via GET /communities/{id}, and lets the user multi-select drivers to push
 * the current item to. Members are shown by their car (their identity in
 * Convoy) + handle. Delivery is POST /notifications/share (WS + push).
 */
export default function ShareSheet({ visible, onClose, share }: Props) {
  const [members, setMembers] = useState<Member[]>([]);
  const [communityId, setCommunityId] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [sending, setSending] = useState(false);
  const [sent, setSent] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    if (!visible) return;
    setSelected(new Set());
    setSent(false);
    setErr(null);
    let cancelled = false;
    (async () => {
      setLoading(true);
      try {
        const s = await Promise.resolve().then(() => getSettings()).catch(() => null as any);
        // Resolve which community's roster to show: the active one if set,
        // otherwise the user's first community.
        let cid: string | null = s?.activeCommunityId ?? null;
        if (!cid) {
          const { data } = await api.get("/communities/mine");
          cid = Array.isArray(data) && data[0]?.id ? data[0].id : null;
        }
        if (!cid) {
          if (!cancelled) {
            setCommunityId(null);
            setMembers([]);
          }
          return;
        }
        // Roster + our own id (to drop ourselves from the list).
        const [meRes, cRes] = await Promise.all([
          api.get("/auth/me").catch(() => ({ data: null as any })),
          api.get(`/communities/${cid}`),
        ]);
        const myId: string | undefined = meRes?.data?.id;
        const roster: Member[] = (cRes?.data?.members_users || []).filter(
          (m: Member) => m && m.id && m.id !== myId
        );
        if (!cancelled) {
          setCommunityId(cid);
          setMembers(roster);
        }
      } catch (e) {
        if (!cancelled) setErr(formatErr(e));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [visible]);

  const toggle = useCallback((id: string) => {
    Haptics.selectionAsync().catch(() => {});
    setSelected((cur) => {
      const next = new Set(cur);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  // Select-all / clear toggle for the whole roster.
  const toggleAll = useCallback(() => {
    Haptics.selectionAsync().catch(() => {});
    setSelected((cur) => (cur.size >= members.length ? new Set() : new Set(members.map((m) => m.id))));
  }, [members]);

  const doShare = useCallback(async () => {
    if (!share || selected.size === 0 || sending) return;
    setSending(true);
    setErr(null);
    try {
      const { kind, ...payload } = share as any;
      await api.post("/notifications/share", {
        target_user_ids: Array.from(selected),
        kind,
        // Stamp WHEN it was shared so recipients can show "shared X ago" (who
        // comes from the sender identity the backend attaches to the event).
        payload: { ...payload, shared_at: Date.now() },
        community_id: communityId,
      });
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => {});
      setSent(true);
      setTimeout(() => onClose(), 900);
    } catch (e) {
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning).catch(() => {});
      setErr(formatErr(e));
    } finally {
      setSending(false);
    }
  }, [share, selected, sending, communityId, onClose]);

  const allSelected = members.length > 0 && selected.size === members.length;
  const kindLabel = share?.kind === "route" ? "route" : share?.kind === "comm" ? "clip" : "song";
  const headline =
    share?.kind === "music"
      ? (share as any).title || "Share this song"
      : share?.kind === "route"
        ? (share as any).name || (share as any).dest_label || "Share this route"
        : "Share this clip";

  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      <View style={styles.root}>
        <TouchableOpacity style={styles.backdrop} activeOpacity={1} onPress={onClose} />
        <View style={styles.sheet}>
          {Platform.OS !== "web" ? (
            <BlurView tint="dark" intensity={60} style={StyleSheet.absoluteFill} />
          ) : (
            <View style={[StyleSheet.absoluteFill, { backgroundColor: "rgba(18,18,22,0.97)" }]} />
          )}
          <View style={styles.grabber} />

          <View style={styles.header}>
            <View style={{ flex: 1 }}>
              <Text style={styles.title}>Share {kindLabel}</Text>
              <Text style={styles.sub} numberOfLines={1}>{headline}</Text>
            </View>
            <TouchableOpacity onPress={onClose} style={styles.closeBtn}>
              <Ionicons name="close" size={20} color={COLORS.text} />
            </TouchableOpacity>
          </View>

          {!loading && members.length > 0 && (
            <TouchableOpacity onPress={toggleAll} style={styles.selectAllRow} activeOpacity={0.7}>
              <Ionicons name={allSelected ? "checkmark-circle" : "ellipse-outline"} size={20} color={allSelected ? COLORS.brand : COLORS.textDim} />
              <Text style={styles.selectAllText}>{allSelected ? "Deselect all" : "Select all"}</Text>
              <Text style={styles.selectAllCount}>{members.length}</Text>
            </TouchableOpacity>
          )}

          {loading ? (
            <ActivityIndicator color={COLORS.brand} style={{ marginVertical: 36 }} />
          ) : members.length === 0 ? (
            <Text style={styles.empty}>
              {communityId
                ? "No other members in this community yet."
                : "Join a community to share with members."}
            </Text>
          ) : (
            <ScrollView style={{ maxHeight: 340 }} contentContainerStyle={{ paddingBottom: 8 }}>
              {members.map((m) => {
                const on = selected.has(m.id);
                const car = [m.car_make, m.car_model].filter(Boolean).join(" ");
                return (
                  <TouchableOpacity
                    key={m.id}
                    style={[styles.row, on && styles.rowOn]}
                    onPress={() => toggle(m.id)}
                    activeOpacity={0.7}
                  >
                    <View style={styles.avatarWrap}>
                      <Image
                        source={getVehiclePngOrDefault(m.car_color)}
                        style={styles.avatar}
                        contentFit="contain"
                      />
                    </View>
                    <View style={{ flex: 1 }}>
                      <Text style={styles.handle} numberOfLines={1}>
                        {m.handle || "Driver"}
                        {m.is_admin ? "  ·  admin" : ""}
                      </Text>
                      {!!car && (
                        <Text style={styles.car} numberOfLines={1}>{car}</Text>
                      )}
                    </View>
                    <Ionicons
                      name={on ? "checkmark-circle" : "ellipse-outline"}
                      size={24}
                      color={on ? COLORS.brand : COLORS.textDim}
                    />
                  </TouchableOpacity>
                );
              })}
            </ScrollView>
          )}

          {!!err && <Text style={styles.err}>{err}</Text>}

          <TouchableOpacity
            style={[
              styles.shareBtn,
              (selected.size === 0 || sending || sent) && styles.shareBtnDim,
              sent && styles.shareBtnSent,
            ]}
            onPress={doShare}
            disabled={selected.size === 0 || sending || sent}
            activeOpacity={0.85}
          >
            <Ionicons name={sent ? "checkmark-circle" : "paper-plane"} size={18} color={sent ? "#fff" : "#1a1a1a"} />
            <Text style={[styles.shareText, !sent && { color: "#1a1a1a" }]}>
              {sent
                ? "Shared!"
                : sending
                  ? "Sharing…"
                  : selected.size > 0
                    ? `Share with ${selected.size}`
                    : "Select members"}
            </Text>
          </TouchableOpacity>
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, justifyContent: "flex-end" },
  backdrop: { ...StyleSheet.absoluteFillObject, backgroundColor: "rgba(0,0,0,0.55)" },
  sheet: {
    borderTopLeftRadius: 24,
    borderTopRightRadius: 24,
    overflow: "hidden",
    paddingHorizontal: 18,
    paddingTop: 10,
    paddingBottom: Platform.OS === "ios" ? 34 : 20,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderColor: "rgba(255,255,255,0.18)",
  },
  grabber: {
    alignSelf: "center",
    width: 40,
    height: 5,
    borderRadius: 3,
    backgroundColor: "rgba(255,255,255,0.25)",
    marginBottom: 12,
  },
  header: { flexDirection: "row", alignItems: "center", gap: 12, marginBottom: 10 },
  title: { color: COLORS.text, fontSize: 18, fontWeight: "800", letterSpacing: -0.3 },
  sub: { color: COLORS.textDim, fontSize: 13, marginTop: 2 },
  closeBtn: {
    width: 32,
    height: 32,
    borderRadius: 16,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "rgba(255,255,255,0.10)",
  },
  empty: { color: COLORS.textDim, fontSize: 14, textAlign: "center", paddingVertical: 34, paddingHorizontal: 10 },
  selectAllRow: { flexDirection: "row", alignItems: "center", gap: 8, paddingVertical: 8, paddingHorizontal: 10, marginBottom: 2 },
  selectAllText: { color: COLORS.text, fontSize: 14, fontWeight: "700", flex: 1 },
  selectAllCount: { color: COLORS.textDim, fontSize: 13, fontWeight: "600" },
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    paddingVertical: 9,
    paddingHorizontal: 10,
    borderRadius: 14,
    marginBottom: 4,
  },
  rowOn: { backgroundColor: "rgba(255,214,10,0.16)" },
  avatarWrap: {
    width: 46,
    height: 46,
    borderRadius: 23,
    backgroundColor: "rgba(255,255,255,0.08)",
    alignItems: "center",
    justifyContent: "center",
    overflow: "hidden",
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: "rgba(255,255,255,0.18)",
  },
  avatar: { width: 38, height: 38 },
  handle: { color: COLORS.text, fontSize: 15, fontWeight: "700" },
  car: { color: COLORS.textDim, fontSize: 12, marginTop: 1 },
  err: { color: "#FF6B6B", fontSize: 13, marginTop: 8, marginHorizontal: 4 },
  shareBtn: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
    backgroundColor: COLORS.brand,
    paddingVertical: 15,
    borderRadius: 16,
    marginTop: 12,
  },
  shareBtnDim: { opacity: 0.5 },
  shareBtnSent: { backgroundColor: COLORS.success },
  shareText: { color: "#fff", fontWeight: "800", fontSize: 15, letterSpacing: 0.2 },
});
