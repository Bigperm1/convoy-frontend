# HAZARDS.md — crew hazard reports: the spec

> The subsystem as it stands on `mapbox-migration` after **OTA-CE `414e1207` (2026-09-25)**. Built 2026-09-24 → 25 over
> six rounds (OTA-BX → CE); the history, Jeff's words per round and the receipts are in memory
> `hazard-panel-carplay-aa-2026-09-24`, the OTA ledger in `HANDOFF-2026-09-25.md` §1.
> **Cite by file + symbol, never by line number** (doc-check rule). Every claim below was read from the code on
> 2026-09-25; the few that were not are marked HYPOTHESIS.
> **FOUR SURFACES:** a change to reporting, pins, colours or button order lands on the phone, CarPlay and Android Auto
> together (memory `four-surfaces-rule`).

## 1 · What it is

Drivers report four kinds of hazard — **police, crash (`accident`), road hazard (`road`), traffic** — from the phone
Report panel, the CarPlay / Android Auto Report grid, or voice. Every report is one `POST /hazards`. The backend stores
it in Mongo, broadcasts it over the WebSocket to every connected user, and mirrors it into the Supabase `hazards` table.
Every client draws every live hazard as a pin (hazards are deliberately global, not per club). Scout calls a hazard
out 1–2 km ahead by kind and distance, and a "still there?" card collects confirm / dispute votes; two distinct "Gone"
votes delete it for everyone. Reports expire by kind (§5).

## 2 · Surfaces and button order

