import { createClient } from "@supabase/supabase-js";

const URL = process.env.EXPO_PUBLIC_SUPABASE_URL as string;
const KEY = process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY as string;

export const supabase = URL && KEY
  ? createClient(URL, KEY, {
      auth: { persistSession: false },
      realtime: { params: { eventsPerSecond: 10 } },
    })
  : (null as any);

export const SUPABASE_ENABLED = !!(URL && KEY);

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
