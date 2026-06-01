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

// Fallback for unknown models — use top-down as placeholder
return TOP_DOWN_IMAGES[key] ?? DEFAULT_GARAGE;
}

export function getTopDownImage(color: string): any {
const key = normalize(color);
return TOP_DOWN_IMAGES[key] ?? DEFAULT_TOPDOWN;
}