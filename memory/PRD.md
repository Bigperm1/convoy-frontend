# Convoy - PRD

A community app for car enthusiasts that combines Zello-style walkie-talkie + Waze/Google Maps-style live navigation + in-car music + voice activation, in an Apple liquid-glass design.

## Tech Stack
- **Frontend**: Expo SDK 54 React Native, expo-router, expo-av, expo-location, expo-blur, react-native-svg, AsyncStorage
- **Backend**: FastAPI + MongoDB (motor), JWT (bcrypt), WebSocket realtime, Whisper-1 STT
- **Design**: Apple liquid-glass dark theme

## Tabs (5)
1. **Map** — Full-screen stylized satellite map (dark green terrain, blue water, gray roads, building footprints). Waze-style hazard pins (police, accident, road, traffic) shown at user-reported lat/lng. Tap a pin to see reporter & confirms. Floating glass header. Voice + Report FABs.
2. **Talk** — Walkie-talkie. Channels = communities the user belongs to. Empty state with "Open Hub" CTA when none. Hold-to-talk PTT button.
3. **Drive** — Live navigation preview (Waze/Apple Maps style): SVG route, animated user pulse, glass status bar, next-turn instruction, hazard alert toasts, ETA HUD, action & tool rows.
4. **Music** — Mock player with Spotify / Apple Music / SoundCloud tabs.
5. **Hub** (formerly Garage) — Communities feature:
   - Profile button → modal with car details
   - **Create** community (name, description, public/private)
   - **Discover** modal: search public communities by name, request to join (admin must approve), or join immediately via invite code
   - **My communities** list with admin badge
   - Tap a community → detail modal: admins see invite code (with native Share), pending requests with Approve/Reject, Delete community; non-admin members can Leave

## Communities backend
- POST /api/communities — create (creator becomes admin)
- GET /api/communities/mine — user's communities
- GET /api/communities/search?q= — public search
- GET /api/communities/{id} — detail (admin sees pending users)
- POST /api/communities/{id}/request — request join (added to pending_requests)
- POST /api/communities/{id}/approve/{uid} — admin approves (pending → members)
- POST /api/communities/{id}/reject/{uid} — admin rejects
- POST /api/communities/join?code= — instant join via invite code
- POST /api/communities/{id}/leave — non-admin leaves
- DELETE /api/communities/{id} — admin deletes (cascades PTT)

## PTT
PTT messages are scoped to a community. Membership is enforced server-side on POST /api/ptt and GET /api/ptt/{community_id}.

## Voice intents
"police/cop", "accident/crash", "hazard/pothole", "traffic/jam", "talk/walkie", "music/play/song", "drive/carplay", "map".

## CarPlay
True CarPlay needs Apple entitlement + EAS native build. Drive Mode tab provides the layout, ready to wire into a CPMapTemplate scene.

## Smart business enhancement
**Premium communities** — paid tier unlocks unlimited members, custom badges, scheduled cruise events, and exclusive premium-only channels (revenue stream).
