// panelFloor.ts — ONE floor for every floating panel over the map: the weather forecast card, the Report panel, the
// tapped-pin card, the category results drop-down and the More panel (Jeff, 2026-09-25: "make sure this weather background
// panel colour is the same for the hazard panel and the food/gas etc drop down panels. And the more panel"). The forecast
// card is the reference (WeatherHUD.tsx): a translucent frosted floor and a hairline — no GlassFill on the others, because
// the iOS-26 GlassView composites in a plain View but not in the forecast card's animated one, and two panels that share a
// colour must look the same. Pure module: tools/sim-qc/panel_floor_test.mts reads it.
export const PANEL_FLOOR = "rgba(24,24,28,0.66)";
export const PANEL_BORDER = "rgba(255,255,255,0.14)";
export const PANEL_RADIUS = 16;
