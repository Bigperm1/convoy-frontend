// hazard_panel_test — the head-unit Report panel (src/carplay/hazardPanel.ts): every tile reports a kind the backend
// accepts (or is the compass), the grid fits both head units, every glyph has all four metals, the ids are unique.
//   node --experimental-strip-types tools/sim-qc/hazard_panel_test.mts
import { readFileSync } from "node:fs";
import {
  HAZARD_TILES, HAZARD_REPORT_KINDS, HAZARD_BUTTON_ID, HAZARD_BUTTON_LABEL, HAZARD_BUTTON_GLYPH, HAZARD_TEMPLATE_ID,
  CARPLAY_GRID_MAX, AA_GRID_MAX, hazardTile, hazardTapLabel, hazardGridButtons, hazardGridConfigAA,
} from "../../src/carplay/hazardPanel.ts";

let fails = 0;
const ok = (name: string, cond: boolean, detail = "") => { console.log(`${cond ? "  ok  " : "  FAIL"} ${name} ${detail}`); if (!cond) fails++; };

// The backend's own list, read from server.py so the two cannot drift silently.
const serverPy = (() => { try { return readFileSync("/Users/jeffmorton/convoy-backend/server.py", "utf8"); } catch { return ""; } })();
const m = serverPy.match(/body\.kind not in \(([^)]*)\)/);
const backendKinds = m ? m[1].split(",").map((x) => x.trim().replace(/['"]/g, "")).filter(Boolean) : null;

ok("A1 five tiles: four reports + the compass", HAZARD_TILES.length === 5 && HAZARD_TILES.filter((t) => t.kind).length === 4 && HAZARD_TILES[HAZARD_TILES.length - 1].kind === null);
ok("A2 every report kind is one POST /hazards accepts", HAZARD_TILES.every((t) => t.kind == null || HAZARD_REPORT_KINDS.includes(t.kind)));
ok("A3 …and HAZARD_REPORT_KINDS matches server.py exactly", backendKinds != null && backendKinds.length === HAZARD_REPORT_KINDS.length && backendKinds.every((k) => (HAZARD_REPORT_KINDS as readonly string[]).includes(k)), backendKinds ? backendKinds.join(",") : "server.py not readable here");
ok("A4 no speed-camera tile until the backend has the kind", !HAZARD_TILES.some((t) => t.glyph === "hz_camera"));
ok("A5 ids unique, titles ≤ 12 chars, every report has a done pill", new Set(HAZARD_TILES.map((t) => t.id)).size === HAZARD_TILES.length && HAZARD_TILES.every((t) => t.title.length <= 12) && HAZARD_TILES.every((t) => t.kind == null || t.done.length > 0));
ok("A6 fits CarPlay (≤ 8) and Android Auto (≤ 6)", HAZARD_TILES.length <= AA_GRID_MAX && AA_GRID_MAX <= CARPLAY_GRID_MAX);
ok("A7 the map button: car-hazards / 'Hazards' / the triangle glyph", HAZARD_BUTTON_ID === "car-hazards" && HAZARD_BUTTON_LABEL === "Hazards" && HAZARD_BUTTON_GLYPH === "hz_hazard" && hazardTapLabel("car-hazards") === "Hazards" && hazardTapLabel("car-crew") === null);
ok("A8 hazardTile resolves ids and rejects strangers", hazardTile("hz-crash")?.kind === "accident" && hazardTile("hz-compass")?.kind === null && hazardTile("nope") === null && hazardTile(undefined) === null);

// B · the shapes both ports read
const btns = hazardGridButtons((g) => `icon:${g}`);
ok("B1 iOS grid buttons: id + titleVariants[0] + image, in tile order", btns.length === 5 && btns.every((b, i) => b.id === HAZARD_TILES[i].id && b.titleVariants[0] === HAZARD_TILES[i].title && b.image === `icon:${HAZARD_TILES[i].glyph}`));
const aa = hazardGridConfigAA((g) => `icon:${g}`);
ok("B2 Android Auto config: type grid, our id, a back header action, the same buttons", aa.type === "grid" && aa.id === HAZARD_TEMPLATE_ID && aa.headerAction.type === "back" && aa.buttons.length === 5 && aa.buttons[4].id === "hz-compass");

// C · every glyph the panel names is baked in all four metals (carButtonIcons.ts is RN-free text: check the table)
const icons = readFileSync(new URL("../../src/carplay/carButtonIcons.ts", import.meta.url), "utf8");
for (const g of ["hz_police", "hz_crash", "hz_hazard", "hz_traffic", "hz_camera", "hz_compass"]) {
  const row = icons.match(new RegExp(`^  ${g}: \\{[^\\n]*\\}`, "m"))?.[0] ?? "";
  ok(`C ${g} has brand / premium / ultra / diamond art`, ["brand:", "premium:", "ultra:", "diamond:"].every((k) => row.includes(k)));
}
ok("C car-hazards uses CAR_ICON_HAZARDS in the static config and carIcon(HAZARD_BUTTON_GLYPH) live", (() => {
  const a = readFileSync(new URL("../../src/carplay/carActions.ts", import.meta.url), "utf8");
  return a.includes("{ id: HAZARD_BUTTON_ID, image: CAR_ICON_HAZARDS, focusedImage: CAR_ICON_HAZARDS }") && a.includes("carIcon(HAZARD_BUTTON_GLYPH, s)") && !/id: 'car-compass', image/.test(a) && a.includes("if (id === 'car-compass') { emitCarGesture({ kind: 'compass' }); return; }");
})());

// D · the phone (Jeff, 2026-09-24: "WHERE IS THE HAZARDS BUTTON ON THE PHONE?"): the same tiles, one source of truth
{
  const sheet = readFileSync(new URL("../../src/components/HazardSheet.tsx", import.meta.url), "utf8");
  const mapTsx = readFileSync(new URL("../../app/(app)/map.tsx", import.meta.url), "utf8");
  ok("D1 the phone sheet builds its tiles from HAZARD_TILES (no second list)", sheet.includes("HAZARD_TILES.filter(") && !/\{ id: 'hz-/.test(sheet));
  ok("D2 the phone sheet has art for every report glyph in all four metals", ["hz_police", "hz_crash", "hz_hazard", "hz_traffic"].every((g) => new RegExp(`${g}:\\s*\\{ brand: require\\(.*premium: require\\(.*ultra: require\\(.*diamond: require\\(`).test(sheet)));
  ok("D3 map.tsx mounts the Hazards FAB and the sheet, and the tap reports through reportHazard", mapTsx.includes('testID="hazards-fab"') && mapTsx.includes("<HazardSheet") && mapTsx.includes("return reportHazard(kind)"));
  ok("D5 the sheet dismisses when turn-by-turn starts and holds off a second tap while a report is in flight", mapTsx.includes('dismiss={navMode === "turn-by-turn"}') && sheet.includes("if (visible && dismiss && !was) onClose();") && sheet.includes("const prevDismiss = useRef(!!dismiss);") && sheet.includes("if (_reportBusy) return;") && sheet.includes("finally(() => { _reportBusy = false; })"));
  ok("D6 the panel wears the weather forecast card's floor + tinted GlassFill and is no longer a Modal sheet (Jeff, 2026-09-24: same opacity as the weather panel)", sheet.includes('backgroundColor: "rgba(24,24,28,0.66)"') && sheet.includes("<GlassFill tintColor={hudTint()}") && !sheet.includes("<Modal") && sheet.includes('style={[StyleSheet.absoluteFill, { zIndex: Z_CARD - 1 }]} onPress={onClose}'));
  ok("D7 the panel anchors ABOVE the measured FAB stack and is CENTRED on the screen (Jeff, 2026-09-25)", sheet.includes("left: Math.round((winW - cardW) / 2)") && !sheet.includes("right: RIGHT_INSET") && mapTsx.includes("anchorBottom={controlsBottom + fabStackH}") && mapTsx.includes("onLayout={(e) => setFabStackH(e.nativeEvent.layout.height)}") && sheet.includes("Math.min(anchorBottom + GAP_ABOVE_STACK, Math.max(0, winH - TOP_CLEAR - cardH))") && sheet.includes("const RIGHT_INSET = 12;") && mapTsx.includes("    right: 12,\n    bottom: 90,"));
  ok("D8 the backdrop and card sit above the top bar / H button (zIndex 100) so a tap on them closes the panel instead of reaching them (sim, 2026-09-24: a search-bar tap went THROUGH the first cut)", sheet.includes("const Z_CARD = 301;") && sheet.includes("{ zIndex: Z_CARD - 1 }") && sheet.includes("zIndex: Z_CARD,") && mapTsx.includes("zIndex: 100,") && !/zIndex:\s*[3-9]\d\d,/.test(mapTsx.replace(/zIndex:\s*9{3,}/g, "")));
  ok("D9 Android Back closes the panel (Codex r2 — the Modal's onRequestClose went with the Modal)", sheet.includes('BackHandler.addEventListener("hardwareBackPress", () => { onClose(); return true; })') && sheet.includes("return () => sub.remove();"));
  ok("D4 phone FAB order top→bottom = compass (the mic's slot) · Hazards · 2D/3D · Crew (Jeff, 2026-09-24)", ['testID="compass-fab"', 'testID="hazards-fab"', 'testID="view-2d-3d-fab"', 'testID="crew-fit-fab"'].map((t) => mapTsx.indexOf(t)).every((v, k, arr) => v >= 0 && (k === 0 || arr[k - 1] < v)));
}

// E · the head-unit column (Jeff, 2026-09-24: "Top - mic, Second from top - hazards, Second from bottom - 2D/3D, Bottom - crew")
{
  const acts = readFileSync(new URL("../../src/carplay/carActions.ts", import.meta.url), "utf8");
  const ids = (block: string) => [...block.matchAll(/\{ id: ('[a-z-]+'|HAZARD_BUTTON_ID),/g)].map((m) => m[1]);
  const slice = (from: string) => { const k = acts.indexOf(from); return acts.slice(k, acts.indexOf("]", k)); };
  const cp = ["'car-comms'", "HAZARD_BUTTON_ID", "'car-view'", "'car-crew'"];
  ok("E1 CAR_MAP_BUTTON_CONFIG is mic · hazards · 2D/3D · crew", JSON.stringify(ids(slice("export const CAR_MAP_BUTTON_CONFIG"))) === JSON.stringify(cp));
  ok("E2 carMapButtonConfig() (the skinned build) keeps that order", JSON.stringify(ids(slice("export function carMapButtonConfig()"))) === JSON.stringify(cp));
  const aa = ["'car-zoom-in'", "'car-zoom-out'", "HAZARD_BUTTON_ID", "'car-crew'"];
  ok("E3 AA_MAP_BUTTONS puts hazards above crew", JSON.stringify(ids(slice("export const AA_MAP_BUTTONS"))) === JSON.stringify(aa));
  ok("E4 aaMapButtons() (the skinned build) keeps that order", JSON.stringify(ids(slice("export function aaMapButtons()"))) === JSON.stringify(aa));
}

console.log(fails === 0 ? "\nPASS hazard_panel" : `\nFAIL hazard_panel (${fails})`);
if (fails) process.exit(1);
