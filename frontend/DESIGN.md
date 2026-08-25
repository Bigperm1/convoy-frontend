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
<!-- ═════════ END RULE #1 ═════════ -->

# DESIGN — the tier visual language

**STATUS: LOCKED as of 2026-08-23** (Jeff's call). Same standing as `CARPLAY.md`:
change the values here only with his say-so, and change them *here* — never per screen.

> Jeff, 2026-08-23: *"change the ultra Premium colours to Gold and the Premium colours
> to Silver replacing the green… create a GoldSilver H hairpin logo as the Lock Ultra
> Premium/Premium Locks."*

---

## 1 · The three metals

| Treatment | Means | Where it comes from |
|---|---|---|
| **Green** (brand) | "This is yours." Untiered. | `CANDY_COLORS` in `src/components/ManeuverArrow.tsx` |
| **Silver** | **Premium** — rank 1 | `TIER_SKIN.premium` in `src/tierTheme.ts` |
| **Gold** | **Ultra Premium** — rank 2 | `TIER_SKIN.ultra` in `src/tierTheme.ts` |

**The rule: green means yours, metal means a tier.** Mixing them is what makes a
paywall feel like a feature and a feature feel like a paywall. A screen is one
metal all the way through — a gold page has no green accents left on it.

### Measured stops

All three are the same construction — the map banner's candy language: a
three-stop vertical gradient at `locations [0, 0.45, 1]` plus a pale hairline rim.
A gold CTA and a green one are the same object in different metal.

| | light | mid | deep | rim | ink |
|---|---|---|---|---|---|
| brand | `#8CFFC4` | `#2DEC86` | `#0E9B58` | `rgba(150,255,200,0.55)` | `#04150B` |
| premium | `#FFFFFF` | `#C9D2D8` | `#7E878E` | `rgba(255,255,255,0.62)` | `#14181B` |
| ultra | `#F6D77A` | `#E0A93E` | `#B97F1F` | `rgba(255,231,163,0.62)` | `#3A2A05` |

The gold stops are **not new** — they are the ones `PremiumBadge` has always used,
lifted into `tierTheme.ts` so the pill and the page can never disagree about what
gold is.

### The page's wallpaper wears the page's metal

> Jeff, 2026-08-24: *"change the background wallpaper to have a gold line too."*

`glass-bgt.png` is the neon road behind the glass. A green road under a gold page
broke "a screen is ONE metal", so it is now three assets picked by tier:

| tier | asset |
|---|---|
| brand | `assets/images/glass-bgt.png` (original) |
| premium | `assets/images/glass-bgt-silver.png` |
| ultra | `assets/images/glass-bgt-gold.png` |

Both derived from the original by **hue rotation, not tint** — `tintColor` flattens
every non-transparent pixel to one colour and destroys the image. The trail sits at
125°; gold rotates it to the ultra ramp's 40°, silver desaturates to 16% with the
premium ramp's cool cast. Only ~3.6% of the image is lit, so the rotation only ever
touches the road and grid. `TIER_WALLPAPER` in `app/(app)/garage.tsx` holds the three
`require()`s — they **must** be static and at module level or Metro cannot bundle them.

Everything tier-coloured on the page follows the same `skin(pageTier).accent`: the
personal-best number, the call-sign icon, the speed badge, the Apply/Save CTAs.
The Arrow/Class/3D option tiles keep their OWN artwork colours — a green arrow glyph
on a gold page is the arrow's identity, not a stray accent.

`accent` is the mid-tone for text/icons on a DARK ground (`#2DEC86` / `#C9D2D8` /
`#E0A93E`); `ink` is for glyphs riding ON the fill. Never use `ink` on black.

---

## 2 · The H is the lock

`assets/images/tier/h-silver.png` and `h-gold.png` (@1x/@2x/@3x). The Hairpin H
cut from `assets/hairpin-adaptive.png` — green-dominance mask, largest connected
component, holes filled, then re-metalled with the ramps above while keeping the
original bevel's luma so it still reads dimensional.

**A silver H means Premium. A gold H means Ultra Premium.**

Why the H and not a padlock: a padlock says *"you can't have this."* The H says
*"this is the part of Hairpin you haven't got yet"* — the same mark the app wears
everywhere, in a different metal. It sells; a padlock only refuses.

Components in `src/PremiumBadge.tsx`:

| Component | Use |
|---|---|
| `TierLock` | the H on its own — settings rows, inline |
| `TierCornerLock` | absolute corner mount for option tiles/cards |
| `PremiumBadge` | the metal pill; `tier` picks metal **and** wording |
| `TierTitle` | the page header — H + "PREMIUM" / "ULTRA PREMIUM" |

**Legibility floor: 20 px.** Verified at 44/28/20 px on black. Below 20 the bowl
of the H closes up — use the pill instead.

---

## 3 · Every tiered page says which tier it is

> Jeff: *"lets put a title up top of the Ultra Premium pages 'Ultra Premium' same
> with the 'Premium' pages."*

`<TierTitle tier="ultra" />` at the top of the content, above the page's own H1.
A customer must never have to infer the tier from colour alone — colour is
reinforcement, the word is the fact. (It is also the accessible path: the metals
differ in hue but both are light-on-dark, so colour alone fails anyone who can't
separate them.)

Today: the Garage Scan flow (`garage-scan` → `garage-consent` → `garage-capture`)
is **Ultra Premium / gold**. The Garage itself is untiered and stays green.

---

## 4 · Never hardcode the metal

The tier comes from the entitlement ladder, always:

```ts
const tier = useFeatureTier('class_marker');   // -> "premium"  -> silver
const tier = useFeatureTier('car_3d');         // -> "ultra"    -> gold
```

`featureTier()` (`src/entitlements.ts`) reads `FEATURE_RANK`, so moving a feature
between tiers changes its metal everywhere at once. Writing `tier="ultra"` next to
a *feature gate* is a bug waiting to happen — pass the feature and let it derive.

**What this fixed:** before 2026-08-23 the Class tile (premium) and the 3D tile
(ultra) rendered an **identical gold `PREMIUM` badge**. The screen was quietly
telling customers the two cost the same thing.

A locked row is a **buy button, not a dead row** — the whole row opens the paywall.

---

## 5 · Where the locks are

| Surface | Feature | Metal |
|---|---|---|
| Garage → Map Appearance → Class | `class_marker` | silver |
| Garage → Map Appearance → 3D | `car_3d` | **gold** |
| Settings → Map Layers → Speed cameras | `speed_cameras` | silver |
| Settings → Map Layers → Road incidents | `road_incidents` | silver |
| Settings → Scout & Voice → Hands-free replies | `comms_handsfree` | silver |
| Showroom cards | `class_marker` / `car_3d` | silver / gold |

`ToggleRow` takes a `feature` prop — that is the whole integration. The rest of
the ladder's keys (`map_modes`, `route_colors`, `voice_extras`, `spoken_extras`,
`speed_alert`, `top_speed`, `club_create`, `convoy_size`) are **not wired yet**;
add `feature=` to their rows when their tiering is settled.

