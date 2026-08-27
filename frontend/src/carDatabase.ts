// Car database: makes, models, colors
// Add new makes/models/colors here

export type CarColor = { name: string; hex: string };
export type CarModel = { name: string; colors: CarColor[] };
export type CarMake  = { name: string; models: CarModel[] };

const GR_COROLLA_COLORS: CarColor[] = [
  { name: 'Heavy Metal',    hex: '#6B6E72' },
  { name: 'Supersonic Red', hex: '#C0152A' },
  { name: 'Icecap White',   hex: '#F0F0F0' },
  { name: 'Blue Flame',     hex: '#0099D8' },
  { name: 'Black Onyx',     hex: '#1A1A1A' },
  // GRMN exclusive (2026): paint code 6X9 "Master's Khaki", marketed as Gravel.
  // Hex MEASURED from the official paint vendor's 6X9 swatch, not guessed.
  // Measured from Toyota's official 06X9 studio asset (8/19) — dark grey-green.
  // Kept in lockstep with VEHICLE_TINT.gravel.
  { name: 'Gravel',         hex: '#565E5F' },
];

const DEFAULT_COLORS: CarColor[] = [
  { name: 'Black',  hex: '#1A1A1A' },
  { name: 'White',  hex: '#F0F0F0' },
  { name: 'Silver', hex: '#A8A8A8' },
  { name: 'Red',    hex: '#CC0000' },
  { name: 'Blue',   hex: '#003399' },
  { name: 'Grey',   hex: '#6B6B6B' },
];

