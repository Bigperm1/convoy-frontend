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
      { name: 'S2000', colors: [
        { name: 'Grand Prix White', hex: '#F0F0F0' },
        { name: 'Berlina Black',    hex: '#1A1A1A' },
        { name: 'Silverstone',      hex: '#A8A8A8' },
        { name: 'Rio Yellow Pearl', hex: '#E8C800' },
        { name: 'Spa Yellow',       hex: '#D4B800' },
        { name: 'Laguna Blue',      hex: '#1E5C8A' },
        { name: 'Suzuka Blue',      hex: '#003D7A' },
        { name: 'Nogaro Silver',    hex: '#B0B0B0' },
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

export const YEARS = ['2023', '2024', '2025', '2026'];

export function getModelsForMake(make: string): CarModel[] {
  return CAR_DATABASE.find(m => m.name === make)?.models ?? [];
}

export function getColorsForModel(make: string, model: string): CarColor[] {
  return getModelsForMake(make).find(m => m.name === model)?.colors ?? DEFAULT_COLORS;
}

export function getMakeNames(): string[] {
  return CAR_DATABASE.map(m => m.name);
}
