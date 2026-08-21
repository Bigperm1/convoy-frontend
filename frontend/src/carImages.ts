// Car image asset map for garage screen
// Keys: "Make|Model|Color" => require() path
// Top-down images are in assets/vehicles/ (used for map marker)
// 3/4 press images are in assets/cars/ (used for garage hero)

export type CarImageKey = {
make: string;
model: string;
color: string;
};

// Normalize strings for matching
const normalize = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '');

// GR Corolla 3/4 press images
const GR_COROLLA_IMAGES: Record<string, any> = {
'heavymetal': require('../assets/cars/gr_corolla/heavy_metal.jpg'),
'supersonicred': require('../assets/cars/gr_corolla/supersonic_red.jpg'),
'icecapwhite': require('../assets/cars/gr_corolla/icecap_white.jpg'),
'blueflame': require('../assets/cars/gr_corolla/blue_flame.jpg'),
'blackonyx': require('../assets/cars/gr_corolla/black_onyx.jpg'),
// GRMN hero (8/19 v2): Toyota's official Gravel press shot, cropped to this set's
// framing, GRMN wordmark TOP-left (Jeff's call — chrome-gradient MN at emblem
// height, matching the flat wordmark on toyota.com). Same dark-studio look as
// the other five by construction: it's the same photographic series. New
// filename per revision — the OTA asset path-key trap.
'gravel': require('../assets/cars/gr_corolla/gravel_grmn27.jpg'),
// Garage Scan hero — rendered from Jeff's scanned car, Heavy Metal tint.
'widebody': require('../assets/cars/gr_corolla/widebody_d.jpg'),
};

// GR Yaris 3/4 heroes — Toyota's official scene7 configurator renders (transparent
// alpha, one consistent facelift front-3/4 series) composited onto the same
// dark-studio background language as the GR Corolla set. Built 8/20.
const GR_YARIS_IMAGES: Record<string, any> = {
'purewhite': require('../assets/cars/gr_yaris/pure_white.jpg'),
'platinumwhitepearl': require('../assets/cars/gr_yaris/platinum_pearl.jpg'),
'preciousmetal': require('../assets/cars/gr_yaris/precious_metal.jpg'),
'preciousblack': require('../assets/cars/gr_yaris/precious_black.jpg'),
'scarletflare': require('../assets/cars/gr_yaris/scarlet_flare.jpg'),
};

// 911 GT3 RS heroes — rendered from the full-detail authored model (no official
// per-colour configurator render exists), studio-lit, composited on the same
// dark-studio background as the rest of the garage. Built 8/20.
const GT3RS_IMAGES: Record<string, any> = {
'guardsred': require('../assets/cars/gt3rs/guards_red.jpg'),
'gtsilver': require('../assets/cars/gt3rs/gt_silver.jpg'),
'carrarawhite': require('../assets/cars/gt3rs/carrara_white.jpg'),
'jetblack': require('../assets/cars/gt3rs/jet_black.jpg'),
'miamiblue': require('../assets/cars/gt3rs/miami_blue.jpg'),
'pythongreen': require('../assets/cars/gt3rs/python_green.jpg'),
'sharkblue': require('../assets/cars/gt3rs/shark_blue.jpg'),
};