⚠️ `ENTITLEMENTS_ENFORCED = false` in `src/entitlements.ts`, so **none of this
renders for today's testers** — every gate answers "unlocked". To see it, flip
that flag and use `__setDevTier('free' | 'premium' | 'ultra')`.

---

## 6 · Class colour palettes — the naming rule

Every class carries a **named** palette. Two doctrines, both Jeff's (2026-08-20 night):

1. **Cover the core colours** — black / white / grey / red / blue / green plus that
   scene's signature paints.
2. **Name every swatch after a REAL paint from that class's marques.** Never
   "Blue 2". A hot-hatch blue is *Nitrous Blue* or *WR Blue Pearl*; a muscle purple
   is *Plum Crazy*. The name is half the product.

`hex` is the swatch **and** the live tint intent. ⚠️ The tint multiplier sent to the
model runs roughly **2× hot** because it MULTIPLIES a mid-grey texture — the swatch
hex is not the number the shader receives.

Two kinds of class, and they are not interchangeable:

| kind | how colour works | classes |
|---|---|---|
| **Authored per-colour** | each swatch routes to its OWN baked GLB via `modelKey` | hatchback · supercar · exotic |
| **Tinted base** | one neutral GLB (`baseUrl`), tinted live per swatch | muscle (+ future packs) |

