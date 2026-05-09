import { createClient, SupabaseClient } from "@supabase/supabase-js";

const URL = process.env.EXPO_PUBLIC_SUPABASE_URL as string;
const KEY = process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY as string;

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
  created_at: string;
  expires_at: string;
};
