// hazardPanel.ts — the head-unit REPORT panel: what the Hazards map button opens (Jeff, 2026-09-24:
// "if i was to make the compass button the hazards, when tapping it could it bring up a menu to tap?" → "can we put the
// compass in the hazard pop up on carplay?" → "build the hazard panel with the apple glyphs i mentioned").
//
// PURE — no React Native, no CarPlay import — so tools/sim-qc/hazard_panel_test.mts can pin it in Node. The wiring
// (the CPGridTemplate / androidx GridTemplate push, the tap → POST /hazards, the pop) lives in carActions.ts.
//
// The compass map button becomes HAZARDS (CarPlay allows four map buttons and all four were taken; the 09-24 tester
// poll read Yes 1 / No 0 / Never 3 for the compass). The compass itself rides INSIDE the panel as the last tile and
// fires the same `compass` car gesture the button did, so the camera code is untouched.
//
// ⚠ SPEED CAMERA IS NOT A TILE. Its glyph exists (carButtonIcons `hz_camera`, baked with the set Jeff picked) but
// POST /hazards accepts exactly police / road / accident / traffic (server.py: `body.kind not in (...)`) and the phone
// draws pins for those four; a "speed camera" report would 400 or land as the wrong pin. Adding the kind is a backend +
// phone-pin + peers change, not a panel change — the tile joins the moment that ships.
export type HazardKind = 'police' | 'accident' | 'road' | 'traffic';
/** Exactly the kinds the backend accepts on POST /hazards, in its own order. */
export const HAZARD_REPORT_KINDS: readonly HazardKind[] = ['police', 'road', 'accident', 'traffic'];

export type HazardGlyph = 'hz_police' | 'hz_crash' | 'hz_hazard' | 'hz_traffic' | 'hz_camera' | 'hz_compass' | 'hz_hazard_candy';
export type HazardTile = {
  id: string;
  kind: HazardKind | null;   // null = not a report (the compass)
  title: string;             // the one title variant; head units truncate past ~12 characters
  glyph: HazardGlyph;
  done: string;              // the pill after a successful report
};

export const HAZARD_TILES: readonly HazardTile[] = [
  { id: 'hz-police',  kind: 'police',   title: 'Police',  glyph: 'hz_police',  done: 'Police reported ✓' },
  { id: 'hz-crash',   kind: 'accident', title: 'Crash',   glyph: 'hz_crash',   done: 'Crash reported ✓' },
  { id: 'hz-hazard',  kind: 'road',     title: 'Hazard',  glyph: 'hz_hazard',  done: 'Hazard reported ✓' },
  { id: 'hz-traffic', kind: 'traffic',  title: 'Traffic', glyph: 'hz_traffic', done: 'Traffic reported ✓' },
  { id: 'hz-compass', kind: null,       title: 'Compass', glyph: 'hz_compass', done: '' },
];

export const HAZARD_BUTTON_ID = 'car-hazards';       // the map button (replaces car-compass in the column)
export const HAZARD_BUTTON_LABEL = 'Hazards';        // its tap-receipt pill ("Hazards ✓")
export const HAZARD_BUTTON_GLYPH: HazardGlyph = 'hz_hazard_candy';   // the candy finish, like the crew / view buttons (2026-09-25); the grid tile stays flat
export const HAZARD_TEMPLATE_ID = 'hairpin-car-hazards';
export const HAZARD_PANEL_TITLE = 'Report';
/** CPGridTemplate shows at most 8 buttons (CPGridTemplateMaximumItems); androidx's grid list defaults to 6. */
export const CARPLAY_GRID_MAX = 8;
export const AA_GRID_MAX = 6;
/** A Report panel nobody taps folds itself away after this — phone sheet and both head-unit grids alike (Jeff,
 *  2026-09-25: "MAKE SURE THE PANEL AUTO DISAPPEARS TOO"). Long enough to read four tiles, short enough never to sit
 *  over guidance. On a locked phone CarPlay's JS timers can be frozen (memory: js-timers-frozen-on-locked-carplay), so the
 *  head-unit pop may wait for the next tick; the back chevron and the tiles always work. */
export const HAZARD_PANEL_AUTO_CLOSE_MS = 8000;

export function hazardTile(id: string | null | undefined): HazardTile | null {
  if (!id) return null;
  return HAZARD_TILES.find((t) => t.id === id) ?? null;
}
/** The tap pill for the map button — carTap's TAP_LABEL is value-locked, so the new id resolves here. */
export function hazardTapLabel(id: string): string | null {
  return id === HAZARD_BUTTON_ID ? HAZARD_BUTTON_LABEL : null;
}
/** The grid buttons in the shape BOTH ports read: `id`, `titleVariants[0]`, `image` (androidx RCTTemplate.parseGridItem
 *  reads exactly those keys; CPGridButton takes titleVariants + image). `iconFor` resolves the metal. */
export function hazardGridButtons<I>(iconFor: (glyph: HazardGlyph) => I): { id: string; titleVariants: string[]; image: I }[] {
  return HAZARD_TILES.map((t) => ({ id: t.id, titleVariants: [t.title], image: iconFor(t.glyph) }));
}
/** Android Auto: the createTemplate config for the same panel (TemplateParser: "grid" → RCTGridTemplate). */
export function hazardGridConfigAA<I>(iconFor: (glyph: HazardGlyph) => I) {
  return { type: 'grid', id: HAZARD_TEMPLATE_ID, title: HAZARD_PANEL_TITLE, headerAction: { type: 'back' }, buttons: hazardGridButtons(iconFor) };
}
