# Rev Radar - PRD

A community app for car enthusiasts combining Zello-style walkie-talkie + Waze-style live hazard map + in-car music + voice activation, with a CarPlay-ready Drive Mode UI.

## Tech Stack
- **Frontend**: Expo SDK 54 / React Native, expo-router, expo-av (audio recording), expo-location, react-native-svg (radar map), expo-secure-store (web fallback to localStorage)
- **Backend**: FastAPI + MongoDB (motor), JWT auth (bcrypt), WebSocket for realtime, Whisper-1 for voice via Emergent LLM Key

## Core Features
1. **Auth (JWT email/password)** – register/login/logout, profile editor with car details
2. **Live Radar Map** – custom SVG radar (no native maps required), shows nearby drivers + hazards, real-time via WebSocket
3. **Hazard Reporting** – police, accident, road, traffic; auto-expire after 30 min; +1 confirms
4. **Walkie-Talkie** – 5 channels (General/JDM/Muscle/Euro/Trucks), push-to-hold record, base64 m4a stored & played back
5. **Voice Commands** – mic FAB on Map/Drive screens, transcribed via Whisper, auto-detected intents (report_police, open_talk, etc.)
6. **Drive Mode** – CarPlay-ready simplified UI with massive HUD-style buttons
7. **Music** – mock player with Spotify / Apple Music / SoundCloud tabs and playable mock tracks

## Real-time
WebSocket at `/api/ws?token=<jwt>` broadcasts `location`, `hazard`, `ptt_live` events to all connected clients.

## Voice Intents
"report police" → police hazard, "accident/crash", "hazard/pothole", "traffic/jam", "talk", "music", "drive", "map".

## CarPlay Note
True CarPlay requires Apple entitlement + native EAS build. Drive Mode tab provides the layout; can be wired to CarPlay scene via Expo config plugin in production build.

## Smart business enhancement
Channel reputation: each PTT message + each hazard +1 confirm grows the user's "Convoy Score". This drives long-term engagement and unlocks premium channels (paid tier opportunity).
