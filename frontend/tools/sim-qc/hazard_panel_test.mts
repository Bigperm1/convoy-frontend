// hazard_panel_test — the head-unit Report panel (src/carplay/hazardPanel.ts): every tile reports a kind the backend
// accepts (or is the compass), the grid fits both head units, every glyph has all four metals, the ids are unique.
//   node --experimental-strip-types tools/sim-qc/hazard_panel_test.mts
import { readFileSync } from "node:fs";
import { inflateSync } from "node:zlib";
import {
  HAZARD_TILES, HAZARD_REPORT_KINDS, HAZARD_BUTTON_ID, HAZARD_BUTTON_LABEL, HAZARD_BUTTON_GLYPH, HAZARD_TEMPLATE_ID,
  CARPLAY_GRID_MAX, AA_GRID_MAX, HAZARD_PANEL_AUTO_CLOSE_MS, hazardTile, hazardTapLabel, hazardGridButtons, hazardGridConfigAA, hazardTileCarGlyph, HAZARD_NEON_GLYPH,
  HAZARD_REPORT_PILL_MS, reportPillPatch, reportPillLive,
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
ok("B1 iOS grid buttons: id + titleVariants[0] + image, in tile order", btns.length === 5 && btns.every((b, i) => b.id === HAZARD_TILES[i].id && b.titleVariants[0] === HAZARD_TILES[i].title && b.image === `icon:${hazardTileCarGlyph(HAZARD_TILES[i])}`));
const aa = hazardGridConfigAA((g) => `icon:${g}`);
ok("B3 head-unit grid: every report tile draws its kind's neon glyph, the Compass keeps its metal glyph (Jeff, 2026-09-25)", btns.every((b, i) => { const t = HAZARD_TILES[i]; return t.kind ? b.image === `icon:${HAZARD_NEON_GLYPH[t.kind]}` : b.image === `icon:${t.glyph}`; }));
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

// H · the CarPlay photo round (Jeff, 2026-09-25, 09:29 on a real head unit): the candy map-button triangle touched the circle
// at its base corners → "a little, little smaller and it's the same distance for each three points to the edge of the circle";
// the grid glyphs → "the same colors as on the phone". Decodes the baked PNGs themselves (bake_car_hazard_icons.py).
{
  const icons = readFileSync(new URL("../../src/carplay/carButtonIcons.ts", import.meta.url), "utf8");
  const pal = readFileSync(new URL("../../src/hazardPalette.ts", import.meta.url), "utf8");
  const poi = readFileSync(new URL("../../src/poiPalette.ts", import.meta.url), "utf8");
  const b64 = (name: string): string => icons.match(new RegExp(`const ${name}: CarIcon = icon\\(\\s*'([A-Za-z0-9+/=]+)'`))?.[1] ?? "";
  // Minimal PNG decode: 8-bit RGBA (colour type 6), non-interlaced — what Chrome and PIL write. Anything else fails loudly.
  const rgba = (name: string): { w: number; h: number; px: Uint8Array } | null => {
    const s = b64(name); if (!s) return null;
    const buf = Buffer.from(s, "base64");
    let off = 8, w = 0, h = 0; const idat: Buffer[] = [];
    while (off < buf.length) {
      const len = buf.readUInt32BE(off), type = buf.toString("ascii", off + 4, off + 8), data = buf.subarray(off + 8, off + 8 + len);
      if (type === "IHDR") { w = data.readUInt32BE(0); h = data.readUInt32BE(4); if (data[8] !== 8 || data[9] !== 6 || data[12] !== 0) return null; }
      if (type === "IDAT") idat.push(data);
      off += 12 + len;
    }
    const raw = inflateSync(Buffer.concat(idat)), stride = w * 4, px = new Uint8Array(w * h * 4);
    for (let y = 0; y < h; y++) {
      const f = raw[y * (stride + 1)], row = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
      for (let x = 0; x < stride; x++) {
        const a = x >= 4 ? px[y * stride + x - 4] : 0, b = y > 0 ? px[(y - 1) * stride + x] : 0, c = x >= 4 && y > 0 ? px[(y - 1) * stride + x - 4] : 0;
        const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
        const pred = f === 0 ? 0 : f === 1 ? a : f === 2 ? b : f === 3 ? (a + b) >> 1 : pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
        px[y * stride + x] = (row[x] + pred) & 255;
      }
    }
    return { w, h, px };
  };
  const bright = (kind: string): string => { const cat = pal.match(new RegExp(`^\\s*${kind}:\\s*\\{ cat: "(\\w+)"`, "m"))?.[1]; return (cat && poi.match(new RegExp(`^\\s*${cat}:\\s*\\{ bright: "(#[0-9A-Fa-f]{6})"`, "m"))?.[1]) || "?"; };
  const stem: Record<string, string> = { police: "POLICE", accident: "CRASH", road: "HAZARD", traffic: "TRAFFIC" };
  for (const kind of Object.keys(stem)) {
    const n = rgba(`CAR_ICON_HZ_${stem[kind]}_NEON`), b = rgba(`CAR_ICON_HZ_${stem[kind]}_BRAND`), hex = bright(kind);
    const want = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
    let sameAlpha = !!n && !!b && n.px.length === b.px.length, allBright = !!n, inked = 0;
    if (n && b) for (let i = 0; i < n.px.length; i += 4) {
      if (n.px[i + 3] !== b.px[i + 3]) sameAlpha = false;
      if (n.px[i + 3] > 0) { inked++; if (n.px[i] !== want[0] || n.px[i + 1] !== want[1] || n.px[i + 2] !== want[2]) allBright = false; }
    }
    ok(`H1 ${kind}: the grid glyph is the phone's tinted glyph — brand silhouette, every inked pixel ${hex} (hazardPaint bright)`, sameAlpha && allBright && inked > 500, `${inked} px`);
  }
  ok("H2 every neon glyph is one icon for all four metals (the phone tints the kind colour whatever the metal)", ["police", "crash", "hazard", "traffic"].every((g) => new RegExp(`^  hz_${g}_neon: \\{ brand: (CAR_ICON_HZ_${g.toUpperCase()}_NEON), premium: \\1, ultra: \\1, diamond: \\1 \\},$`, "m").test(icons)));
  for (const metal of ["BRAND", "PREMIUM", "ULTRA", "DIAMOND"]) {
    const img = rgba(`CAR_ICON_HZ_HAZARD_CANDY_${metal}`);
    const reach: Record<string, number> = { apex: 0, right: 0, left: 0 };
    if (img) { const c = (img.w - 1) / 2; for (let y = 0; y < img.h; y++) for (let x = 0; x < img.w; x++) {
      if (img.px[(y * img.w + x) * 4 + 3] <= 128) continue;
      const ang = (Math.atan2(y - c, x - c) * 180 / Math.PI + 360) % 360, r = Math.hypot(x - c, y - c);
      for (const [k, at] of [["apex", 270], ["right", 30], ["left", 150]] as const) if (Math.abs(((ang - at + 540) % 360) - 180) < 40) reach[k] = Math.max(reach[k], r);
    } }
    const half = img ? img.w / 2 : 1, rs = Object.values(reach);
    ok(`H3 ${metal} candy map button: all three points the same distance from the circle (±1.5 px) and clear of it (≤ 0.84 of the half-canvas; the phone cut reached 0.98)`,
      !!img && img.w === 132 && Math.max(...rs) - Math.min(...rs) <= 1.5 && Math.max(...rs) / half <= 0.84 && Math.min(...rs) / half >= 0.7, rs.map((r) => (r / half).toFixed(3)).join(" / "));
  }
}

// I · the head-unit REPORT PILL (Jeff, 2026-09-25: "lets add the hazard alert that is on the phone to the under the version
// pill, to the the carplay surfaces make it last like 15 sec"): the phone's ReportPill on CarPlay + Android Auto, 15 s.
{
  const acts = readFileSync(new URL("../../src/carplay/carActions.ts", import.meta.url), "utf8");
  const mapTsx = readFileSync(new URL("../../app/(app)/map.tsx", import.meta.url), "utf8");
  const cp = readFileSync(new URL("../../src/carplay/ConvoyCarPlay.tsx", import.meta.url), "utf8");
  const store = readFileSync(new URL("../../src/carplay/carStore.ts", import.meta.url), "utf8");
  const pal = readFileSync(new URL("../../src/hazardPalette.ts", import.meta.url), "utf8");
  // A function's body: from its header to the first line that closes it at the header's own indentation.
  const body = (src: string, head: string): string => {
    const k = src.indexOf(head); if (k < 0) return "";
    const lineStart = src.lastIndexOf("\n", k) + 1, indent = src.slice(lineStart, k).match(/^\s*/)?.[0] ?? "";
    const end = src.indexOf(`\n${indent}};`, k), end2 = src.indexOf(`\n${indent}}\n`, k);
    const stop = [end, end2].filter((v) => v > k).sort((a, b) => a - b)[0] ?? src.length;
    return src.slice(k, stop);
  };
  ok("I1 HAZARD_REPORT_PILL_MS is 15 s", HAZARD_REPORT_PILL_MS === 15000, `${HAZARD_REPORT_PILL_MS}`);
  const p1 = reportPillPatch("traffic", 1000), p2 = reportPillPatch("police", 9000);
  ok("I2 reportPillPatch writes the kind and now + 15 s; a second report restarts the 15 s",
    JSON.stringify(p1) === JSON.stringify({ carReportKind: "traffic", carReportUntil: 16000 }) && p2.carReportKind === "police" && p2.carReportUntil === 24000);
  ok("I3 reportPillLive: true until the instant it expires, false at / after it and for a missing or non-finite stamp",
    reportPillLive(15000, 14999) && !reportPillLive(15000, 15000) && !reportPillLive(15000, 20000) && !reportPillLive(undefined, 0) && !reportPillLive(null, 0) && !reportPillLive(NaN, 0));
  const rh = body(acts, "export async function reportHazardFromCar("), rhCode = rh.replace(/\/\/.*$/gm, "");
  ok("I4 a head-unit report's success writes the pill (reportPillPatch + car-report-pill src=car) instead of toast(done); failures stay 3 s toasts; TOAST_MS still 3000",
    rh.includes("setCarState(reportPillPatch(kind, Date.now()))") && rh.includes("logEvent(`car-report-pill kind=${kind} src=car`)") && rh.length > 0 && !rhCode.includes("toast(done)")
    && rh.includes("toast('No GPS fix yet')") && rh.includes("toast('Report failed — no connection')") && /^const TOAST_MS = 3000;$/m.test(acts));
  const phoneWrite = "try { setCarState(reportPillPatch(kind, Date.now())); logEvent(`car-report-pill kind=${kind} src=phone`); } catch {}";
  const ra = body(mapTsx, "const reportAlert = async ("), rz = body(mapTsx, "const reportHazard = async (");
  ok("I5 both phone report functions write the head-unit pill right after the phone pill, and keep the phone's own 4 s",
    [ra, rz].every((b) => b.includes(phoneWrite) && b.indexOf("setAlertConfirm(kind);") < b.indexOf(phoneWrite) && b.includes("setTimeout(() => setAlertConfirm(null), 4000)")));
  const order = ["'pitstop'", "'toast'", "'crew'", "'comms'", "'talker'", "'scout'", "'report'", "'status'"];
  const decision = cp.slice(cp.indexOf("const slot: 'pitstop'"), cp.indexOf("    : 'none';", cp.indexOf("const slot: 'pitstop'")));
  const decided = order.map((t) => decision.indexOf(`? ${t}`));
  const jsx = order.map((t) => cp.indexOf(`slot === ${t} ? (`));
  ok("I6 the ONE status slot: pitstop > receipt > crew view > Transmitting > talker > Scout > REPORT > status pill, in the decision and in the JSX",
    decided.every((v, i) => v > 0 && (i === 0 || decided[i - 1] < v)) && decision.includes(": reportLive ? 'report'")
    && jsx.every((v, i) => v > 0 && (i === 0 || jsx[i - 1] < v)) && !cp.includes("{s.pitstopActive ? (") && !cp.includes(") : statusPill ? ("));
  ok("I7 the head-unit pill is the crew pill's twin, painted ONLY from hazardPaint(kind): border + dot bright, a 0.30 wash, '<Label> reported'",
    cp.includes("const reportPaint = hazardPaint(reportKind);") && cp.includes("style={[styles.crewPill, styles.reportPill, { backgroundColor: carHudFloor(), borderColor: reportPaint.bright }]}")
    && cp.includes("tintColor={hazardTint(reportKind, 0.30)}") && cp.includes("style={[styles.reportDot, { backgroundColor: reportPaint.bright }]}")
    && cp.includes("style={[styles.crewPillText, styles.reportPillText]}") && cp.includes("{reportPaint.label} reported")
    && pal.includes("export function hazardTint(kind: string | null | undefined, alpha: number): string {") && pal.includes("hazardPaint(kind).bright"));
  ok("I8 expiry: a TIMESTAMP at render plus ONE local re-render at the next slot change while the pill is pending (its own expiry, or the end of a receipt / crew view covering it — a stopped car writes no store), re-armed if early, cleared on change / unmount",
    cp.includes("const reportLive = !!reportKind && reportPillLive(s.carReportUntil, Date.now());")
    && cp.includes("if (!reportKind || !reportPillLive(s.carReportUntil, now)) return;")
    && cp.includes("const next = Math.min(...[s.carReportUntil, s.carToastUntil, s.crewViewUntil].filter((t): t is number => typeof t === 'number' && t > now));")
    && cp.includes("const id = setTimeout(() => setReportTick((t) => t + 1), next - now);")
    && cp.includes("return () => clearTimeout(id);\n  }, [reportKind, s.carReportUntil, s.carToastUntil, s.crewViewUntil, reportTick]);"));
  ok("I9 car-report-drawn is written only when the slot switches TO the pill (never while covered), ≤ 8 per mount",
    cp.includes("if (CAR_DIAG_MODE || slot !== 'report' || was === slotKey || reportDrawnCount.current >= 8) return;")
    && cp.includes("logEventReliable(`car-report-drawn kind=${reportKind} surf=${IS_AA ? 'aa' : 'carplay'}`)"));
  ok("I10 placement: the status slot on the crew pill's frame — CarPlay centred between the bar buttons, AA on the left rail with 'left top' applied AFTER statusRowFit",
    cp.includes("<View style={[styles.statusRow, statusRowFit, styles.reportRow, IS_AA ? hudFit('left top') : null]} pointerEvents=\"none\">")
    && cp.includes("reportRow: { left: IS_AA ? CAR_DOCK_LEFT : CAR_BAR_LEADING_W, right: IS_AA ? 0 : CAR_BAR_TRAILING_W, alignItems: IS_AA ? 'flex-start' : 'center' },"));
  ok("I11 the report hooks run before CarSurface's CAR_DIAG_MODE early return (hook order), and carStore carries the two type fields",
    cp.indexOf("const [reportTick, setReportTick] = useState(0);") > 0 && cp.indexOf("const slotKeyPrev = useRef('');") > 0
    && cp.indexOf("const slotKeyPrev = useRef('');") < cp.indexOf("  if (CAR_DIAG_MODE) {\n    return (")
    && store.includes("  carReportKind?: string | null;\n  carReportUntil?: number;"));
}

console.log(fails === 0 ? "\nPASS hazard_panel" : `\nFAIL hazard_panel (${fails})`);
if (fails) process.exit(1);
