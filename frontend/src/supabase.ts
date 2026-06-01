import { createClient, SupabaseClient } from "@supabase/supabase-js";

// Hardcoded fallback for the Supabase project. Mirrors the two-layer defense
// used for BACKEND_URL in api.ts: if EAS Build doesn't inject the
// EXPO_PUBLIC_SUPABASE_* env vars at bundle time, presence/live-avatars would
// silently go dark (the client becomes null and useConvoyPresence no-ops with
// status "disabled"). That's exactly the bug that shipped in 1.1.0 (24) —
// eas.json passed BACKEND_URL + GOOGLE_MAPS_KEY but NOT the Supabase vars, so
// SUPABASE_ENABLED was false on device and no one ever saw each other's car.
//
// The anon key is designed to be embedded in client apps (it's the public,
// Row-Level-Security-protected key, not a secret), so baking it in as a
// fallback is safe and consistent with how the Google Maps key already ships.
// eas.json ALSO injects these now; either layer alone is sufficient.
const FALLBACK_SUPABASE_URL = "https://pgtbjiszjglznjagolse.supabase.co";
const FALLBACK_SUPABASE_ANON_KEY =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InBndGJqaXN6amdsem5qYWdvbHNlIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzgyOTE4NTYsImV4cCI6MjA5Mzg2Nzg1Nn0.ouxO8zCeFi6hjB0UJmDv_k8tPuz0NOWLAZdg91nhyt4";

const URL = (process.env.EXPO_PUBLIC_SUPABASE_URL as string) || FALLBACK_SUPABASE_URL;
const KEY = (process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY as string) || FALLBACK_SUPABASE_ANON_KEY;

// Only create the Supabase client in the browser. supabase-js v2 instantiates
// a Realtime WebSocket on construction which crashes Node SSR (Node 20 has no
// global WebSocket). Returning null on the server keeps SSR healthy; the
// client side picks up the real instance on hydration.
let _client: SupabaseClient | null = null;
if (typeof window !== "undefined" && URL && KEY) {
  _client = createClient(URL, KEY, {
    auth: { persistSession: false },
    realtime: { params: { eventsPerSecond: 10 } },
  });
}

export const supabase: SupabaseClient | null = _client;
export const SUPABASE_ENABLED = !!(URL && KEY && typeof window !== "undefined");

export type SupaHazard = {
  id: string;
  kind: string;
  lat: number;
  lng: number;
  reporter_handle: string | null;
  confirms: number;
  // `disputes` is optional — older tables created without this column will
  // simply omit it. The UI treats undefined as 0.
  disputes?: number;
  created_at: string;
  expires_at: string;
};
