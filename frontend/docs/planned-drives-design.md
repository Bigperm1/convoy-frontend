<!-- ═════════ RULE #1 — READ THIS BEFORE ANYTHING ELSE ═════════ -->
# 🛑 NO GUESSING. NO THEORIZING. NO HALLUCINATING.

**Every claim is VERIFIED, or the word HYPOTHESIS is said out loud. No exceptions.**

- **VERIFIED** = I ran the query · read the file · measured it · asked Jeff — and I can show the receipt.
- Reading code and reasoning about it is **NOT** verification. Neither is *"it would explain the symptom."*
- **Never** state a root cause, a fix, or a conclusion I have not tested. Not even a likely-sounding one.
- **Check the instrumentation that ALREADY EXISTS** before inventing an explanation. It usually answers it.
- Separate cleanly: *what the data shows* vs *what I don't know*. Put the unknowns in writing.
- **"I don't know — here is the ONE check that would settle it"** is a GOOD answer.
  A confident wrong answer costs a day and burns trust.

> Jeff, 2026-08-21, in caps: **"ABSOLUTLEY STOP GUESSING, NO THEORYIZING, NO HALLUCENATIONS."**
> Trigger: I declared `ADVANCE_THRESHOLD_M = 25` the root cause of a stuck step index — from a code read alone,
> presented as a finding. The `turn=` breadcrumb, **already in the logs**, refuted it in a single query.
> The instrumentation existed. I guessed instead of reading it. Then I did it again with the timezone.
<!-- ═════════ END RULE #1 ═════════ -->

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

## Decisions — LOCKED (2026-06-10)
1. **Route delivery timing:** route is sent **on accept** (member can Start anytime), **plus** an optional admin **"start together" broadcast** to all "going" attendees.
2. **Route compute:** store the **destination**; compute **each member's route from their own location** when they hit Start (handles different origins). `polyline` on the drive is **preview-only**.
3. **Reminders:** push a reminder **30 min before** `scheduled_at` (light scheduler / lazy check on access).
4. **Who can plan:** any admin or co-admin (`_is_comm_admin`).