### Live palettes — `src/classModels.ts`

| class | archetype | colours | source |
|---|---|---|---|
| **hatchback** "Hot Hatch" | GR Corolla | **6** — Heavy Metal · Supersonic Red · Icecap White · Blue Flame · Black Onyx · Gravel | authored GLB per colour |
| **supercar** | 911 GT3 RS | **7** — Guards Red · GT Silver · Carrara White · Jet Black · Miami Blue · Python Green · Shark Blue | authored GLB per colour |
| **exotic** | LFA | **5** — Whitest White · Absolutely Red · Pearl Yellow · Pearl Blue · Matte Black | authored GLB per colour |
| **muscle** | generated coupe | **10** — Pitch Black · Wimbledon White · Lead Foot Grey · TorRed · Grabber Blue · B5 Blue · Rally Green · Plum Crazy · Go Mango · Sublime | tinted base GLB |

**Hot Hatch IS the GR Corolla** — its palette is the real GRC colour list, so a tester
who already picked a paint keeps their exact colour when the tiers land. Its six
`modelKey`s are the same authored GLBs 3D mode renders today.

Bakes queued, not yet in the palettes: Hot Hatch +Liquid Yellow, Nitrous Blue,
WR Blue Pearl, Ultimate Green · Supercar +Nardo Grey, Rosso Corsa, Giallo Modena,
Verde Mantis, Midnight Purple, Riviera Blue, Arancio Borealis · Exotic +Rosso Corsa,
Verde Mantis, Papaya Spark, French Racing Blue, Grigio Telesto.

**Classes with no `CLASS_MODEL_3D` row fall back to the top-down sprite** and have no
palette at all — sedan, truck, electric, jeep. Do not invent one; the row appears when
the model is authored.

⚠️ **`CLASS_MODEL_3D` is read by NOTHING on the map today** — `markerType === 'class'`
renders the flat top-down sprite, and the only consumer is `showroom.tsx`, which is
registered `href: null` with nothing routing to it. The class-3D map rendering is still
to be built.

---

## 7 · The APP SKIN — the whole app wears your tier's metal

> Jeff, 2026-08-24: *"could we make it so everything on the app turns to silver and
> gold when the tier are purchased… when silver is purchased you can switch back to
> green but cant get gold? another Ultra feature???"*

Yes — and **the ladder is the feature.** The metal ARRIVES with the tier; the CHOICE
is what Ultra buys.

| tier | app skin | may switch to |
|---|---|---|
| Free | green | — |
| Premium | **silver** | green |
| Ultra | **gold** | gold · silver · green |

`Settings → App Skin`. Default is **Automatic**, so the metal appears on purchase with
nothing to find. Mechanism is `src/appSkin.ts` (`useAccent`, `useAccentAlpha`,
`useAppSkin`, `accentNow`) — a module bus, because CarPlay and Android Auto are separate
React trees with no shared provider. `app_skin_silver` (rank 1) and `app_skin_gold`
(rank 2) are TWO features, because one `FEATURE_RANK` entry cannot express two gates.

The ladder is enforced in `setSkinChoice()`, not merely hidden in the UI, and a stored
choice is **clamped to entitlement at read time** — a lapsed subscription falls back on
its own instead of leaving a gold app behind a dead card, while remembering the pick.

