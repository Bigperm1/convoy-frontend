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

// ── 2026-08-27 EXPANSION (car-scan backend) ──────────────────────────────────
// ~30 popular models researched + adversarially fact-checked (every name is a
// verified factory paint of that exact model; hexes are good-faith sRGB reads).
// Merged into CAR_DATABASE at module init so the original blocks stay untouched.
const EXPANSION_MODELS: Record<string, CarModel[]> = {
  'Toyota': [
    { name: 'Tacoma', colors: [
      { name: 'Ice Cap'                   , hex: '#F4F6F3' },
      { name: 'Black'                     , hex: '#0A0A0A' },
      { name: 'Underground'               , hex: '#55585A' },
      { name: 'Celestial Silver Metallic' , hex: '#B0B4B6' },
      { name: 'Supersonic Red'            , hex: '#C41E30' },
      { name: 'Solar Octane'              , hex: '#E1502A' },
      { name: 'Terra'                     , hex: '#B26440' },
      { name: 'Mudbath'                   , hex: '#746757' },
    ]},
    { name: 'Tundra', colors: [
      { name: 'Ice Cap'                   , hex: '#F4F6F4' },
      { name: 'Midnight Black Metallic'   , hex: '#0B0B0B' },
      { name: 'Magnetic Gray Metallic'    , hex: '#57595B' },
      { name: 'Celestial Silver Metallic' , hex: '#B2B5B8' },
      { name: 'Supersonic Red'            , hex: '#C41E30' },
      { name: 'Blueprint'                 , hex: '#202A44' },
      { name: 'Smoked Mesquite'           , hex: '#4B3E33' },
      { name: 'Mudbath'                   , hex: '#746757' },
    ]},
    { name: '4Runner', colors: [
      { name: 'Ice Cap'                 , hex: '#F1F2F0' },
      { name: 'Midnight Black Metallic' , hex: '#0B0B0D' },
      { name: 'Underground'             , hex: '#494B4D' },
      { name: 'Barcelona Red Metallic'  , hex: '#9E1B21' },
      { name: 'Lunar Rock'              , hex: '#A3AAA4' },
      { name: 'Lime Rush'               , hex: '#B2BE3F' },
      { name: 'Solar Octane'            , hex: '#EC5A29' },
      { name: 'Terra'                   , hex: '#AE5C3E' },
    ]},
  ],
  'Honda': [
    { name: 'Civic Si', colors: [
      { name: 'Blazing Orange Pearl' , hex: '#EC6B24' },
      { name: 'Aegean Blue Metallic' , hex: '#27519F' },
      { name: 'Rallye Red'           , hex: '#D6001C' },
      { name: 'Sonic Gray Pearl'     , hex: '#7B8288' },
      { name: 'Crystal Black Pearl'  , hex: '#0B0C0E' },
      { name: 'Platinum White Pearl' , hex: '#EFEFEA' },
      { name: 'Urban Gray Pearl'     , hex: '#5F6468' },
    ]},
  ],
  'Subaru': [
    { name: 'WRX', colors: [
      { name: 'World Rally Blue Pearl'  , hex: '#2450A8' },
      { name: 'Solar Orange Pearl'      , hex: '#E75B26' },
      { name: 'Ignition Red'            , hex: '#CE2029' },
      { name: 'Sapphire Blue Pearl'     , hex: '#24386B' },
      { name: 'Crystal Black Silica'    , hex: '#0A0B0D' },
      { name: 'Ceramic White'           , hex: '#E8E9E4' },
      { name: 'Ice Silver Metallic'     , hex: '#C7CBCE' },
      { name: 'Magnetite Gray Metallic' , hex: '#54575C' },
    ]},
    { name: 'BRZ', colors: [
      { name: 'WR Blue Pearl'           , hex: '#2450A8' },
      { name: 'Sapphire Blue Pearl'     , hex: '#24386B' },
      { name: 'Ignition Red'            , hex: '#CE2029' },
      { name: 'Crystal White Pearl'     , hex: '#F0F1ED' },
      { name: 'Crystal Black Silica'    , hex: '#0A0B0D' },
      { name: 'Ice Silver Metallic'     , hex: '#C7CBCE' },
      { name: 'Magnetite Gray Metallic' , hex: '#54575C' },
    ]},
  ],
  'Chevrolet': [
    { name: 'Silverado 1500', colors: [
      { name: 'Summit White'           , hex: '#F1F2EE' },
      { name: 'Black'                  , hex: '#0A0A0B' },
      { name: 'Sterling Gray Metallic' , hex: '#8E9294' },
      { name: 'Slate Gray Metallic'    , hex: '#5A6065' },
      { name: 'Red Hot'                , hex: '#D01C2A' },
      { name: 'Radiant Red Tintcoat'   , hex: '#8C1A2C' },
      { name: 'Riptide Blue Metallic'  , hex: '#2D6BA5' },
      { name: 'Cypress Gray'           , hex: '#6F746A' },
    ]},
  ],
  'Ford': [
    { name: 'F-150', colors: [
      { name: 'Agate Black Metallic'      , hex: '#0E0E10' },
      { name: 'Oxford White'              , hex: '#F1F1EC' },
      { name: 'Carbonized Gray Metallic'  , hex: '#575C5E' },
      { name: 'Iconic Silver Metallic'    , hex: '#A8ABAE' },
      { name: 'Rapid Red Metallic Tinted' , hex: '#931A28' },
      { name: 'Antimatter Blue Metallic'  , hex: '#192740' },
      { name: 'Code Orange'               , hex: '#E8641C' },
      { name: 'Shelter Green'             , hex: '#4E5749' },
    ]},
    { name: 'Mustang Mach-E', colors: [
      { name: 'Shadow Black'                  , hex: '#0E0E10' },
      { name: 'Star White'                    , hex: '#EFEEE9' },
      { name: 'Carbonized Gray Metallic'      , hex: '#55585A' },
      { name: 'Rapid Red Metallic Tinted'     , hex: '#92222C' },
      { name: 'Grabber Blue Metallic'         , hex: '#1273B7' },
      { name: 'Cyber Orange Metallic Tricoat' , hex: '#E2621B' },
      { name: 'Vapor Blue Metallic'           , hex: '#9FAFBD' },
      { name: 'Eruption Green Metallic'       , hex: '#2E4B3C' },
    ]},
    { name: 'Focus RS', colors: [
      { name: 'Nitrous Blue'     , hex: '#1673C8' },
      { name: 'Stealth Grey'     , hex: '#63686D' },
      { name: 'Frozen White'     , hex: '#F4F6F5' },
      { name: 'Shadow Black'     , hex: '#101214' },
      { name: 'Magnetic'         , hex: '#4E5357' },
      { name: 'Race Red'         , hex: '#CC1F2D' },
      { name: 'Ultimate Green'   , hex: '#7CB83F' },
      { name: 'Performance Blue' , hex: '#2A5CAA' },
    ]},
    { name: 'Focus ST', colors: [
      { name: 'Ford Performance Blue' , hex: '#2660A4' },
      { name: 'Orange Fury'           , hex: '#E8641B' },
      { name: 'Frozen White'          , hex: '#F4F6F5' },
      { name: 'Race Red'              , hex: '#CC1F2D' },
      { name: 'Magnetic'              , hex: '#4E5357' },
      { name: 'Agate Black Metallic'  , hex: '#0C0E10' },
      { name: 'Ruby Red'              , hex: '#8E2432' },
    ]},
    { name: 'Bronco', colors: [
      { name: 'Shadow Black'             , hex: '#0D0D0D' },
      { name: 'Oxford White'             , hex: '#ECEDE8' },
      { name: 'Cactus Gray'              , hex: '#9BA29A' },
      { name: 'Race Red'                 , hex: '#D0121F' },
      { name: 'Area 51'                  , hex: '#71808C' },
      { name: 'Cyber Orange'             , hex: '#DE6E27' },
      { name: 'Antimatter Blue Metallic' , hex: '#1B2A44' },
      { name: 'Eruption Green Metallic'  , hex: '#3A4A3E' },
    ]},
  ],
  'Dodge': [
    { name: 'Charger', colors: [
      { name: 'Pitch Black'    , hex: '#0B0B0B' },
      { name: 'White Knuckle'  , hex: '#EFEFEC' },
      { name: 'Destroyer Grey' , hex: '#62676B' },
      { name: 'TorRed'         , hex: '#D22730' },
      { name: 'Plum Crazy'     , hex: '#5A2D82' },
      { name: 'F8 Green'       , hex: '#3B4A3A' },
      { name: 'Sinamon Stick'  , hex: '#96502D' },
      { name: 'B5 Blue'        , hex: '#2660BE' },
    ]},
  ],
  'RAM': [
    { name: '1500', colors: [
      { name: 'Bright White'                     , hex: '#F3F4F0' },
      { name: 'Diamond Black Crystal Pearl-Coat' , hex: '#0C0C0E' },
      { name: 'Billet Silver Metallic'           , hex: '#A8AAAD' },
      { name: 'Granite Crystal Metallic'         , hex: '#545659' },
      { name: 'Flame Red'                        , hex: '#C41E2C' },
      { name: 'Hydro Blue Pearl-Coat'            , hex: '#1479C4' },
      { name: 'Ignition Orange'                  , hex: '#E5601E' },
      { name: 'Baja Yellow'                      , hex: '#F2C21E' },
    ]},
  ],
  'GMC': [
    { name: 'Sierra 1500', colors: [
      { name: 'Summit White'           , hex: '#F1F2EE' },
      { name: 'Onyx Black'             , hex: '#0B0B0C' },
      { name: 'Sterling Metallic'      , hex: '#9A9DA0' },
      { name: 'Thunderstorm Gray'      , hex: '#64676C' },
      { name: 'Titanium Rush Metallic' , hex: '#8B847A' },
      { name: 'Downpour Metallic'      , hex: '#32414E' },
      { name: 'Volcanic Red Tintcoat'  , hex: '#8F1E2C' },
      { name: 'White Frost Tricoat'    , hex: '#F5F4EF' },
    ]},
  ],
  'Tesla': [
    { name: 'Model 3', colors: [
      { name: 'Pearl White Multi-Coat'   , hex: '#F2F3F5' },
      { name: 'Solid Black'              , hex: '#0B0B0B' },
      { name: 'Stealth Grey'             , hex: '#54575B' },
      { name: 'Quicksilver'              , hex: '#A0A3A7' },
      { name: 'Ultra Red'                , hex: '#8E1B27' },
      { name: 'Deep Blue Metallic'       , hex: '#223A5E' },
      { name: 'Diamond Black'            , hex: '#121317' },
      { name: 'Midnight Silver Metallic' , hex: '#3A3D42' },
    ]},
    { name: 'Model Y', colors: [
      { name: 'Pearl White Multi-Coat' , hex: '#F2F3F5' },
      { name: 'Solid Black'            , hex: '#0B0B0B' },
      { name: 'Stealth Grey'           , hex: '#54575B' },
      { name: 'Quicksilver'            , hex: '#A0A3A7' },
      { name: 'Ultra Red'              , hex: '#8E1B27' },
      { name: 'Glacier Blue'           , hex: '#A5C2D4' },
      { name: 'Marine Blue'            , hex: '#1C2E4A' },
      { name: 'Deep Blue Metallic'     , hex: '#223A5E' },
    ]},
    { name: 'Model S', colors: [
      { name: 'Pearl White Multi-Coat'   , hex: '#F2F3F5' },
      { name: 'Diamond Black'            , hex: '#121317' },
      { name: 'Stealth Grey'             , hex: '#54575B' },
      { name: 'Lunar Silver'             , hex: '#BFC2C4' },
      { name: 'Frost Blue Metallic'      , hex: '#A3B8CD' },
      { name: 'Ultra Red'                , hex: '#8E1B27' },
      { name: 'Midnight Silver Metallic' , hex: '#3A3D42' },
    ]},
  ],
  'Rivian': [
    { name: 'R1T', colors: [
      { name: 'Glacier White'  , hex: '#F0F1EE' },
      { name: 'Midnight'       , hex: '#14181D' },
      { name: 'El Cap Granite' , hex: '#75777A' },
      { name: 'Red Canyon'     , hex: '#7A2E26' },
      { name: 'Rivian Blue'    , hex: '#33637F' },
      { name: 'Launch Green'   , hex: '#708172' },
      { name: 'Forest Green'   , hex: '#1F3529' },
      { name: 'Compass Yellow' , hex: '#E3A72F' },
    ]},
  ],
  'Volkswagen': [
    { name: 'Golf GTI', colors: [
      { name: 'Tornado Red'                , hex: '#C4212A' },
      { name: 'Pure White'                 , hex: '#F2F2F0' },
      { name: 'Deep Black Pearl'           , hex: '#0A0A0C' },
      { name: 'Reflex Silver Metallic'     , hex: '#A8AAAD' },
      { name: 'Carbon Steel Grey Metallic' , hex: '#4A4D52' },
      { name: 'Kings Red Metallic'         , hex: '#9E1B32' },
      { name: 'Moonstone Grey'             , hex: '#7C8083' },
      { name: 'Atlantic Blue Metallic'     , hex: '#2A3763' },
    ]},
    { name: 'Golf R', colors: [
      { name: 'Lapiz Blue Metallic'   , hex: '#274FA2' },
      { name: 'Deep Black Pearl'      , hex: '#0A0A0C' },
      { name: 'Pure White'            , hex: '#F2F2F0' },
      { name: 'Tornado Red'           , hex: '#C4212A' },
      { name: 'Indium Gray Metallic'  , hex: '#5E6266' },
      { name: 'Oryx White Pearl'      , hex: '#F0EFE8' },
      { name: 'Mythos Black Metallic' , hex: '#0D0F11' },
    ]},
  ],
  'Mini': [
    { name: 'Cooper S', colors: [
      { name: 'Chili Red'               , hex: '#BF1E2E' },
      { name: 'British Racing Green IV' , hex: '#1F4234' },
      { name: 'Midnight Black II'       , hex: '#0F1114' },
      { name: 'Nanuq White'             , hex: '#F1F2EF' },
      { name: 'Melting Silver III'      , hex: '#B4B4B2' },
      { name: 'Blazing Blue'            , hex: '#1E3F8F' },
      { name: 'Island Blue Metallic'    , hex: '#3D7EC1' },
      { name: 'Moonwalk Grey Metallic'  , hex: '#7E8489' },
    ]},
  ],
  'Hyundai': [
    { name: 'Ioniq 5', colors: [
      { name: 'Atlas White'              , hex: '#F4F5F2' },
      { name: 'Abyss Black Pearl'        , hex: '#0B0C0F' },
      { name: 'Cyber Gray Metallic'      , hex: '#8E9294' },
      { name: 'Ecotronic Gray'           , hex: '#9EA1A0' },
      { name: 'Digital Teal Green Pearl' , hex: '#1C3A3D' },
      { name: 'Lucid Blue Pearl'         , hex: '#A3BCD3' },
      { name: 'Ultimate Red Metallic'    , hex: '#A81F2B' },
      { name: 'Gravity Gold Matte'       , hex: '#97845F' },
    ]},
    { name: 'Elantra N', colors: [
      { name: 'Performance Blue' , hex: '#4A7EBB' },
      { name: 'Cyber Gray'       , hex: '#9CA1A5' },
      { name: 'Intense Blue'     , hex: '#23406F' },
      { name: 'Ceramic White'    , hex: '#EFEFEA' },
      { name: 'Phantom Black'    , hex: '#0B0C0E' },
    ]},
  ],
  'Nissan': [
    { name: 'GT-R', colors: [
      { name: 'Pearl White'     , hex: '#EFF0EC' },
      { name: 'Super Silver'    , hex: '#C7C9CB' },
      { name: 'Gun Metallic'    , hex: '#6B6E70' },
      { name: 'Jet Black Pearl' , hex: '#0B0B0D' },
      { name: 'Solid Red'       , hex: '#C4161C' },
      { name: 'Bayside Blue'    , hex: '#2D68B2' },
      { name: 'Millennium Jade' , hex: '#A0AA9E' },
      { name: 'Midnight Purple' , hex: '#35204B' },
    ]},
    { name: 'Z', colors: [
      { name: 'Seiran Blue'            , hex: '#2B7EC1' },
      { name: 'Ikazuchi Yellow'        , hex: '#E3B93C' },
      { name: 'Passion Red'            , hex: '#CF0A2C' },
      { name: 'Everest White Pearl'    , hex: '#F1F2EE' },
      { name: 'Brilliant Silver'       , hex: '#C8CACC' },
      { name: 'Boulder Gray'           , hex: '#7E8285' },
      { name: 'Black Diamond Metallic' , hex: '#0C0D0F' },
      { name: 'Rosewood Metallic'      , hex: '#4E2329' },
    ]},
  ],
  'Mercedes-AMG': [
    { name: 'C63', colors: [
      { name: 'Obsidian Black Metallic' , hex: '#0A0A0C' },
      { name: 'Polar White'             , hex: '#F1F3F2' },
      { name: 'Selenite Grey Metallic'  , hex: '#6E7173' },
      { name: 'Iridium Silver Metallic' , hex: '#A6A9AC' },
      { name: 'Brilliant Blue Metallic' , hex: '#1C4587' },
      { name: 'Hyacinth Red Metallic'   , hex: '#7C1E33' },
      { name: 'Diamond White'           , hex: '#EAEBE6' },
      { name: 'Spectral Blue'           , hex: '#2F5DA8' },
    ]},
  ],
  'Audi': [
    { name: 'RS3', colors: [
      { name: 'Mythos Black Metallic'  , hex: '#0C0C0E' },
      { name: 'Arkona White'           , hex: '#EDEEEC' },
      { name: 'Daytona Grey Pearl'     , hex: '#565A5D' },
      { name: 'Kemora Grey Metallic'   , hex: '#7E8184' },
      { name: 'Tango Red Metallic'     , hex: '#B4121D' },
      { name: 'Kyalami Green'          , hex: '#55A630' },
      { name: 'Python Yellow Metallic' , hex: '#CDC92B' },
      { name: 'Turbo Blue'             , hex: '#2B6CC4' },
    ]},
  ],
  'Cadillac': [
    { name: 'CT5-V Blackwing', colors: [
      { name: 'Black Raven'           , hex: '#0A0A0A' },
      { name: 'Summit White'          , hex: '#EFF0EE' },
      { name: 'Satin Steel Metallic'  , hex: '#85888A' },
      { name: 'Infrared Tintcoat'     , hex: '#921C26' },
      { name: 'Electric Blue'         , hex: '#2A65C2' },
      { name: 'Blaze Orange Metallic' , hex: '#D9571F' },
      { name: 'Wave Metallic'         , hex: '#66A0BE' },
      { name: 'Dark Emerald Frost'    , hex: '#24382E' },
    ]},
  ],
  'Alfa Romeo': [
    { name: 'Giulia Quadrifoglio', colors: [
      { name: 'Vulcano Black Metallic' , hex: '#0D0E10' },
      { name: 'Trofeo White'           , hex: '#F0F1EC' },
      { name: 'Vesuvio Gray Metallic'  , hex: '#4E5052' },
      { name: 'Rosso Competizione'     , hex: '#8A1418' },
      { name: 'Misano Blue Metallic'   , hex: '#2E5FA8' },
      { name: 'Verde Montreal'         , hex: '#2A5C44' },
    ]},
  ],
};
for (const [make, models] of Object.entries(EXPANSION_MODELS)) {
  const existing = CAR_DATABASE.find(m => m.name === make);
  if (existing) existing.models.push(...models);
  else CAR_DATABASE.push({ name: make, models });
}

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

