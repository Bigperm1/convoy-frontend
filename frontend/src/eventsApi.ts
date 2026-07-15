// src/eventsApi.ts — Hub Events + Cruises API client (Hub P2/P3).
//
// Thin typed wrappers over the backend /api/events routes (server.py "Events"
// section). The axios `api` instance auto-attaches the bearer token, so these
// work anywhere the user is signed in. A "cruise" is the same object with
// kind:'cruise' + the departure/stops/end/polyline fields (P3).

import { api } from './api';

export type EventPoint = { lat: number; lng: number; label?: string };

export type HubEvent = {
  id: string;
  kind: 'event' | 'cruise';
  title: string;
  description: string;
  club_id: string | null;
  is_public: boolean;
  creator_id: string;
  creator_handle: string;
  venue: EventPoint;
  start_at: string;          // ISO
  notify_enabled: boolean;
  attendee_count: number;
  confirmed_count: number;
  is_creator: boolean;
  is_attending: boolean;
  is_confirmed: boolean;
  banner_b64?: string | null;
  tags: string[];
  // cruise-only (P3)
  departure_at?: string | null;
  stops: EventPoint[];
  end?: EventPoint | null;
  polyline?: string | null;
  created_at: string;
  // detail-only (GET /events/{id})
  attendees_users?: {
    id: string; handle: string;
    car_make?: string; car_model?: string; car_color?: string; car_type?: string;
    confirmed: boolean;
  }[];
};

export type CreateEventInput = {
  kind?: 'event' | 'cruise';
  title: string;
  description?: string;
  club_id?: string | null;
  is_public: boolean;
  venue_lat: number;
  venue_lng: number;
  venue_label?: string;
  start_at: string;          // ISO (use new Date(...).toISOString())
  notify_enabled: boolean;
  tags?: string[];
  banner_b64?: string | null;
  // cruise (P3)
  departure_at?: string;
  end_lat?: number;
  end_lng?: number;
  end_label?: string;
  stops?: EventPoint[];
  polyline?: string;
};

export async function createEvent(input: CreateEventInput): Promise<HubEvent> {
  const { data } = await api.post('/events', input);
  return data;
}

export async function myEvents(): Promise<HubEvent[]> {
  const { data } = await api.get('/events/mine');
  return data;
}

export async function discoverEvents(q = '', kind: '' | 'event' | 'cruise' = ''): Promise<HubEvent[]> {
  const { data } = await api.get('/events/discover', { params: { q, kind } });
  return data;
}

export async function getEvent(id: string): Promise<HubEvent> {
  const { data } = await api.get(`/events/${id}`);
  return data;
}

export async function attendEvent(id: string): Promise<HubEvent> {
  const { data } = await api.post(`/events/${id}/attend`);
  return data;
}

export async function confirmEvent(id: string): Promise<HubEvent> {
  const { data } = await api.post(`/events/${id}/confirm`);
  return data;
}

export async function unattendEvent(id: string): Promise<HubEvent> {
  const { data } = await api.post(`/events/${id}/unattend`);
  return data;
}

export async function updateEvent(id: string, patch: Partial<CreateEventInput>): Promise<HubEvent> {
  const { data } = await api.put(`/events/${id}`, patch);
  return data;
}

export async function deleteEvent(id: string): Promise<void> {
  await api.delete(`/events/${id}`);
}