### ⛔ What the skin must NEVER touch

1. **The map.** `CONGESTION_COLOR` is clear `#2DEC86` → slowing `#FFD60A` → congested
   `#FF9500`, and our gold `#E0A93E` **lands between the last two**. A gold route line
   reads as traffic ahead at speed. Route line, congestion, hazards, speed-camera pins,
   the reroute-offer pill and the green arrow all stay brand green.
2. **Tier locks.** They follow `useFeatureTier(feature)`. A gold H must keep meaning
   *Ultra* — if the whole app is already gold, the lock stops selling anything.
   **Chrome wears YOUR metal; paywall surfaces wear the FEATURE's metal.** That is how
   this coexists with §1's "green means yours, metal means a tier".
3. **Success states**, where green means *good* — gold reads as a warning.
4. **Anything pinned to a baked green asset** that cannot follow: the Hairpin wordmark
   and app icon (brand marks stay green — like every app whose logo survives its
   themes), the CarPlay base64 button icons, and the mic-glow PNG.

### Two traps this uncovered

**The green is often not written as green.** ~50 sites use `rgba(45, 236, 134, α)` —
which IS `#2DEC86` (45,236,134 = 0x2D,0xEC,0x86) — so a hex-only search misses them.
Use `useAccentAlpha(α)`: a naive opaque override turns a 14% tint WELL into a solid
disc, a regression at green tier too.

**A legend has two halves.** The drawer's numbered stop badge pairs with the numeral on
the map pin. The pin can't follow the skin, so the badge doesn't either — fill, ring and
numeral stay green together. Any pair like this moves as one or not at all.

### The tab bar needed new assets, and a fix

`tabBarActiveTintColor` cannot reach the glyphs — they are pre-rendered PNG pairs. So
`_gold` / `_silver` variants exist alongside each `_on`, and the tint moves WITH them;
skinning either alone is what would look broken. Inactive was also changed from
`#FFFFFF` to `#8E8E93`: pure white was *brighter* than the active label, which green got
away with on hue alone but silver could not.

---

## 8 · Only CLASS has a flat sprite

> Jeff, 2026-08-24: *"the sprite is only for the classes section the ultra premium
> will not have a sprite."*

| tier | at rest (2D view) | routing (3D view) |
|---|---|---|
| Arrow (free) | green arrow GLB | green arrow GLB |
| **Class** (silver) | **flat top-down sprite** | arrow GLB |
| **3D / Ultra** (gold) | **its GLB** | its GLB |

**Why the Ultra car lost its sprite.** The flat sprite is the *authored* GR Corolla
PNG. From build 74 the 3D tier is a **Tripo scan of the driver's own car**, which has
no flat twin — so drawing the sprite at rest put *somebody else's car* on the map for
every scanned driver. The arrow already followed exactly this rule ("it has no flat
twin"), and the 3D tier now does too.

⚠️ **This narrows the 2026-08-18 rule in `src/mapViewMode.ts`** ("IDLE = 2D flat + the
512px sprites, everywhere including the car surfaces"). That rule now applies to
**Class and peers only** — the 2D/3D button still flattens the *camera* for the Ultra
tier, it just no longer swaps the car's artwork. Both `ConvoyMapbox.tsx` and
`carplay/CarMapView.tsx` were changed together; do not fix one without the other.

🔎 **OPEN — what do PEERS see of a scanned car?** Peer markers still resolve through
`getVehiclePngOrDefault(car.color)`, i.e. the authored PNG, so a scanned driver still
appears to *others* as a stock GR Corolla. Rendering N peer GLBs is a separate
performance question and was NOT changed here.

---

## 9 · Class paints ONE colour

The Primary/Secondary slot pair is an **arrow** control — the arrow has a body and a
rim. A class sprite is a single colour, so the slot row asked a question with one
answer. Removed for class 2026-08-23; the arrow keeps both.