// What people actually type vs how the database spells the make. Dodge/RAM
// cross-listed both ways because "Dodge Ram 1500" is the common phrasing.
const MAKE_ALIASES: Record<string, string> = {
  chevy: 'Chevrolet', vw: 'Volkswagen', mercedes: 'Mercedes-AMG',
  mercedesbenz: 'Mercedes-AMG', benz: 'Mercedes-AMG', amg: 'Mercedes-AMG',
  alfa: 'Alfa Romeo',
};
const ALT_MAKES: Record<string, string[]> = { dodge: ['RAM'], ram: ['Dodge'] };

function colorsInMake(mk: CarMake | undefined, nModel: string): CarColor[] {
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

export function findColorsForTyped(make?: string | null, model?: string | null): CarColor[] {
  const nMake = norm(make), nModel = norm(model);
  if (!nMake || !nModel) return [];
  const canonical = MAKE_ALIASES[nMake] ? norm(MAKE_ALIASES[nMake]) : nMake;
  const primary = colorsInMake(CAR_DATABASE.find(m => norm(m.name) === canonical), nModel);
  if (primary.length) return primary;
  for (const alt of ALT_MAKES[canonical] ?? []) {
    const hit = colorsInMake(CAR_DATABASE.find(m => m.name === alt), nModel);
    if (hit.length) return hit;
  }
  return [];
}

// The generic fallback set, exported for flows (car scan) that show it beside
// or instead of factory colors.
export const GENERIC_COLORS: CarColor[] = DEFAULT_COLORS;
