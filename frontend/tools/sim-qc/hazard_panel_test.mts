// hazard_panel_test — the head-unit Report panel (src/carplay/hazardPanel.ts): every tile reports a kind the backend
// accepts (or is the compass), the grid fits both head units, every glyph has all four metals, the ids are unique.
//   node --experimental-strip-types tools/sim-qc/hazard_panel_test.mts
import { readFileSync } from "node:fs";
import {
  HAZARD_TILES, HAZARD_REPORT_KINDS, HAZARD_BUTTON_ID, HAZARD_BUTTON_LABEL, HAZARD_BUTTON_GLYPH, HAZARD_TEMPLATE_ID,
  CARPLAY_GRID_MAX, AA_GRID_MAX, HAZARD_PANEL_AUTO_CLOSE_MS, hazardTile, hazardTapLabel, hazardGridButtons, hazardGridConfigAA,
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
ok("A7 the map button: car-hazards / 'Hazards' / the CANDY triangle glyph (2026-09-25)", HAZARD_BUTTON_ID === "car-hazards" && HAZARD_BUTTON_LABEL === "Hazards" && HAZARD_BUTTON_GLYPH === "hz_hazard_candy" && hazardTapLabel("car-hazards") === "Hazards" && hazardTapLabel("car-crew") === null);
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
  ok("D5 the sheet dismisses when turn-by-turn starts and holds off a second tap while a report is in flight", mapTsx.includes('dismiss={navMode === "turn-by-turn"}') && sheet.includes("if (visible && dismiss && !was) close(\"nav\");") && sheet.includes("const prevDismiss = useRef(!!dismiss);") && sheet.includes("if (_reportBusy) return;") && sheet.includes("finally(() => { _reportBusy = false; })"));
  ok("D6 the panel wears the weather forecast card's floor + tinted GlassFill, inside a transparent Modal (its own window — the in-tree card painted on only some cold launches, 2026-09-25)", sheet.includes("backgroundColor: PANEL_FLOOR") && !sheet.includes("<GlassFill") && sheet.includes('<Modal transparent visible animationType="none" onRequestClose={() => close("back")}') && sheet.includes('style={StyleSheet.absoluteFill} onPress={() => close("tap")}'));
  ok("D7 the panel anchors ABOVE the measured FAB stack and is CENTRED on the screen (Jeff, 2026-09-25)", sheet.includes("left: Math.round((winW - cardW) / 2)") && !sheet.includes("right: RIGHT_INSET") && mapTsx.includes("anchorBottom={controlsBottom + fabStackH}") && mapTsx.includes("onLayout={(e) => setFabStackH(e.nativeEvent.layout.height)}") && sheet.includes("Math.min(anchorBottom + GAP_ABOVE_STACK, Math.max(0, winH - TOP_CLEAR - cardH))") && sheet.includes("const RIGHT_INSET = 12;") && mapTsx.includes("    right: 12,\n    bottom: 90,"));
  ok("D8 the card has NO entrance animation — every fade from opacity 0 left it unpainted on 13 of 15 sim launches (2026-09-25)", (() => { const code = sheet.replace(/\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, ""); return !code.includes("entering=") && !code.includes("Animated") && !/opacity:\s*[a-z0]/.test(code) && code.includes('<View\n        testID="hazard-sheet"'); })());
  ok("D9 NO BackHandler in the sheet — Android Back is the Modal's onRequestClose", !sheet.includes("BackHandler.addEventListener") && !/import \{[^}]*BackHandler/.test(sheet) && sheet.includes('onRequestClose={() => close("back")}'));
  ok("D10 an untouched panel closes itself on every surface (Jeff, 2026-09-25: auto disappears) — phone timer + both head-unit pushes arm the pop, any pop clears it", HAZARD_PANEL_AUTO_CLOSE_MS >= 5000 && HAZARD_PANEL_AUTO_CLOSE_MS <= 12000 && sheet.includes("setTimeout(() => close(\"auto\"), HAZARD_PANEL_AUTO_CLOSE_MS)") && sheet.includes("  }, [visible]);") && (readFileSync(new URL("../../src/carplay/carActions.ts", import.meta.url), "utf8").match(/armHazardsAutoPop\(\);/g) || []).length === 2 && readFileSync(new URL("../../src/carplay/carActions.ts", import.meta.url), "utf8").includes("if (_hazardsAutoPop) { clearTimeout(_hazardsAutoPop); _hazardsAutoPop = null; }\n  if (!_hazardsPushed) return;"));
  ok("D11 the Hazards FAB wears the candy triangle at 34 pt and the 2D/3D glyph is 42 pt (Jeff, 2026-09-25)", mapTsx.includes('HAZARD_FAB_ART[t]} style={{ width: 34, height: 34 }}') && mapTsx.includes("style={{ width: 42, height: 42 }}   // 42 pt") && sheet.includes('require("../../assets/images/premium/hazard_candy.png")') && sheet.includes("hazard_candy_diamond.png"));
  ok("D4 phone FAB order top→bottom = Hazards · 2D/3D (always) · Crew, no compass FAB (Jeff, 2026-09-25: \"The compass needs to be 2D/3D on the phone. And the hazard on the top\")", ['testID="hazards-fab"', 'testID="view-2d-3d-fab"', 'testID="crew-fit-fab"'].map((t) => mapTsx.indexOf(t)).every((v, k, arr) => v >= 0 && (k === 0 || arr[k - 1] < v)) && !mapTsx.includes('testID="compass-fab"') && !/navMode === "turn-by-turn" && \(\s*<PressableScale\s*testID="view-2d-3d-fab"/.test(mapTsx) && mapTsx.includes('if (navMode !== "turn-by-turn") { setMapView2D(true); showInfoToast("2D view"); return; }'));
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

// G · round three (Jeff, 2026-09-25): compass tile, category-coloured pins, the card, the pill, the Scout-timed prompt
{
  const sheet = readFileSync(new URL("../../src/components/HazardSheet.tsx", import.meta.url), "utf8");
  const card = readFileSync(new URL("../../src/components/HazardCard.tsx", import.meta.url), "utf8");
  const mapTsx = readFileSync(new URL("../../app/(app)/map.tsx", import.meta.url), "utf8");
  const mapbox = readFileSync(new URL("../../src/ConvoyMapbox.tsx", import.meta.url), "utf8");
  const pal = readFileSync(new URL("../../src/hazardPalette.ts", import.meta.url), "utf8");
  const pins = readFileSync(new URL("../../src/hazardPinImages.ts", import.meta.url), "utf8");
  const toast = readFileSync(new URL("../../src/components/AlertToast.tsx", import.meta.url), "utf8");
  ok("G1 the phone panel carries all five tiles, compass included, and the compass tile runs the 🔒 north-up toggle verbatim", sheet.includes("PANEL_TILES = HAZARD_TILES.filter(") && sheet.includes("hz_compass: { brand: require(") && sheet.includes("onCompass: () => void;") && mapTsx.includes("const onCompassTile = () => {") && mapTsx.includes("onCompass={onCompassTile}") && mapTsx.includes("// 🔒 NAV-LOCK begin map-compass-northup-toggle"));
  ok("G2 the colour family: Police = EV, Crash = Hospital, Hazard = Fast Food, Traffic = Gas", /police:\s*\{ cat: "ev"/.test(pal) && /accident:\s*\{ cat: "hospital"/.test(pal) && /road:\s*\{ cat: "fastfood"/.test(pal) && /traffic:\s*\{ cat: "gas"/.test(pal));
  ok("G3 four baked pins, and the map draws them on the phone layer AND the head-unit marker (no NeonPin hazard snapshots left)", ["police", "accident", "road", "traffic"].every((k) => new RegExp(`^  ${k}: "iVBOR`, "m").test(pins)) && mapbox.includes("...HAZARD_PIN_IMAGES,") && mapbox.includes("icon: hazardPinImageName(h.kind)") && mapbox.includes("iconImage: [\"get\", \"icon\"], iconSize: 1 / POI_PIN_SCALE") && mapbox.includes("<Image source={{ uri: hazardPinUri(hazard.kind) }}") && !mapbox.includes("name={`neon_hz_${k}`}"));
  ok("G4 the tapped-pin card and the pass-by prompt are the Report panel's twin (Modal, weather floor, anchored above the stack, big Remove) and the old Glass cards are gone", card.includes("<Modal transparent visible animationType=\"none\"") && card.includes("backgroundColor: PANEL_FLOOR") && card.includes("bottom = Math.min(anchorBottom + GAP_ABOVE_STACK") && card.includes("const BTN_H = 52;") && card.includes("Remove my alert") && mapTsx.includes('<HazardCard\n        hazard={selected}\n        mode="detail"') && mapTsx.includes('hazard={selected || showReport ? null : passPrompt}') && mapTsx.includes('mode="passby"') && !mapTsx.includes("style={styles.selectedCard}"));
  ok("G5 the report pill sits under the crew pill, dressed like it, in the kind's colour; the bottom toast is gone", toast.includes("export function ReportPill") && toast.includes("backgroundColor: rgba(p.bright, 0.30), borderColor: p.bright") && mapTsx.indexOf("styles.liveOverlayText") < mapTsx.indexOf("<ReportPill kind={alertConfirm} />") && !mapTsx.includes("<ReportToast"));
  ok("G6 the still-there prompt rides Scout's hazard-ahead call (someone else's pin, once, 15 s)", /announced\.add\(h\.id\);[\s\S]{0,900}setPassPrompt\(h\);[\s\S]{0,300}15000/.test(mapTsx) && mapTsx.includes("if (!promptTaken && !(user?.handle && h.reporter_handle === user.handle) && !promptedHazardsRef.current.has(h.id))"));
  ok("G7 the panel tiles wear the neon border in the kind's colour (compass = the metal's rim)", sheet.includes("const neonFor = (kind: HazardKind | null): string => (kind ? hazardPaint(kind).bright : NEON_TONE[metal].rim);") && sheet.includes("borderColor: neonFor(t.kind), shadowColor: neonFor(t.kind)") && sheet.includes("borderWidth: 1.5,"));
  ok("G8 Codex r4: one still-there card per run, none over the Report sheet, and the pill shows with the search bar hidden too", mapTsx.includes("let promptTaken = !!passPrompt || showReport;") && mapTsx.includes("if (!promptTaken && !(user?.handle && h.reporter_handle === user.handle)") && mapTsx.includes("hazard={selected || showReport ? null : passPrompt}") && mapTsx.includes("if (!coords || !showHazards || passPrompt || showReport) return;") && (mapTsx.match(/<ReportPill kind=\{alertConfirm\} \/>/g) || []).length === 2 && mapTsx.includes('{!searchVisible && (\n          <View pointerEvents="none" style={{ marginTop: navMode === "turn-by-turn" ? 100 : 8 }}>'));
  const crew = readFileSync(new URL("../../src/crewReturn.ts", import.meta.url), "utf8");
  ok("G9 the tile glyphs are tinted the SAME neon as their rim (compass keeps its metal art); the card glyph too", sheet.includes("...(t.kind ? { tintColor: neonFor(t.kind) } : null)") && card.includes("{ tintColor: paint.bright }"));
  ok("G10 Remove my alert deletes straight away — no confirm popup (Jeff, 2026-09-25)", mapTsx.includes("void deleteHazard(h.id); } }}") && !/onRemove=\{[^}]*handleHazardLongPress/.test(mapTsx));
  ok("G11 the Crew press arms a 7 s way home AFTER the 🔒 block, via recenterNow, cleared on re-press and unmount", /CREW_RETURN_MS = 7000;/.test(crew) && mapTsx.includes("// 🔒 NAV-LOCK end map-crew-fit-drops-follow\n            // The crew press") && mapTsx.includes("crewReturnRef.current = setTimeout(() => {\n              crewReturnRef.current = null;\n              recenterNow();") && mapTsx.includes("}, CREW_RETURN_MS);") && mapTsx.includes("useEffect(() => () => { if (crewReturnRef.current) clearTimeout(crewReturnRef.current); }, []);"));
}

console.log(fails === 0 ? "\nPASS hazard_panel" : `\nFAIL hazard_panel (${fails})`);
if (fails) process.exit(1);