// S2000 / M2 / LC 500 / LFA heroes — rendered from the full-detail authored
// models (no official per-colour configurator source), same dark studio. 8/20.
const S2000_IMAGES: Record<string, any> = {
'grandprixwhite': require('../assets/cars/s2000/grand_prix_white_b.jpg'),
'berlinablack': require('../assets/cars/s2000/berlina_black_b.jpg'),
'silverstone': require('../assets/cars/s2000/silverstone_b.jpg'),
'rioyellowpearl': require('../assets/cars/s2000/rio_yellow_b.jpg'),
'spayellow': require('../assets/cars/s2000/spa_yellow_b.jpg'),
'lagunablue': require('../assets/cars/s2000/laguna_blue_b.jpg'),
'suzukablue': require('../assets/cars/s2000/suzuka_blue_b.jpg'),
'nogarosilver': require('../assets/cars/s2000/nogaro_silver_b.jpg'),
};
const M2_IMAGES: Record<string, any> = {
'zandvoortblue': require('../assets/cars/m2/zandvoort_blue.jpg'),
'torontored': require('../assets/cars/m2/toronto_red.jpg'),
'alpinewhite': require('../assets/cars/m2/alpine_white.jpg'),
'blacksapphire': require('../assets/cars/m2/black_sapphire.jpg'),
'brooklyngrey': require('../assets/cars/m2/brooklyn_grey.jpg'),
};
const LC500_IMAGES: Record<string, any> = {
'infrared': require('../assets/cars/lc500/infrared.jpg'),
'ultrawhite': require('../assets/cars/lc500/ultra_white.jpg'),
'caviar': require('../assets/cars/lc500/caviar.jpg'),
'atomicsilver': require('../assets/cars/lc500/atomic_silver.jpg'),
'nightfallmica': require('../assets/cars/lc500/nightfall_mica.jpg'),
};
const LFA_IMAGES: Record<string, any> = {
'whitestwhite': require('../assets/cars/lfa/whitest_white.jpg'),
'absolutelyred': require('../assets/cars/lfa/absolutely_red.jpg'),
'pearlyellow': require('../assets/cars/lfa/pearl_yellow.jpg'),
'pearlblue': require('../assets/cars/lfa/pearl_blue.jpg'),
'matteblack': require('../assets/cars/lfa/matte_black.jpg'),
};

// Top-down map marker images (existing vehicle presets)
const TOP_DOWN_IMAGES: Record<string, any> = {
'heavymetal': require('../assets/vehicles/heavy_metal.png'),
'supersonicred': require('../assets/vehicles/supersonic_red.png'),
'icecapwhite': require('../assets/vehicles/ice_cap_white.png'),
'blueflame': require('../assets/vehicles/blue_flame.png'),
'blackonyx': require('../assets/vehicles/precious_black_pearl.png'),
};

// Default fallback images
// No-car-selected Garage hero = premium showroom photo (replaces the old
// top-down heavy-metal PNG). The file on disk is literally named
// "showroom.png.png" (Windows appended a second .png when it was saved with
// extensions hidden), so we match that exact name here. If the file is ever
// renamed to a clean "showroom.png", update this require to match.
const DEFAULT_GARAGE = require('../assets/images/showroom.png.png');
const DEFAULT_TOPDOWN = require('../assets/vehicles/heavy_metal.png');

export function getGarageImage(make: string, model: string, color: string): any {
const key = normalize(color);
const makeModel = normalize(make + model);

if (makeModel.includes('grcorolla') || makeModel.includes('grcorolla') ||
(makeModel.includes('gr') && makeModel.includes('corolla'))) {
return GR_COROLLA_IMAGES[key] ?? DEFAULT_GARAGE;
}

if (makeModel.includes('gryaris') || (makeModel.includes('gr') && makeModel.includes('yaris'))) {
return GR_YARIS_IMAGES[key] ?? DEFAULT_GARAGE;
}

if (makeModel.includes('gt3rs') || (makeModel.includes('gt3') && makeModel.includes('rs'))) {
return GT3RS_IMAGES[key] ?? DEFAULT_GARAGE;
}

if (makeModel.includes('s2000')) {
return S2000_IMAGES[key] ?? DEFAULT_GARAGE;
}

if (makeModel.includes('bmwm2')) {
return M2_IMAGES[key] ?? DEFAULT_GARAGE;
}

if (makeModel.includes('lc500') || (makeModel.includes('lexus') && makeModel.includes('lc'))) {
return LC500_IMAGES[key] ?? DEFAULT_GARAGE;
}

if (makeModel.includes('lfa')) {
return LFA_IMAGES[key] ?? DEFAULT_GARAGE;
}

// Fallback for unknown models — use top-down as placeholder
return TOP_DOWN_IMAGES[key] ?? DEFAULT_GARAGE;
}

export function getTopDownImage(color: string): any {
const key = normalize(color);
return TOP_DOWN_IMAGES[key] ?? DEFAULT_TOPDOWN;
}