// External Alerts — DEPRECATED (June 2025).
//
// This file previously polled `/api/feed/external` (a Waze-style proxy) and
// exposed a `useExternalAlerts` hook plus a background-fetch registration.
//
// The upstream Waze rtproxy endpoints have been returning 403 to all unauth'd
// callers for some time. The corresponding backend route was removed and this
// file has been gutted to keep the type symbols available for any legacy
// imports inside `ConvoyMap.tsx` / `ConvoyMap.web.tsx`.
//
// Hazards are now sourced exclusively from our own Supabase mirror + Mongo
// collection (`/api/hazards`). External-feed markers are gone entirely.

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
