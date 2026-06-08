# Convoy vehicle map-marker assets

How the car markers on the map are built and how to add a new make/model/color.

## The rule (do not regress this)

Car markers render through react-native-maps' **native `image` prop** in
`src/ConvoyMap.tsx` (`CarMarker`). Do **not** go back to capturing a child
`<View>`/`<Image>` into a marker bitmap.

Why: on Android under the New Architecture, that view-to-bitmap capture collapses
our tall, narrow top-down car PNGs into a full-height **~1px-wide vertical sliver**
(red for red cars, etc.). `resizeMode`, `resizeMethod`, and `collapsable` tweaks
do not fix it because they all still go through the capture. The `image` prop
draws the PNG directly: no capture, no sliver, and it behaves the same on iOS.

## Why the density set exists

The `image` prop renders a PNG at its **own pixel size**, so each color ships a
marker-sized density set (React Native auto-picks by screen density):

| file              | size   | density |
|-------------------|--------|---------|
| `<color>.png`     | 44 px  | @1x     |
| `<color>@2x.png`  | 88 px  | @2x     |
| `<color>@3x.png`  | 132 px | @3x     |

44 px @1x makes the marker render at ~44 dp. A single 128/512 px file would
render as a giant marker (and was part of the old sliver problem).

## Folder layout

```
assets/vehicles/
  _src/                     <- full-res master PNGs (one per color). DEV ONLY.
    heavy_metal.png            Not referenced by any require(), so never shipped.
    supersonic_red.png         Keep the highest-res version you have here.
    ...
  heavy_metal.png           <- generated 44 px   (these are what the app uses)
  heavy_metal@2x.png        <- generated 88 px
  heavy_metal@3x.png        <- generated 132 px
  ...
```

Masters in `_src/` are the source of truth; the density files are generated.

## Add a new car

1. Put a full-res top-down PNG in `assets/vehicles/_src/` named `<color_key>.png`
   - transparent background, top-down orientation, pointing "up"
   - >= 132 px, ideally 256-512 px for crisp @3x
2. Generate the density set:
   ```
   powershell -ExecutionPolicy Bypass -File "C:\Users\bigpe\Desktop\convoy\gen-marker-assets.ps1"
   ```
3. Wire it into `src/vehicleAssets.ts`:
   - add the key to the `GRCColorKey` union
   - add the `require("../assets/vehicles/<color_key>.png")` line to `VEHICLE_PNG`
   - add human/snake/slug spellings to `ALIASES`
4. `npx tsc --noEmit`, then `eas update --branch preview` (assets ride the OTA;
   no native build needed).

## Notes

- The generator preserves transparency and never overwrites `_src/` masters, so
  it is safe to re-run any time.
- First run auto-seeds `_src/` from the existing `@3x` files, so the 5 original
  GRC colors come under management without their originals. (Re-running does not
  require a new OTA — the regenerated files match what is already live.)
- Leader cars are not size-bumped anymore (the `image` prop renders every car at
  the asset size); they stay visually on top via higher `zIndex`. If a bigger
  leader marker is ever wanted, ship a separate larger leader asset.
