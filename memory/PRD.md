# Convoy - PRD

A community app for car enthusiasts that combines Zello-style walkie-talkie + Waze/Apple Maps-style live navigation + in-car music + voice activation, in an Apple liquid-glass design and CarPlay-ready Drive Mode.

## Tech Stack
- **Frontend**: Expo SDK 54 React Native, expo-router, expo-av (audio), expo-location, expo-blur (glass), react-native-svg (route + radar), AsyncStorage (token)
- **Backend**: FastAPI + MongoDB (motor), JWT (bcrypt), WebSocket realtime, Whisper-1 STT via Emergent LLM Key
- **Design**: Apple liquid-glass dark theme (system blue `#0A84FF`, indigo accent `#5E5CE6`, frosted BlurView surfaces, SF system font)

## Tabs
1. **Map** — radar-style SVG canvas with concentric rings, your driver chevron in center, peers and hazards as glowing dots, real-time WebSocket updates, hazard list with +1 confirms, report FAB
2. **Talk** — 5 channels (General/JDM/Muscle/Euro/Trucks), large hold-to-transmit PTT button with pulse animation, recent transmissions list with playback
3. **Drive** — Live navigation preview (Waze/Apple Maps inspired): SVG route polyline, animated user pulse, glass status bar (time + alert pill), next-turn instruction card ("In 320 m turn right onto Market St"), hazard alert toasts, bottom HUD (ETA min · arrival · distance · speed mph), action row (Police/Hazard/Accident/Traffic), tool row (Sound/Talk/Music/Radar/End). Designed for CarPlay handoff.
4. **Music** — Mock player with Spotify / Apple Music / SoundCloud tabs, large artwork, play/skip controls, animated progress, up-next list
5. **Garage** — Profile (handle, make, model, year, color), save, sign-out

## Realtime
WebSocket `/api/ws?token=<jwt>` broadcasts `location`, `hazard`, `ptt_live` events to all connected clients.

## Voice
Hold the indigo mic FAB → record → Whisper transcribes → intent classifier maps text to actions: report_police / report_accident / report_road / report_traffic / open_talk / open_music / open_drive / open_map.

## CarPlay
True CarPlay needs Apple entitlement + native EAS build. Drive Mode tab provides the layout. Wire to a CarPlay scene via Expo config plugin in production build.

## Smart business enhancement
**Convoy Score** — every PTT message + every hazard +1 confirm grows the user's score, surfaced on Garage. Future paid tier unlocks premium channels & custom badges.
