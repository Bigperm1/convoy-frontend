# Design — Community Sync + "[community] arrived" proximity notify

## Goal
When two communities are about to meet, their admins **sync** the two communities for **24 hours**. While synced, when the two groups come **within 500 m** of each other, every member of both gets a one-time notification: **"[Community name] arrived."**

## Data model
New collection `community_syncs`:
```
{ id, community_a, community_b,
  status: "pending" | "active" | "expired" | "declined",
  requested_by (uid), accepted_by (uid|null),
  created_at, expires_at,            # expires_at = accept time + 24h
  arrived_notified: bool }           # so "arrived" fires once
```
Consent required: A requests → B's admin accepts → `active` with a 24h clock.

## Flow
1. **Request** — `POST /communities/{cid}/sync-request {target_community_id}` (admin of A). Creates a `pending` sync; pushes "Community A wants to sync for a meet" to B's admins.
2. **Accept/Decline** — `POST /communities/sync/{sync_id}/accept` (admin of B) → `active`, `expires_at = now+24h`. Decline/cancel → `declined`/deleted.
3. **List** — `GET /communities/{cid}/syncs` → active + pending for the admin UI (countdown).
4. **Proximity** — checked **on `/location` updates** (event-driven, no cron), throttled per sync (≈ every 20 s). If the min distance between any *live* member of A and any *live* member of B ≤ 500 m and `arrived_notified` is false → fire "arrived" to both communities, set the flag.
5. **Expiry** — lazy: any access past `expires_at` flips to `expired` (+ a light periodic sweep).

## Notification
Reuse `_send_expo_push` fan-out to all members of both communities, body `"[Other community] arrived"`, plus a WS frame for an in-app toast. (We notify presence/arrival only — never share exact member coordinates cross-community.)

## UI (community admin)
- **"Sync with another community"** → search a community by name/code → send request.
- **Incoming requests** → Accept / Decline.
- **Active syncs** → "Synced with [B] · expires in 23 h" + Unsync.

## Decisions — LOCKED (2026-06-10)
1. **Proximity basis:** min distance between any two *live* members (first cars meet). Fires earliest.
2. **Re-arm:** notify **once per sync** (`arrived_notified` flag, no re-fire on re-approach).
3. **Who can sync:** any admin or co-admin (`_is_comm_admin`).
4. **How B is found:** search public communities by name, with an explicit **sync code** fallback the A admin can share.

## Perf note
Proximity-on-`/location` is throttled and only runs when the mover's active community has an `active` sync, so it's cheap in the common (no-sync) case.
