// External alerts feed (Waze-style) — foreground polling + background-fetch best-effort.
//
// Architecture:
//   - useExternalAlerts(intervalMs) hook: fetches /api/feed/external every 60s while focused,
//     dedups by stable id, and clears alerts no longer present in feed.
//   - Background task (registerExternalFeedTask): registered once at app start so iOS/Android
//     can attempt polls even when the app is backgrounded. Note: Expo Go has limited background
//     support (iOS min ~15min, Android ~15min). Real-time polling = foreground.

import { useCallback, useEffect, useRef, useState } from "react";
import { AppState, Platform } from "react-native";
import { api } from "./api";
import { useSettings, feedsQuery } from "./settings";

export type ExternalAlertType =
  | "POLICE" | "ACCIDENT" | "JAM" | "HAZARD" | "CONSTRUCTION" | "WEATHER" | "OTHER";

export type ExternalAlert = {
  id: string;
  type: ExternalAlertType;
  raw_type: string;
  subtype?: string;
  lat: number;
  lng: number;
  ts: number;
};

export type FeedStatus = "idle" | "polling" | "ok" | "error";

type FeedResponse = {
  alerts: ExternalAlert[];
  count: number;
  fetched_at: string;
  source: string;
  upstream_status: string;
  upstream_error: string | null;
};

const DEFAULT_INTERVAL_MS = 60_000;

export function useExternalAlerts(intervalMs: number = DEFAULT_INTERVAL_MS) {
  const [settings] = useSettings();
  // Map keyed by stable alert id. Polling replaces this map → React reconciliation removes
  // markers that disappeared from the feed (auto-clear behavior).
  const [alertsById, setAlertsById] = useState<Record<string, ExternalAlert>>({});
  const [status, setStatus] = useState<FeedStatus>("idle");
  const [lastFetched, setLastFetched] = useState<string | null>(null);
  const [upstreamStatus, setUpstreamStatus] = useState<string>("ok");
  const [upstreamError, setUpstreamError] = useState<string | null>(null);
  const timerRef = useRef<any>(null);
  const inFlightRef = useRef(false);
  const mountedRef = useRef(true);

  const feedsParam = feedsQuery(settings);

  const fetchOnce = useCallback(async () => {
    if (inFlightRef.current) return;
    // No feeds enabled → clear and bail
    if (!feedsParam) {
      setAlertsById({});
      setStatus("idle");
      return;
    }
    inFlightRef.current = true;
    setStatus((s) => (s === "ok" ? s : "polling"));
    try {
      const { data } = await api.get<FeedResponse>(`/feed/external?feeds=${encodeURIComponent(feedsParam)}`);
      if (!mountedRef.current) return;
      const next: Record<string, ExternalAlert> = {};
      for (const a of data.alerts || []) next[a.id] = a;
      setAlertsById(next);
      setLastFetched(data.fetched_at);
      setUpstreamStatus(data.upstream_status || "ok");
      setUpstreamError(data.upstream_error || null);
      setStatus(data.upstream_status === "ok" ? "ok" : "error");
    } catch (e: any) {
      if (!mountedRef.current) return;
      setStatus("error");
      setUpstreamStatus("network_error");
      setUpstreamError(e?.message || "fetch failed");
    } finally {
      inFlightRef.current = false;
    }
  }, [feedsParam]);

  // Polling lifecycle — pauses while backgrounded, resumes on foreground.
  useEffect(() => {
    mountedRef.current = true;

    const start = () => {
      if (timerRef.current) return;
      fetchOnce();
      timerRef.current = setInterval(fetchOnce, intervalMs);
    };
    const stop = () => {
      if (timerRef.current) {
        clearInterval(timerRef.current);
        timerRef.current = null;
      }
    };

    start();

    const sub = AppState.addEventListener("change", (state) => {
      if (state === "active") start();
      else stop();
    });

    return () => {
      mountedRef.current = false;
      stop();
      sub.remove();
    };
  }, [fetchOnce, intervalMs]);

  return {
    alerts: Object.values(alertsById),
    alertsById,
    status,
    lastFetched,
    upstreamStatus,
    upstreamError,
    refresh: fetchOnce,
  };
}

// ---------- Background fetch (best-effort) ----------
// Registered once from App layout. iOS / Android may schedule it ~15min cadence.
// In Expo Go the support is limited — full reliability needs an EAS dev build.

const BG_TASK_NAME = "convoy-external-feed-bg";

let _bgRegistered = false;
export async function registerExternalFeedBackgroundTask(): Promise<void> {
  if (Platform.OS === "web" || _bgRegistered) return;
  try {
    const TaskManager = await import("expo-task-manager");
    const BackgroundFetch = await import("expo-background-fetch");

    if (!TaskManager.isTaskDefined(BG_TASK_NAME)) {
      TaskManager.defineTask(BG_TASK_NAME, async () => {
        try {
          await api.get("/feed/external");
          return BackgroundFetch.BackgroundFetchResult.NewData;
        } catch {
          return BackgroundFetch.BackgroundFetchResult.Failed;
        }
      });
    }

    const status = await BackgroundFetch.getStatusAsync();
    if (
      status === BackgroundFetch.BackgroundFetchStatus.Available ||
      status === BackgroundFetch.BackgroundFetchStatus.Restricted
    ) {
      await BackgroundFetch.registerTaskAsync(BG_TASK_NAME, {
        minimumInterval: 60, // OS will clamp upward (typically ≥15min)
        stopOnTerminate: false,
        startOnBoot: true,
      });
      _bgRegistered = true;
    }
  } catch (e) {
    // Background-fetch not available (e.g., Expo Go on some platforms). Silently ignore.
  }
}