export const CAR_DATABASE: CarMake[] = [
  {
    name: 'Toyota',
    models: [
      { name: 'GR Corolla', colors: GR_COROLLA_COLORS },
      // GR Yaris (XP210, union MY2023-26; UK-market names, codes in comments).
      // Hexes measured from Toyota's own configurator data — researched 8/20.
      { name: 'GR Yaris', colors: [
        { name: 'Pure White',           hex: '#F0F0F0' }, // 040 — same paint as GRC Icecap, same swatch
        { name: 'Platinum White Pearl', hex: '#F6F8EE' }, // 089
        { name: 'Precious Metal',       hex: '#8A8E8B' }, // 1L5 (2024+)
        { name: 'Precious Black',       hex: '#1C1C1C' }, // 219
        { name: 'Scarlet Flare',        hex: '#C0152A' }, // 3U5 — same paint as GRC Supersonic, same swatch
      ]},
      { name: 'GR86',       colors: [
        { name: 'Raven',          hex: '#1A1A1A' },
        { name: 'Crystal White',  hex: '#F0F0F0' },
        { name: 'Magnetite Grey', hex: '#5A5A5A' },
        { name: 'Sapphire Blue',  hex: '#003D7A' },
        { name: 'Iper Red',       hex: '#CC1A1A' },
      ]},
      { name: 'Supra', colors: [
        { name: 'Renaissance Red', hex: '#C41E3A' },
        { name: 'Nitro Yellow',    hex: '#F5C518' },
        { name: 'Phantom',         hex: '#1A1A1A' },
        { name: 'White',           hex: '#F0F0F0' },
        { name: 'Downshift Blue',  hex: '#1E3A8A' },
      ]},
    ],
  },
  {
    name: 'Honda',
    models: [
      // Swatches synced to the authored 3D paints (8/20)
      { name: 'S2000', colors: [
        { name: 'Grand Prix White', hex: '#FAFAF6' },
        { name: 'Berlina Black',    hex: '#1C1C1E' },
        { name: 'Silverstone',      hex: '#A9ADB2' },
        { name: 'Rio Yellow Pearl', hex: '#E8C51F' },
        { name: 'Spa Yellow',       hex: '#E0BC00' },
        { name: 'Laguna Blue',      hex: '#2A6E9F' },
        { name: 'Suzuka Blue',      hex: '#2C63B8' },
        { name: 'Nogaro Silver',    hex: '#B4B7BA' },
      ]},
      { name: 'Civic Type R', colors: [
        { name: 'Championship White', hex: '#F0F0F0' },
        { name: 'Rallye Red',         hex: '#CC0000' },
        { name: 'Boost Blue Pearl',   hex: '#003D7A' },
        { name: 'Sonic Gray Pearl',   hex: '#6B6B6B' },
        { name: 'Crystal Black',      hex: '#1A1A1A' },
      ]},
    ],
  },
  {
    name: 'Mazda',
    models: [
      { name: 'Miata MX-5', colors: [
        { name: 'Soul Red Crystal',  hex: '#8B0000' },
        { name: 'Snowflake White',   hex: '#F0F0F0' },
        { name: 'Machine Grey',      hex: '#5A5A5A' },
        { name: 'Jet Black',         hex: '#1A1A1A' },
        { name: 'Zircon Sand',       hex: '#C4A882' },
        { name: 'Polymetal Grey',    hex: '#78838C' },
      ]},
    ],
  },
  {
    name: 'Subaru',
    models: [
      { name: 'WRX STI', colors: [
        { name: 'WR Blue Pearl',   hex: '#003A8C' },
        { name: 'Crystal White',   hex: '#F0F0F0' },
        { name: 'Obsidian Black',  hex: '#1A1A1A' },
        { name: 'Ice Silver',      hex: '#A8A8A8' },
        { name: 'Ceramic White',   hex: '#E8E8E8' },
      ]},
    ],
  },
  {
    name: 'Chevrolet',
    models: [
      { name: 'Corvette C8', colors: [
        { name: 'Torch Red',         hex: '#CC0000' },
        { name: 'Arctic White',      hex: '#F0F0F0' },
        { name: 'Black',             hex: '#1A1A1A' },
        { name: 'Elkhart Lake Blue', hex: '#003D7A' },
        { name: 'Amplify Orange',    hex: '#E85000' },
        { name: 'Rapid Blue',        hex: '#0066CC' },
        { name: 'Hypersonic Gray',   hex: '#5A5A5A' },
      ]},
      { name: 'Camaro SS', colors: [
        { name: 'Rally Green',      hex: '#1A4A1A' },
        { name: 'Shock',            hex: '#F5C518' },
        { name: 'Black',            hex: '#1A1A1A' },
        { name: 'Summit White',     hex: '#F0F0F0' },
        { name: 'Red Hot',          hex: '#CC0000' },
      ]},
    ],
  },
  {
    name: 'Ford',
    models: [
      { name: 'Mustang GT', colors: [
        { name: 'Race Red',       hex: '#CC0000' },
        { name: 'Shadow Black',   hex: '#1A1A1A' },
        { name: 'Oxford White',   hex: '#F0F0F0' },
        { name: 'Grabber Blue',   hex: '#0055A0' },
        { name: 'Eruption Green', hex: '#2D5A1A' },
        { name: 'Iconic Silver',  hex: '#A8A8A8' },
      ]},
    ],
  },
  {
    name: 'Dodge',
    models: [
      { name: 'Challenger', colors: [
        { name: 'Plum Crazy',   hex: '#6A0DAD' },
        { name: 'Go Mango',     hex: '#E85000' },
        { name: 'Hellraisin',   hex: '#5C1A5C' },
        { name: 'Triple Nickel',hex: '#555555' },
        { name: 'TorRed',       hex: '#CC0000' },
        { name: 'White Knuckle',hex: '#F0F0F0' },
        { name: 'Pitch Black',  hex: '#1A1A1A' },
      ]},
    ],
  },
  {
    name: 'BMW',
    models: [
      // G87 M2 — authored 3D model (8/20)
      { name: 'M2', colors: [
        { name: 'Zandvoort Blue', hex: '#46AEE0' },
        { name: 'Toronto Red',    hex: '#C4232E' },
        { name: 'Alpine White',   hex: '#F5F5F2' },
        { name: 'Black Sapphire', hex: '#1C1C20' },
        { name: 'Brooklyn Grey',  hex: '#82868A' },
      ]},
      { name: 'M3', colors: [
        { name: 'Interlagos Blue',  hex: '#003D7A' },
        { name: 'Alpine White',     hex: '#F0F0F0' },
        { name: 'Sapphire Black',   hex: '#1A1A1A' },
        { name: 'Frozen Grey',      hex: '#787878' },
        { name: 'Isle of Man Green',hex: '#1A4A1A' },
        { name: 'Sao Paulo Yellow', hex: '#E8C800' },
      ]},
    ],
  },
  {
    name: 'Lexus',
    models: [
      // Both authored 3D models (8/20)
      { name: 'LC 500', colors: [
        { name: 'Infrared',       hex: '#BA1E30' },
        { name: 'Ultra White',    hex: '#F7F8F4' },
        { name: 'Caviar',         hex: '#1C1C1E' },
        { name: 'Atomic Silver',  hex: '#9CA0A5' },
        { name: 'Nightfall Mica', hex: '#2B4877' },
      ]},
      { name: 'LFA', colors: [
        { name: 'Whitest White',  hex: '#F7F8F4' },
        { name: 'Absolutely Red', hex: '#C41230' },
        { name: 'Pearl Yellow',   hex: '#E8C63E' },
        { name: 'Pearl Blue',     hex: '#35589E' },
        // "Matte Black" not plain "Black": a bare 'black' colour-name alias would
        // hijack every generic black car in the DB onto the LFA model.
        { name: 'Matte Black',    hex: '#141518' },
      ]},
    ],
  },
  {
    name: 'Porsche',
    models: [
      { name: '911', colors: [
        { name: 'Guards Red',     hex: '#CC0000' },
        { name: 'GT Silver',      hex: '#A8A8A8' },
        { name: 'Carrara White',  hex: '#F0F0F0' },
        { name: 'Jet Black',      hex: '#1A1A1A' },
        { name: 'Miami Blue',     hex: '#0099CC' },
        { name: 'Python Green',   hex: '#1A6A1A' },
        { name: 'Shark Blue',     hex: '#003D7A' },
      ]},
      // 992 GT3 RS — authored 3D model (8/20), swatches match the baked paints
      { name: '911 GT3 RS', colors: [
        { name: 'Guards Red',     hex: '#D5001C' },
        { name: 'GT Silver',      hex: '#9EA1A4' },
        { name: 'Carrara White',  hex: '#F4F4F0' },
        { name: 'Jet Black',      hex: '#1C1C1E' },
        { name: 'Miami Blue',     hex: '#00B2D8' },
        { name: 'Python Green',   hex: '#4EC53F' },
        { name: 'Shark Blue',     hex: '#2E64B8' },
      ]},
    ],
  },
  {
    name: 'Jeep',
    models: [
      { name: 'Wrangler', colors: [
        { name: 'Firecracker Red',  hex: '#CC0000' },
        { name: 'Bright White',     hex: '#F0F0F0' },
        { name: 'Black',            hex: '#1A1A1A' },
        { name: 'Sarge Green',      hex: '#3D5A1A' },
        { name: 'Hydro Blue',       hex: '#0077A8' },
        { name: 'Granite Crystal',  hex: '#5A5A5A' },
        { name: 'Sting-Gray',       hex: '#787878' },
      ]},
    ],
  },
];