| Surface | Where | Order / content |
|---|---|---|
| Phone FAB stack | `app/(app)/map.tsx` `styles.fabStack` (right 12, `bottom: controlsBottom`, gap 10, 60 pt FABs) | top → bottom: `hazards-fab` · `view-2d-3d-fab` (always shown) · `crew-fit-fab`. **No compass FAB** — the compass is a panel tile. Gate `hazard_panel_test` D4. |
| Phone Report panel | `src/components/HazardSheet.tsx` (default export), opened by `setShowReport(true)` | Five tiles from `HAZARD_TILES` via `PANEL_TILES`: Police · Crash · Hazard · Traffic · Compass. Title "Report", hint "Pinned where you were 5 seconds ago. The crew sees it right away." |
| Phone tapped-pin card | `src/components/HazardCard.tsx` `mode="detail"`, fed by `onHazardPress → setSelected` | Your own pin: one full-width 52 pt "Remove my alert" (no confirm dialog). Someone else's: "Gone" · "Still there". Shows 👍 confirms / 👎 disputes. |
| Phone still-there prompt | `HazardCard` `mode="passby"` (`hazard={selected \|\| showReport ? null : passPrompt}`) | "`<label>` ahead — still there?" · "Gone" · "Still there". Never over a tapped-pin card or the Report panel. |
| Phone report pill | `src/components/AlertToast.tsx` `ReportPill` | Under the crew / version pill, dressed like it (`styles.liveOverlay`), tinted with the kind's bright colour, "`<label>` reported", 4 s. A second mount renders while the search bar is hidden (under the turn banner in turn-by-turn). |
| CarPlay map buttons | `src/carplay/carActions.ts` `carMapButtonConfig()` (used by `carPlayBootstrap.ts` cold, `ConvoyCarPlay.tsx` warm) | Array: `car-comms` · `car-hazards` · `car-view` · `car-crew` = top → bottom. Panning mode hides from the END, so the mic and Hazards survive a pan. |
| CarPlay grid | `openHazardPanel` → `getHazardTemplateIOS` (`GridTemplate`, id `hairpin-car-hazards`, title "Report") | The same five tiles (`hazardGridButtons`). The four report tiles draw the kind-coloured `hz_*_neon` glyph (the phone's tinted glyph, §3), the Compass its metal. One template instance per session. |
| Android Auto map strip | `aaMapButtons()` (used by `ConvoyCarPlay.tsx`, `AndroidAutoRoot.tsx`) | `car-zoom-in` · `car-zoom-out` · `car-hazards` · `car-crew` — Hazards above Crew. The action strip (`AA_ACTION_STRIP`: End · Search · view · comms) has no Hazards. |
| Android Auto grid | `openHazardPanel` → `bridge.createTemplate(HAZARD_TEMPLATE_ID, hazardGridConfigAA(...))` + `pushTemplate` | The same five tiles, `headerAction: { type: 'back' }`. androidx tints map-strip icons white (code comment; no native tint patch). The four report tiles get the kind-coloured `hz_*_neon` icons like CarPlay. Our bridge sets no tint (`RCTTemplate.kt` `parseCarIcon`); HYPOTHESIS, never seen on a unit or the DHU: the host tints grid tile art white anyway (CARPLAY.md §4). |
| Voice | `map.tsx` `voiceBus.subscribe` | Intents `report_police` / `report_accident` / `report_road` / `report_traffic` → `reportHazard(kind, { fromVoice: true })` (spoken acknowledgement). The backend emits them from the agent tool `report_hazard` and a keyword fallback. |

Dispatch: warm CarPlay `onMapButtonPressed` → `handleCarMapButton(id, 'warm')`; cold → `handleCarMapButton(id, 'cold')`;
Android Auto `handleAaButton` (its allowlist includes `HAZARD_BUTTON_ID`) → `handleCarMapButton`; then
`if (id === HAZARD_BUTTON_ID) { openHazardPanel(); return; }`. The Compass tile fires `emitCarGesture({ kind: 'compass' })`
on the head units and `onCompassTile` on the phone (the old compass FAB's 🔒 north-up toggle, moved verbatim).

## 3 · Kinds, colours, glyphs

Backend kinds: `server.py` `create_hazard` rejects anything outside `("police", "road", "accident", "traffic")`;
`src/carplay/hazardPanel.ts` `HAZARD_REPORT_KINDS` is the same four and gate A3 reads `server.py` so they cannot drift.

| tile id | kind | title | glyph | colour family (`src/hazardPalette.ts`) | bright / deep |
|---|---|---|---|---|---|
| `hz-police` | police | Police | `hz_police` (shield with a P) | EV charging (`ev`) | `#1FC4DE` / `#0F5F6B` |
| `hz-crash` | accident | Crash | `hz_crash` | Hospital (`hospital`) | `#FF4D6D` / `#7A0016` |
| `hz-hazard` | road | Hazard | `hz_hazard` (triangle with a bang) | Fast Food (`fastfood`) | `#FFC72C` / `#7A5A00` |
| `hz-traffic` | traffic | Traffic | `hz_traffic` | Gas (`gas`) | `#F5891F` / `#753D05` |
| `hz-compass` | — | Compass | `hz_compass` | the metal's NeonPin rim | — |

- Colours come from `src/poiPalette.ts` `POI_PALETTE` (the search-category family) — Jeff, 2026-09-25: "Police - ev
  charging colours · Crash - hospital · Hazard - fast food · Traffic - gas". `hazardPaint(kind)` returns
  `{ kind, cat, label, glyph, bright, deep }`; an unknown kind draws as `road`.
- Phone tiles are rimmed 1.5 pt **and** glyph-tinted in the kind's bright colour (`HazardSheet` `neonFor`); the card's
  glyph tile too. The Compass tile keeps its metal art and rim (`NEON_TONE[metal].rim`).
- **Head-unit grid tiles match** (Jeff, 2026-09-25: "the same colors as on the phone, just so they stand out"): CarPlay and
  androidx cannot tint an image, so `hazardTileCarGlyph()` (`hazardPanel.ts`) maps each report tile to a baked
  `hz_<glyph>_neon` icon — the brand silhouette with every pixel in the kind's bright colour, one icon for all four metals
  (`CAR_ICON_BY_SKIN`). CarPlay draws grid art in its own colours (Jeff's 09-25 photo shows the Diamond cyan, not white).
  Android Auto: HYPOTHESIS that the host may still tint grid icons — never seen on a unit or the DHU.
- Metals (brand green / Silver / Gold / Diamond): head units carry every `hz_*` glyph × four metals in
  `src/carplay/carButtonIcons.ts` `CAR_ICON_BY_SKIN` (incl. `hz_camera` and `hz_hazard_candy`); the phone's
  `HazardSheet.tsx` `HAZARD_ART` holds the five tile glyphs (no `hz_camera`) and `HAZARD_FAB_ART` the candy triangle.
- The Hazards **map button** wears the **candy** triangle (`HAZARD_BUTTON_GLYPH = 'hz_hazard_candy'`; phone
  `HAZARD_FAB_ART`, 34 pt) — the finish of the crew and 2D/3D buttons. The grid tile keeps the flat glyph. **Head units
  wear their own cut** (Jeff, 2026-09-25, CarPlay photo: "a little, little smaller and it's the same distance for each three
  points to the edge of the circle"): the same triangle centred on its circumcentre, all three points at 0.80 of the 44 pt
  box's half-width (≈ 17.5 pt from the centre) (the phone's PNG reaches 0.98 at the base corners, which touched CarPlay's circle). The phone FAB is unchanged. The static,
  value-locked `CAR_MAP_BUTTON_CONFIG` / `AA_MAP_BUTTONS` still reference the flat `CAR_ICON_HAZARDS`; the live builders
  (`carMapButtonConfig()`, `aaMapButtons()`) are what the templates use.
- **No speed-camera tile.** `hz_camera` art exists but the backend has no such kind (gate A4). Adding it = backend kind +
  pin + peers first.
- Label drift for `accident`: tile/card "Crash"; Scout's call picks at random from `HAZARD_AHEAD_OPENERS.accident`
  ("Crash reported" / "Heads up, accident reported" / "There's a crash" / "Collision reported"); the voice acknowledgement
  "Accident"; the 🔒 reroute prompt "an accident".

## 4 · Data path

1. **Report position = where the car was ~5 s ago.** Phone `map.tsx` `getPos5SecAgo()` (30 s ring in `posHistoryRef`);
   head unit `carActions.ts` `pos5SecAgo()` over `_posRing` (`POS_RING_MAX` 12), falling back to the live fix, toast
   "No GPS fix yet" with none. Both call `api.post('/hazards', { kind, lat, lng, note: '' })`.
2. **Backend** (`~/convoy-backend/server.py` `create_hazard`): Mongo document `{ id: uuid4, kind, lat, lng, note,
   reporter_id, reporter_handle, created_at, expires_at: now + _hazard_ttl_min(kind), confirms: 1 }`;
   `ws_manager.broadcast({ type: "hazard", hazard: <doc without reporter_id> })` to every socket; fire-and-forget
   `supa.upsert_row("hazards", { id, kind, lat, lng, reporter_handle, created_at, expires_at })`.
3. **Optimistic pin:** phone `reportHazard` prepends the returned row; head unit `reportHazardFromCar` →
   `setCarHazards([...], 'service')` (dropped if the phone feed wrote within `FEED_STALE_MS`).
4. **Phone intake** (`map.tsx`): `fetchHazards` reads Supabase `hazards` (`expires_at > now`, newest first, via `toHazard`),
   falls back to `GET /hazards`; on mount and every 30 s (skipped when backgrounded and not navigating). Supabase channel
   `public:hazards` (INSERT / UPDATE / DELETE). WebSocket `hazard` (dedupe by id), `hazard_update` (merge),
   `hazard_removed` (drop the pin, close any open card or prompt for it).
5. **Head-unit intake:** warm — `map.tsx` hands `hazards.filter(isHazardVisible)` to `useConvoyCarPlay` →
   `setCarHazards(…, 'phone')`; cold — `src/carplay/carDataService.ts` `refreshHazards` (same Supabase-then-REST order,
   at most every `HAZARDS_REFRESH_MS` 30 s, driven by position ticks) plus the channel `car:public:hazards` and the same
   three WebSocket types.

## 5 · Lifetime, votes, removal

- **Lifetime** (`server.py` `_HAZARD_TTL_MIN`): police **90 min** · traffic **90** · accident **240** · road **360**
  (unknown kinds 120). Nothing deletes on expiry: the reads filter on `expires_at` (Mongo `$gte now`, Supabase
  `.gt(now)`), the Mongo index has no TTL, and no `hazard_removed` is broadcast — a pin leaves at the next fetch (≤ 30 s).
- **Confirm** (`POST /hazards/{id}/confirm`, `confirm_hazard`): distinct voters (`confirmed_by`); a new voter bumps
  `confirms` and resets `expires_at` to now + lifetime **in Mongo only**; broadcasts `hazard_update`. Client
  `confirmHazard` bumps optimistically and closes the card / prompt.
- **Dispute** (`POST /hazards/{id}/dispute`, `dispute_hazard`): distinct voters (`disputed_by`); at **2** it deletes from
  Mongo and Supabase and broadcasts `hazard_removed`, otherwise `hazard_update`. Client `disputeHazard` bumps
  optimistically and never hides the pin on one vote; `isHazardVisible` hides `disputes >= 2` as a backstop.
- **Remove my alert** → `deleteHazard(id)` → `DELETE /hazards/{id}` (`delete_hazard`): Mongo + Supabase delete +
  `hazard_removed`. The button shows only when `selected?.reporter_handle === user.handle`; no confirm dialog (Jeff,
  2026-09-25).

## 6 · Map rendering

- **Pins are baked PNGs** (`src/hazardPinImages.ts`, generated): the search-category teardrop in the kind's DEEP shade
  with the report glyph in its BRIGHT shade on the head, 36 × 35 pt @3x (108 × 105 px), names `hz_pin_<kind>`
  (`hazardPinImageName`).
- **Phone** (`src/ConvoyMapbox.tsx` `GLPinLayers`): `ShapeSource id="gl-hazards"` (`hazardFC`) → `SymbolLayer
  id="gl-hazards-sym"`, `slot="top"`, `minZoomLevel={NEON_MIN_ZOOM}`, `neonSym({ iconImage: ["get","icon"], iconSize:
  1 / POI_PIN_SCALE, iconOpacity: 1 })`; images registered through `PIN_IMAGE_MAP` `...HAZARD_PIN_IMAGES`. Tap →
  `tapHazard` → `onHazardPress` → the card.
- **Head units** (`src/carplay/CarMapView.tsx`): `HazardMarker` per hazard at `CAR_PIN_SCALE` 0.8 — a `MarkerView`
  (anchor bottom-centre) holding the same PNG (`hazardPinUri`). **Head-unit pins are not tappable** (no press handler
  passed) — voting happens on the phone only.

## 7 · Scout

**A · The hazard-ahead call** — pure rules in `src/hazardAhead.ts`, the effect in `map.tsx` under the comment
"Hazard / police proximity voice alert (Scout)", gate `hazard_ahead_test`.

| constant | value |
|---|---|
| `HAZARD_AHEAD_LEAD_S` | 45 s of travel |
| `HAZARD_AHEAD_MIN_M` / `HAZARD_AHEAD_MAX_M` | 1000 / 2000 m |
| `HAZARD_AHEAD_REARM_EXTRA_M` | 500 m |
| `HAZARD_AHEAD_CONE_DEG` | ±50° |
| `HAZARD_AHEAD_MIN_KMH` | 20 km/h |

Fires once per hazard when `dM ≤ clamp(speed × 45, 1000, 2000)`, speed ≥ 20 km/h and the pin sits in the forward cone
of **the fix's own course** (`coords.course ?? null` — never the sticky display heading, Codex r3; no course → no cone).
Re-arms at lead + 500 m. Line: `hazardAheadLine(kind, dM, 'km'|'mi')`, e.g. "Heads up, police reported about
1 kilometer ahead." Muted by `navMuted`. Fires for every kind, idle or navigating, own pins included (only the prompt
skips your own).

**C · Scout's agent tool (backend)** — `server.py` `get_nearby_hazards` → `_agent_tool_nearby_hazards`: live Mongo hazards
within `radius_km` (default 25), all four kinds INCLUDING police, nearest first, max 12, no forward cone, no disputes
filter. Questions that reach the agent answer from this; the on-phone Q&A answers from `nearestHazardAhead` (no police) —
so "any police ahead?" can get two different answers.

**B · The reroute-worthy prompt** — 🔒 regions `map-reroute-hazard-kinds` / `map-reroute-hazard-ahead`:
`REROUTE_HAZARD_KINDS` = accident / road / traffic (never police); `nearestHazardAhead` = nearest qualifying hazard
within 3 km that is closer to the destination than the car. Feeds the 60 s faster-route check (🔒
`map-faster-route-check`) and the in-drive voice Q&A ("anything ahead?"). **Nav-locked — Jeff's words to change.**

## 8 · The still-there prompt — two triggers

State: `passPrompt`, `promptedHazardsRef` (once per hazard per map mount), `passPromptTimer` (15 s).
1. **Rides Scout's call** (Jeff, 2026-09-25: "Maybe make it pop up when scout mentions it"): inside the hazard-ahead
   effect, the first eligible hazard per run (`promptTaken` starts as `!!passPrompt || showReport`) that is not yours and
   not yet prompted sets the prompt.
2. **120 m pass-by fallback** (effect "Pass-by hazard check"): skipped while `passPrompt || showReport`; a hazard that is
   not yours, not prompted, disputes < 2 and at least 20 s old within 0.12 km sets the prompt.

## 9 · Timers

| what | value | where |
|---|---|---|
| Report panel auto-close (phone + both head units) | 8 s `HAZARD_PANEL_AUTO_CLOSE_MS` | `hazardPanel.ts`; `HazardSheet` timer; `carActions.ts` `armHazardsAutoPop` |
| Pin card / prompt fold-away | 15 s | `HazardCard` effect; `passPromptTimer` |
| Crew button → back to the car | 7 s `CREW_RETURN_MS` | `src/crewReturn.ts`; armed in the Crew FAB's `onPress` after the 🔒 block → `recenterNow()` |
| Report pill | 4 s | `reportHazard` `setTimeout(() => setAlertConfirm(null), 4000)` |
| Head-unit toast / tap pill / tap dedupe | 3 s `TOAST_MS` / 1.6 s / 50 ms `TAP_DEDUPE_MS` | `carActions.ts` |
| Hazard fetch | 30 s | phone poll; car `HAZARDS_REFRESH_MS` |

## 10 · Receipts (crumbs) — exact strings

Phone: `phone-tap:hazards` · `hazard-panel op=open surf=phone anchor= winH=` · `hazard-panel layout x= y= w= h= win=` ·
`hazard-panel op=close surf=phone why=nav|auto|back|tap` · `hazard-panel pick surf=phone id=hz-<kind> kind=<kind>` ·
`hazard-panel pick surf=phone id=hz-compass kind=compass` + `phone-tap:compass hold=0|1` (⚠ the phone's `id=` is
`hz-<backend kind>` — `hz-accident` / `hz-road` — not the tile id the head units log, `hz-crash` / `hz-hazard`; join
cross-surface queries on `kind=`) · `hazard-ahead kind= d= lead=
kmh= spoke=0|1` · `crew-return ms=7000`. **`reportHazard` logs nothing on success or failure** (failure is an
`Alert`), so a report is only visible as a `hazards` row.
Head units: `carplay-tap:car-hazards` (pill "Hazards ✓") · `hazard-panel op=push surf=carplay|aa` · `hazard-panel op=pop
surf=… why=user|auto` · `hazard-panel pick surf=carplay|aa id= kind=` · `hazard-panel op=reset why=disconnect` ·
`hazard-panel create-failed:<err>`. Toasts: "Report unavailable", "No GPS fix yet", "Report failed — no connection",
"<Kind> reported ✓". **Bench rows:** the iPhone 16 Pro simulator logs as handle `Jeff` with `update_id` NULL — exclude
those from field conclusions.

## 11 · Gates

- `tools/sim-qc/hazard_panel_test.mts` — A (tiles vs `server.py` kinds, no camera tile, grid limits, map button id /
  label / candy glyph) · B (grid shapes on both head units) · C (four metals per glyph) · D (phone panel: tiles from
  `HAZARD_TILES`, FAB order, nav-transition close, one report in flight, transparent Modal on `PANEL_FLOOR`, centred above
  `fabStackH`, **no entrance animation**, **no BackHandler**, an auto-close between 5 and 12 s armed on all surfaces — the 8 s value itself is not pinned —, candy
  FAB 34 pt, 2D/3D 42 pt)
  · E (both head units' button arrays) · G (compass tile runs the 🔒 toggle, palette mapping, baked pins on both renderers,
  the card is the panel's twin, pill placement, prompt on Scout's call, neon rims + tinted glyphs, Remove without a
  confirm, crew-return wiring, Codex r4 guards) · H (decodes the baked head-unit PNGs: every neon glyph is the brand
  silhouette in exactly `hazardPaint(kind).bright`; the head-unit candy's three points within 1.5 px of each other and
  ≤ 0.84 of the half-canvas).
- `tools/sim-qc/hazard_ahead_test.mts` — lead clamp, cone and bearing, km / mi wording, the `map.tsx` wiring (course only).
- `tools/sim-qc/panel_floor_test.mts` — one floor (`src/panelFloor.ts` = the weather forecast card's) for the weather
  card, the Report panel, the pin card, the category drop-down and the More panel; no GlassFill over it.
- `tools/sim-qc/nav_lock_test.mts` — the lock touchpoints in §13.

## 12 · Assets and how to re-bake

- **Pins:** `python3 tools/poi-pins/bake_hazards.py` → `src/hazardPinImages.ts` + `tools/poi-pins/preview-hazard-*.png`.
  Its `KINDS` table must match `hazardPalette.ts` `MAP`. Needs headless Chrome at `/Applications/Google Chrome.app`.
- **Candy map button:** `python3 tools/poi-pins/bake_hazard_candy.py` → `assets/images/premium/hazard_candy{,_silver,_gold,_diamond}.png`
  (132 px). The phone reads them directly. The head units carry their OWN centred, smaller cut (§3):
  `python3 tools/poi-pins/bake_car_hazard_icons.py` writes `CAR_ICON_HZ_HAZARD_CANDY_*` straight into `carButtonIcons.ts`
  (reusing `bake_hazard_candy.svg()` with a transform) — never paste these by hand.
- **Head-unit grid colours:** the same script writes `CAR_ICON_HZ_{POLICE,CRASH,HAZARD,TRAFFIC}_NEON` from the brand glyph's
  alpha and the `hazardPalette.ts` → `poiPalette.ts` bright colour. Re-run it after any palette or glyph change.
- **Report-tile glyphs:** masters `assets/carplay-glyphs/report/gen_b.py` `glyph()` (64-unit SVG, cut-outs are real mask
  holes); render EACH glyph on its own 256 px transparent canvas with headless Chrome. Head-unit icons = `sips -Z 132`
  of those PNGs, base64 into the `CAR_ICON_HZ_*_{BRAND,PREMIUM,ULTRA,DIAMOND}` constants (manual) — then re-run
  `bake_car_hazard_icons.py`, because the `_NEON` grid icons are derived from the BRAND glyph (gate H1 fails until you do). **Never crop a bake sheet with `sips --cropOffset`**
  — that shipped garbage Police / head-unit icons in OTA-BX/BY (fixed in `976e8734`).

## 13 · Nav-lock touchpoints (`tools/sim-qc/data/nav-lock.json`)

- Regions: `map.tsx` `map-reroute-hazard-kinds`, `map-reroute-hazard-ahead`, `map-compass-northup-toggle` (inside
  `onCompassTile` now), `map-crew-fit-drops-follow`; `carActions.ts` `act-view-2d-when-idle`; `CarMapView.tsx`
  `car-gesture-zoom-compass`, `car-gesture-crewfit`; `ConvoyMapbox.tsx` `mbx-compass-north-reset`.
- Values: `carActions.ts` `CAR_MAP_BUTTON_CONFIG`, `AA_MAP_BUTTONS`, `TAP_LABEL` (why `hazardTapLabel` exists);
  `CarMapView.tsx` `CAR_PIN_SCALE`. Relocked twice on Jeff's words on 2026-09-24 ("build the hazard panel with the apple
  glyphs i mentioned…" and "On both surfaces let's do this order: Right side Top - mic, Second from top - hazards, Second
  from bottom - 2D/3D, Bottom - crew…").
- Not locked: `hazardPanel.ts`, `hazardAhead.ts`, `hazardPalette.ts`, `HazardSheet.tsx`, `HazardCard.tsx`,
  `crewReturn.ts`, `panelFloor.ts`. A NEW module-scope constant in any `watchNew` file fails the lock — for hazards that
  means `map.tsx`, `carActions.ts`, `ConvoyCarPlay.tsx`, `ConvoyMapbox.tsx`, `CarMapView.tsx`, `carStore.ts` (full list:
  `nav-lock.json` `watchNew`). Put new constants in a pure module (that is why these exist).

## 14 · Open issues, not field-verified, traps

**Security (read from code, not exploited — fix before the club launch):**
- `delete_hazard` has **no ownership check** — any signed-in user can delete any hazard by id. The `map.tsx`
  `deleteHazard` comment claims the backend authorises the reporter; it does not.
- The Supabase `hazards` table's RLS lets role `public` INSERT and UPDATE (`hazards_insert` with_check true,
  `hazards_update` using/with_check true, measured from `pg_policies` 2026-09-25) — with the shipped anon key anyone can
  create or edit hazard rows directly.
- **Privacy regression:** `GET /hazards` (`list_hazards`, projection only `{"_id": 0}`) returns `reporter_id`,
  `confirmed_by` and `disputed_by` for every live hazard to any signed-in user; the confirm / dispute broadcasts and HTTP
  responses carry the full document too. Only `create_hazard` strips `reporter_id`. This undoes the 09-06 fix recorded in
  memory `location-privacy-single-gate`.
- Supabase `hazards_read` is public SELECT (`pg_policies`, 2026-09-25) and expired rows are never deleted (60 rows kept),
  so the anon key reads a permanent log of reporter handle + position + time. Decide a retention rule.

**Correctness:**
- **Codex r3 finding NOT fixed:** a hazard with non-finite coordinates passes both alert gates — `map.tsx` computes `dM`
  with no `Number.isFinite` check and `hazardAhead.ts` `isAheadOf` accepts a NaN angle — so Scout could say "about NaN
  kilometers". Whether the backend ever sends such a row is unchecked.
- **The Supabase mirror is written only by create** (upsert without `confirms` / `disputes` / a refreshed expiry) and
  deleted by dispute ≥ 2 / DELETE (VERIFIED from `server.py`: the only `supa.*("hazards"` calls). The live table has **no
  `disputes` column** and `confirms` defaults to 1 (`information_schema`, 2026-09-25). Clients read Supabase first, so a
  Supabase-sourced pin always shows 1 confirm / 0 disputes, loses a WebSocket-merged dispute count on every 30 s poll, and
  expires at its ORIGINAL time even after a confirm — the `isHazardVisible` disputes backstop only holds between a
  `hazard_update` and the next poll. The field effect is unmeasured.
- `toHazard` drops `created_at`, so the pass-by 20 s freshness skip only works for REST / WebSocket rows.
- The hazard-ahead call does not skip `disputes >= 2`; the Q&A "any police ahead?" answers from `nearestHazardAhead`,
  which never counts police.
- A car-only drive (cold head unit, phone app not open) has pins but no Scout hazard call, no prompt and no voting — the
  call lives only in `map.tsx`. HYPOTHESIS from the code.
- The report pill's 4 s timer is never cleared, so a second report within 4 s is hidden early (read from code).

**Android phone — never run.** No emulator or device covered BZ → CE: the panel, card, pill, More panel and floor are
unverified on Android, including layering (`HazardSheet` / `HazardCard` `elevation: 10` in a Modal, `ReportPill` `zIndex: 5`
with no elevation, CategoryPills `zIndex 40 / elevation 40`). Use the `verify-android` skill.

**Never seen in the field (as of 2026-09-25 08:30 PDT):** any head-unit panel receipt (`carplay-tap:car-hazards`,
`hazard-panel op=push`, `surf=carplay|aa`), the new pins on a head unit, `hazard-ahead` from a real drive, the
still-there prompt (needs another driver's pin), `crew-return` from Jeff's phone. Say Phin (Android Auto) was still on
OTA-BV, which predates the panel.

**Bench paint flake — NOT root-caused:** on the shared iPhone 16 Pro simulator the phone panel sometimes opens in state
(open + layout + auto-close crumbs) and paints nothing — 11 of 25 cold launches painted across nine variants. A
`BackHandler` listener was blamed for an hour and cleared. Shipped mitigation: a transparent `Modal` with a static card
(gates D8/D9) and the `hazard-panel layout` crumb. On OTA-CA Jeff's phone logged 21 opens, all with a layout crumb (x 39, y 438, 352 × 190); 3 ended in a report pick,
which proves those painted. Crumbs cannot tell whether the rest did — only Jeff's eyes can. Memory
`backhandler-listener-unpaints-overlay-2026-09-25`.

**Bench traps:** the panel auto-closes in 8 s — tap a tile within two tool calls of opening it. A static simulator
location never pushes the camera, so the crew-return fly needs a `simctl location start` stream (started BEFORE launch).
Report tiles post REAL hazards as Jeff, broadcast at once to every connected tester — test from a remote spot (e.g.
51.55, −121.30) and clean up with the pin card's **Remove my alert** (DELETE clears Mongo + Supabase and broadcasts
`hazard_removed`). Expiring the Supabase row by SQL leaves the Mongo copy live for `GET /hazards` and Scout's agent tool.

**Dead or stale code:** `handleHazardLongPress` is still passed as `onHazardLongPress`, but `ConvoyMapbox` declares that
prop and never reads it (dropped in `15fd7e18`); `HazardMarker`'s `onLongPress` (no caller passes it); `reportAlert` /
`onReportPolice` and `ConvoyCarPlay.tsx` `onReportPoliceRef` (assigned, never invoked); `hazardColor` / `hazardIcon` in
`map.tsx`; `hazardAheadKindWord` (only the gate uses it); the exported-but-unused `ReportToast`. The `showHazards` "layer
toggle" has no setter. Stale comments: `map.tsx` `reportHazard` "≈40m forward" (it posts the 5 s-ago position) and
"(ReportToast)"; the WebSocket comment "hazard_removed (… or expiry)" (nothing broadcasts on expiry); `deleteHazard`
"Backend already authorizes" and "long-press / right-click flow"; the crew FAB's "hazard long-press"; the hazard-ahead
effect's "Hazards layer toggle"; `HazardMarker`'s "police.png … long-press"; the `AlertToast.tsx` header; backend
`dispute_hazard` ("new clients call DELETE") and `confirm_hazard` ("30-min expiry"). An older setup doc lives at the repo
root, `../HAZARDS_SUPABASE_SETUP.md`: its schema HAS a `disputes` column and a migration to add it, but the live table
has none — the migration was never run.
