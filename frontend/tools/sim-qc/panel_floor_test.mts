// panel_floor_test — every floating map panel shares ONE floor (src/panelFloor.ts = the weather forecast card's), the
// Report panel and the tapped-pin card carry no GlassFill on top of it, and the category drop-down + More panel hang
// UNDER the chip row as overlays that layer over the crew / version pill (Jeff, 2026-09-25).
//   node --experimental-strip-types tools/sim-qc/panel_floor_test.mts
import { readFileSync } from "node:fs";
import { PANEL_FLOOR, PANEL_BORDER, PANEL_RADIUS } from "../../src/panelFloor.ts";
let fails = 0;
const ok = (name: string, cond: boolean, detail = "") => { console.log(`${cond ? "  ok  " : "  FAIL"} ${name} ${detail}`); if (!cond) fails++; };
const read = (p: string) => readFileSync(new URL("../../" + p, import.meta.url), "utf8");
const wx = read("src/components/WeatherHUD.tsx"), sheet = read("src/components/HazardSheet.tsx"), card = read("src/components/HazardCard.tsx"), pills = read("src/components/CategoryPills.tsx");
ok("P1 the floor is the forecast card's", PANEL_FLOOR === "rgba(24,24,28,0.66)" && PANEL_BORDER === "rgba(255,255,255,0.14)" && PANEL_RADIUS === 16);
ok("P2 the forecast card, the Report panel, the tapped-pin card, the results drop-down and the More panel all use it", [wx, sheet, card].every((s) => s.includes("backgroundColor: PANEL_FLOOR") && s.includes("borderColor: PANEL_BORDER")) && (pills.match(/backgroundColor: PANEL_FLOOR/g) || []).length === 2);
ok("P3 no GlassFill over the floor on the Report panel, the card, the drop-down or the More panel", !sheet.includes("<GlassFill") && !card.includes("<GlassFill") && !pills.includes("<GlassFill tintColor={drawerTint()}"));
ok("P4 the More panel is an overlay under the chip row (no Modal), toggled by the More chip, folding on a pick", !pills.includes("<Modal") && pills.includes('testID="cat-more-panel"') && pills.includes("{ top: rowH + ROW_GAP, opacity: moreAnim") && pills.includes("onPress={() => { setListOpen(false); setMoreOpen((v) => !v); }}") && pills.includes("onPress={() => { setMoreOpen(false); setListOpen(false); run(cat); }}"));
ok("P5 the drop-down hangs under the row too, and the block is raised above the crew pill while either is open", pills.includes('position: "absolute", left: 0,\n    width: "92%"') && pills.includes("{ top: rowH + ROW_GAP, opacity: dropAnim") && pills.includes("wrapRaised: { zIndex: 40, elevation: 40 }") && pills.includes("(moreOpen || (activeKey && listOpen)) ? styles.wrapRaised : null"));
console.log(fails === 0 ? "\nPASS panel_floor" : `\nFAIL panel_floor (${fails})`);