// 2027: the GRMN's model year (selecting Gravel auto-pins it — garage.tsx handleColor).
export const YEARS = ['2023', '2024', '2025', '2026', '2027'];

export function getModelsForMake(make: string): CarModel[] {
  return CAR_DATABASE.find(m => m.name === make)?.models ?? [];
}

export function getColorsForModel(make: string, model: string): CarColor[] {
  return getModelsForMake(make).find(m => m.name === model)?.colors ?? DEFAULT_COLORS;
}

export function getMakeNames(): string[] {
  return CAR_DATABASE.map(m => m.name);
}

// ── Typed-field lookup (car scan) ────────────────────────────────────────────
// The garage's make/model fields are FREE TEXT since 2026-08-23, so the scan
// flow can't join on exact strings. Normalize (case/space/punct-blind), match
// the make exactly, then the model exactly first and by containment second —
// "corolla" finds "GR Corolla", but "911 gt3 rs" still lands on "911 GT3 RS"
// (exact pass) rather than "911" (containment pass).
const norm = (x?: string | null) => (x ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');

export function findColorsForTyped(make?: string | null, model?: string | null): CarColor[] {
  const nMake = norm(make), nModel = norm(model);
  if (!nMake || !nModel) return [];
  const mk = CAR_DATABASE.find(m => norm(m.name) === nMake);
  if (!mk) return [];
  const exact = mk.models.find(m => norm(m.name) === nModel);
  if (exact) return exact.colors;
  if (nModel.length < 3) return [];
  const partial = mk.models.find(m => {
    const n = norm(m.name);
    return n.includes(nModel) || nModel.includes(n);
  });
  return partial?.colors ?? [];
}

// The generic fallback set, exported for flows (car scan) that show it beside
// or instead of factory colors.
export const GENERIC_COLORS: CarColor[] = DEFAULT_COLORS;
