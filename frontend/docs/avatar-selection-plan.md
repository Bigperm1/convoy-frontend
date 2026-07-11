# Avatar Selection — Design Plan

Give drivers a choice of how they appear on the live convoy map, set in the Garage:

1. **3D car** (current default) — the color-driven GRC GLB model.
2. **Green 3D arrow** — a beveled 3D arrow model (ModelLayer), heading-aligned.
3. **Profile photo** — a circular uploaded photo; also used in "drive with a friend" search.

This choice must render correctly for **you**, for **every peer** in the convoy, and on **CarPlay/Android Auto**.

---

## 1. Data model

### Settings (`src/settings.ts`) — frontend
Add one appearance field (privacy `avatarMode` stays separate — it controls *whether* you're visible, not *how*):

```ts
// How the driver is drawn on the map. Separate from avatarMode (privacy/visibility).
selfMarkerType?: 'car' | 'arrow' | 'photo';   // default 'car'
avatarUrl?: string;                            // hosted profile photo (photo mode)
```
+ a default-safe accessor mirroring `getMapMode`/`getAvatarMode`:
```ts
export function getSelfMarkerType(s: Settings): 'car' | 'arrow' | 'photo' {
  return s.selfMarkerType ?? 'car';
}
```
No settings-key bump needed (additive optional fields; `convoy.settings.v3` stays).

### Backend profile (Render service) — **dependency, separate repo**
Peers render from the **backend user doc** (presence, `/users/nearby`, and the `/location` broadcast all read it — see the note in `garage.tsx:180`). So the choice must live on the profile:
```
avatar_type : 'car' | 'arrow' | 'photo'   (default 'car')
avatar_url  : string | null               (photo mode)
```
`PUT /auth/profile` accepts both; `/users/nearby` + `/location` return both.

---

## 2. Rendering matrix (the core)

The app already splits **self = 3D model (ModelLayer)** vs **peer = 2D PNG (MarkerView)**. We keep that split and extend it per mode:

| Mode | You (self) | Peers | CarPlay (self) |
|---|---|---|---|
| **car** | 3D car GLB (`SelfCarModel`) ✅ today | rotated car PNG (`CarMarker`) ✅ today | 3D car GLB ✅ today |
| **arrow** | 3D arrow GLB (new ModelLayer branch) | rotated arrow PNG (new `CarMarker` branch) | 3D arrow GLB (new branch) |
| **photo** | circular photo `MarkerView` (new `PhotoMarker`) | circular photo `MarkerView` (new branch) | **fallback → 3D car or arrow** (CarPlay's 3D map can't show a flat photo) |

Rationale: self stays "hero-quality" 3D where possible; peers stay lightweight 2D icons (as today). Photo is inherently 2D so both self and peers use the same circular marker.

---

## 3. Green 3D arrow

**Asset:** a `green-arrow.glb` — a beveled chevron/arrow pointing +forward, brand green `#2DEC86`, emissive so it reads on dark maps. **Host it remotely** (same as the car GLBs on `upload.higgsfield.ai`) so it loads at runtime and ships via **OTA**, no native rebuild. I can generate it (same pipeline as the GRC cars) or model a simple one.

**Self (`src/ConvoyMapbox.tsx`):** `SelfCarModel` already interpolates position+heading and renders a `ModelLayer`. Branch its `modelId`/model URL on `selfMarkerType`:
- `car` → `getVehicleModelUrl(color)` (today)
- `arrow` → the arrow GLB + its own `ARROW_MODEL_HEADING_OFFSET` + `ARROW_MODEL_SCALE`
Everything else (60fps tween, camera lockstep) is reused as-is.

**Peers:** `CarMarker` swaps `getVehiclePngOrDefault(color)` for a flat `green-arrow.png` when `car.avatarType === 'arrow'`, rotated by heading (identical mechanism to the car PNG). Peer arrow = 2D image (matches the self=3D / peer=2D split).

**CarPlay:** `CarMapView` reuses `SelfCarModel`; add the same arrow branch keyed off a new mirrored `selfMarkerType` in `carStore`. Fits the 3D ModelLayer pipeline naturally.

---

## 4. Profile photo (the big flow)

### 4a. Upload (Garage)
Reuse the `expo-image-picker` pattern from `hub.tsx` (community logos), with `allowsEditing`, `aspect:[1,1]`, `quality:0.6`. This adds the garage's first image-picker call.

### 4b. Storage — **decision needed**
- **Option A — Supabase Storage (recommended):** upload to an `avatars` bucket → public CDN URL → store URL in profile + settings + presence. Small URL travels in presence (frequent broadcasts stay light), CDN-cached for peers. Needs a bucket + RLS policy (one-time).
- **Option B — backend base64:** send `avatar_b64` to the profile like community logos (no new infra), backend stores/serves it, peers get the URL/base64 from `/users/nearby`. Simpler infra but heavier payloads; base64 must **never** go in the presence broadcast (too big) — peers would read it from the nearby/profile fetch only.

Either way: **presence carries a URL, not the image bytes.**

### 4c. Map rendering — new `PhotoMarker`
A circular `MarkerView` (self + peers): round photo, brand-green ring, subtle drop shadow, and a small **directional pip** on the ring so heading is still legible (a bare circle loses "which way am I pointing"). Parked → dimmed like the car PNG. Self in photo mode hides `SelfCarModel` and shows `PhotoMarker` at the interpolated position.

### 4d. Presence propagation (`src/convoyPresence.ts`)
Extend `ConvoyMe` / `ConvoyPresencePeer` with `avatarType?` + `avatarUrl?`, add them to both `.track()` calls (`:126`, `:172`) and the flatten (`:105`). Peers read them → pick car / arrow / photo.

### 4e. "Drive with a friend" search
The photo shows wherever a driver is listed — the roster rows (`hub.tsx`, `MemberCarousel`) and the friend/nearby search — replacing the top-down car icon **when** `avatarType==='photo' && avatarUrl`. Falls back to the car icon otherwise. (Confirm exact search screen — likely `NavSearchScreen`/`MemberCarousel`.)

### 4f. CarPlay fallback
CarPlay's map is 3D ModelLayer; it can't render a flat circular photo usefully at driving scale. When self is photo-mode, CarPlay draws the **3D car** (or arrow) instead. Document the limitation; it's a driving surface, not a social one.

---

## 5. Files to touch

**Frontend (this repo):**
- `src/settings.ts` — `selfMarkerType` + `avatarUrl` + `getSelfMarkerType()`
- `app/(app)/garage.tsx` — appearance selector (segmented: Car / Arrow / Photo) + photo picker/upload
- `src/ConvoyMapbox.tsx` — `SelfCarModel` arrow branch; new `PhotoMarker`; `CarMarker` arrow/photo branches
- `src/convoyPresence.ts` — `avatarType`/`avatarUrl` in payload + track + flatten
- `src/carplay/{carStore.ts, ConvoyCarPlay.tsx, CarMapView.tsx}` — mirror `selfMarkerType`; arrow branch; photo→car fallback
- `src/auth.tsx` (`User` type) + `map.tsx` (self identity plumbing) + friend-search screen
- assets: `green-arrow.glb` (remote-hosted), `green-arrow.png` (peer 2D), circular-photo styles

**Backend (Render — separate repo/deploy):**
- User model: `avatar_type`, `avatar_url`
- `PUT /auth/profile`, `/users/nearby`, `/location` broadcast include both
- (Option B only) avatar image store/serve endpoint

---

## 6. Rollout & risk

- **OTA-able:** settings, garage UI, presence fields, arrow render (if the arrow GLB is **remote-hosted** like the car models), photo upload (`expo-image-picker` already a dep). No `runtimeVersion` bump needed.
- **Backend deploy** required for the photo path (and to make peer car/arrow/photo authoritative).
- **Supabase Storage** (Option A) is a one-time setup.
- `yarn typecheck` clean before any OTA (release discipline).

---

## 7. Open decisions before build

1. **Photo storage:** Supabase Storage (recommended) vs backend base64?
2. **Arrow GLB asset:** I generate/model a green arrow, or you have one?
3. **CarPlay photo fallback:** show the 3D **car** or the **arrow**?
4. **Photo heading pip:** yes (recommended, keeps direction legible) or plain circle?
5. **Peer arrow** = flat 2D arrow PNG (recommended, matches self=3D/peer=2D split) — confirm, vs. full 3D for peers too (heavier).

## 8. Suggested build order

1. Settings field + `getSelfMarkerType()` + garage selector (Car/Arrow/Photo) — UI wired, arrow/photo stubbed.
2. Green 3D arrow: asset → self ModelLayer branch → peer PNG branch → CarPlay branch.
3. Photo: storage (backend/Supabase) → upload in garage → presence fields → `PhotoMarker` (self+peers) → friend-search → CarPlay fallback.
4. `yarn typecheck`, device test (self + a peer + CarPlay), then OTA (+ backend deploy).
