# Design — Pre-planned drives / meets

## Goal
An admin **pre-plans a drive/meet** in the admin panel, **sends it to the whole community**, members **RSVP**, and **attendees get the route** to start navigation.

## Data model
New collection `planned_drives` (the existing community-routes plumbing + `RouteIn.scheduled_at` are reused where possible):
```
{ id, community_id, title, description,
  scheduled_at,                       # ISO UTC
  origin: { label, lat, lng } | null,
  destination: { label, lat, lng },
  polyline: str | null,               # precomputed at create (Google Routes v2)
  created_by (uid), created_at,
  attendees: [ { user_id, status: "going"|"maybe"|"declined", responded_at } ] }
```

## Flow
1. **Create** — `POST /communities/{cid}/drives` (admin): title, time, destination (+ optional origin). Backend computes the route polyline once (Google Routes v2). Pushes a notification + in-app card to all members: *"[Admin] planned a drive: [title] — [time]. Going?"*
2. **List** — `GET /communities/{cid}/drives` → upcoming drives for the community (members + admin).
3. **RSVP** — `POST /communities/drives/{drive_id}/respond {status}` (member). On **"going"**, the response returns the route (destination + polyline) so the member can **tap "Start"** to navigate — reuses the existing destination/route start path in `map.tsx`.
4. **Cancel/Edit** — `DELETE` / `PUT /communities/drives/{drive_id}` (admin) → notify attendees of the change.
5. (Optional) **Start broadcast** — `POST /communities/drives/{drive_id}/start` (admin): push the route to all "going" attendees to begin nav together.

## Reuse
- `RouteIn` already has `scheduled_at`, origin/destination, polyline — planned drives are essentially scheduled community routes with an RSVP layer.
- Route delivery reuses `/notifications/share` (kind=`route`) + the `shareBus`/share-inbox path the app already has, so an accepted drive lands as a "Start route" card.
- Supabase Realtime (already used for community routes) broadcasts create/cancel so lists update live.

## UI
- **Admin panel:** "Plan a drive" form — title, date/time picker, origin/destination search (existing `NavSearchScreen`/places), route preview, "Send to community."
- **Members:** an "Upcoming drives" list + an incoming card with **Going / Maybe / Decline**; on Going, a **Start route** button (and/or auto-prompt at `scheduled_at`).
- **Admin sees the RSVP roster** (who's going/maybe/declined).

## Open decisions (need your call)
1. **Route delivery timing:** send the route on **accept** (member can start anytime) vs at **drive start** (admin triggers, everyone launches together) vs **both**? (*Recommended: on accept, plus an optional admin "start" broadcast.*)
2. **Route compute:** precompute at create (one route for all) vs per-member from their own location at start. (*Recommended: store destination; compute each member's route from their location when they Start — handles different origins.*) → if so, `polyline` is optional/preview-only.
3. **Reminders:** push a reminder N minutes before `scheduled_at`? (*Recommended: optional, e.g., 30 min before — needs a light scheduler.*)
4. **Who can plan:** any admin/co-admin or owner only? (*Recommended: any admin.*)
