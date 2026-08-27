// Paint palettes for the CAR SCAN colour step (backend only).
//
// Jeff, 2026-08-27: *"lets just do main colour swatches for cars and popular car
// club colours like corvette, mustang, camaro, bmw, nissan, jdm, porsche, lambo,
// ferarri etc."* — after we established that a complete every-model colour
// database cannot be built as VERIFIED data (no public source publishes it).
//
// So the picker has three ladders, widest to narrowest:
//   1. Factory colours for the typed model  (carDatabase.ts — most accurate)
//   2. MAIN_COLORS                          (here — covers any car on earth)
//   3. CLUB_PALETTES                        (here — the paints people name with pride)
// plus the hex field, which is the real universal escape hatch.
//
// Nothing here is read by the app's own rendering. The chosen entry rides in the
// scan manifest so the build pipeline can colour-match the reconstruction.

import type { CarColor } from './carDatabase';

/** The universal set — a real car-paint spectrum, not a web colour wheel.
 *  Deliberately plain names: this is the "my car is just blue" ladder, and a
 *  made-up marketing name here would be a lie, not a flourish. */
export const MAIN_COLORS: CarColor[] = [
  { name: 'Black',       hex: '#0B0B0C' },
  { name: 'Matte Black', hex: '#232527' },
  { name: 'Gunmetal',    hex: '#3A3F45' },
  { name: 'Grey',        hex: '#6E7276' },
  { name: 'Silver',      hex: '#B9BDC1' },
  { name: 'White',       hex: '#F2F3F0' },
  { name: 'Red',         hex: '#C8102E' },
  { name: 'Burgundy',    hex: '#7A1220' },
  { name: 'Orange',      hex: '#E2621B' },
  { name: 'Bronze',      hex: '#8C6A3F' },
  { name: 'Gold',        hex: '#C9A227' },
  { name: 'Yellow',      hex: '#F2C400' },
  { name: 'Lime',        hex: '#93C03C' },
  { name: 'Green',       hex: '#1F7A44' },
  { name: 'Dark Green',  hex: '#14432A' },
  { name: 'Teal',        hex: '#16697A' },
  { name: 'Sky Blue',    hex: '#6FB7DC' },
  { name: 'Blue',        hex: '#1B5FBE' },
  { name: 'Navy',        hex: '#16264A' },
  { name: 'Purple',      hex: '#5B2C86' },
  { name: 'Pink',        hex: '#D9528F' },
  { name: 'Tan',         hex: '#C2A57B' },
];

export type ClubPalette = {
  /** Chip label — the club, not the corporate name ("Mopar", not "Stellantis"). */
  label: string;
  colors: CarColor[];
};

/** The legendary paints, by scene. Every name is a REAL factory paint,
 *  web-researched and adversarially fact-checked (2026-08-27). Colour-shift
 *  paints carry their DAYLIGHT body read — a single hex cannot hold a flip. */
export const CLUB_PALETTES: ClubPalette[] = [
  {
    label: 'Corvette',
    colors: [
      { name: 'Torch Red',                  hex: '#CE1B23' },  // C4-C8, RPO GKZ — the Corvette red
      { name: 'Sebring Orange Tintcoat',    hex: '#C9491B' },  // C7 Z06 / C8, RPO G26 — tintcoat, daylight read
      { name: 'Accelerate Yellow Metallic', hex: '#E8D81C' },
      { name: 'Millennium Yellow',          hex: '#EFC61C' },  // C5, the 2001-04 Z06 yellow (two Ns — often misspelled)
      { name: 'Polo Green Metallic',        hex: '#1E3A2B' },  // C4, code 91; 'Polo Green II' code 45 from 1992
      { name: 'Rapid Blue',                 hex: '#3E9BD9' },
      { name: 'Elkhart Lake Blue Metallic', hex: '#1A3D74' },
      { name: 'Nassau Blue Metallic',       hex: '#2F5E96' },  // C2 Sting Ray, 1965-66
      { name: 'Arctic White',               hex: '#F0F1F1' },
      { name: 'Hypersonic Gray Metallic',   hex: '#70757A' },
    ],
  },
  {
    label: 'Mustang',
    colors: [
      { name: 'Wimbledon White', hex: '#F4F2E8' },  // 1964½-1970, code M — the 1965 Shelby GT350
      { name: 'Grabber Blue',    hex: '#2B6BE4' },  // 1969-71 Boss 302; back 2010 on
      { name: 'Highland Green',  hex: '#2A3631' },  // 1968, code R — the Bullitt car
      { name: 'Calypso Coral',   hex: '#E04A2A' },  // 1969-70 — Mach 1 and Boss 302
      { name: 'Grabber Lime',    hex: '#C2D62F' },  // 1971 solid; returned 2020 as a metallic
      { name: 'Grabber Yellow',  hex: '#F7D000' },  // 1970 beside Competition Yellow, took its code in '71
      { name: 'Race Red',        hex: '#CB1720' },  // 2011 on, code PQ — the modern default red
      { name: 'Brittany Blue',   hex: '#5480B2' },  // 1967-68; revived for the 2025 60th Anniversary
      { name: 'Twister Orange',  hex: '#E4571E' },  // 2020 — throwback to the 1970 Twister Special
      { name: 'Kona Blue',       hex: '#21395C' },  // 2010-2012, code L6 — the S197 GT500 blue
    ],
  },
  {
    label: 'Camaro',
    colors: [
      { name: 'Hugger Orange',           hex: '#E2571C' },  // 1969, code 72 — the Z/28 and COPO colour
      { name: 'Daytona Yellow',          hex: '#F1BE12' },  // 1969, code 76
      { name: 'Rallye Green',            hex: '#126B4A' },  // 1968-69 — factory spelling keeps the E
      { name: 'Marina Blue',             hex: '#4C82A8' },  // 1967 only, code F
      { name: 'LeMans Blue',             hex: '#1F5AA0' },  // 1968-69 — one word, LeMans
      { name: 'Cranberry Red',           hex: '#921C28' },  // 1970-72, code 75 — incl. the '71 Z28
      { name: 'Red Hot',                 hex: '#C81E24' },  // 2014-2024, RPO G7C
      { name: 'Shock',                   hex: '#CBDF1F' },  // 2019-2021, RPO GKO
      { name: 'Nightfall Gray Metallic', hex: '#494D51' },  // 2016-2018, RPO G7Q
      { name: 'Summit White',            hex: '#F2F3F4' },  // 2011-2024, RPO GAZ — the default SS/ZL1 white
    ],
  },
  {
    label: 'Mopar',
    colors: [
      { name: 'Plum Crazy',     hex: '#5C2D91' },  // FC7, 1970-71 Challenger / 'Cuda; still sold today
      { name: 'Panther Pink',   hex: '#E8458B' },  // FM3, 1970 — Plymouth called it Moulin Rouge
      { name: 'Go Mango',       hex: '#F15A22' },  // EK2, 1969-70 — Plymouth sold it as Vitamin C
      { name: 'TorRed',         hex: '#E8431F' },  // EV2, 1969-72 — Road Runner, Challenger, 'Cuda
      { name: 'Sublime',        hex: '#A2C523' },  // FJ5, 1970 — the Superbird green
      { name: 'Top Banana',     hex: '#F6D800' },  // FY1, 1970-73 — the '71 Charger R/T
      { name: 'B5 Blue',        hex: '#2A6DBE' },  // EB5 Bright Blue Metallic, 1969 on (NOT 1968 — that's QQ1)
      { name: 'F8 Green',       hex: '#2C4A2C' },  // EF8 Dark Green Metallic, 1970 Charger / Challenger
      { name: 'Sinamon Stick',  hex: '#8C4A2A' },  // PEC, 2020+ Challenger and Charger
      { name: 'Destroyer Gray', hex: '#5C6165' },  // PDN, 2017-2023 — the Hellcat grey
    ],
  },
  {
    label: 'BMW M',
    colors: [
      { name: 'Alpine White',      hex: '#F1F1EE' },  // E30 M3 — the homologation white, still in the book
      { name: 'Dakar Yellow',      hex: '#F0B700' },  // code 267 — E36 M3 launch colour (267 arrived 1992, so NOT E30)
      { name: 'Cinnabar Red',      hex: '#C82E1E' },  // E30 — Zinnoberrot
      { name: 'Techno Violet',     hex: '#563377' },  // E36 M3 — the one E36 people hunt for
      { name: 'Estoril Blue',      hex: '#1D4F9E' },  // E36 M3; Estoril Blue II on the F80
      { name: 'Imola Red',         hex: '#AE1017' },  // E46 M3 / E39 M5
      { name: 'Laguna Seca Blue',  hex: '#0C92DF' },  // E46 M3, code 448 — measured; the reposted #444488 is wrong
      { name: 'Sakhir Orange',     hex: '#C0521A' },  // F80 M3 / F82 M4
      { name: 'Yas Marina Blue',   hex: '#0F7FC8' },  // F80/F82, code B68 — measured hue ~203, an azure not a royal
      { name: 'Isle of Man Green', hex: '#22402F' },  // G80 M3, code C4G. ⚠ HEX UNVERIFIED — dark gloss reflects sky
    ],
  },
  {
    label: 'Porsche',
    colors: [
      { name: 'Guards Red',         hex: '#CE1220' },  // 911 SC through today — the archetypal Porsche red
      { name: 'Rubystone Red',      hex: '#C21B5E' },  // 964 Carrera RS 3.8 / Turbo S
      { name: 'Speed Yellow',       hex: '#F6C400' },  // 993 / 996 GT3 and Turbo
      { name: 'Signal Green',       hex: '#2A8C3E' },  // 964 / 993
      { name: 'Python Green',       hex: '#04A64B' },  // 992 GT3 / 718 — a standard SOLID vivid green
      { name: 'Riviera Blue',       hex: '#0089D6' },  // 993 / 996 GT3 — the cult 90s blue
      { name: 'Miami Blue',         hex: '#00AEC7' },  // 991.2 GT3 / 718 Cayman GT4
      { name: 'Viola Metallic',     hex: '#5A4B84' },  // 964 / 993 / 996 — the 90s purple
      { name: 'GT Silver Metallic', hex: '#BFC3C6' },  // Carrera GT signature
      { name: 'Chalk',              hex: '#BCBAB0' },  // 991 GT3 / 718 — 'Kreide', the collector grey
    ],
  },
  {
    label: 'Audi / AMG',
    colors: [
      { name: 'Nogaro Blue Pearl Effect', hex: '#2E3D74' },  // Audi RS2 / B5 RS4 — the founding RS colour
      { name: 'Imola Yellow',             hex: '#F0D400' },  // Audi B5 S4 / RS4, first-gen TT
      { name: 'Misano Red Pearl Effect',  hex: '#931623' },  // Audi B7 RS4 / B8 S4
      { name: 'Nardo Grey',               hex: '#9C9E9D' },  // Audi RS, code LY7C — NOT #C0C6C8 (that's Suzuka Gray)
      { name: 'Kyalami Green',            hex: '#4F9B3E' },  // Audi RS, code LZ6A — a bright SOLID lime, not a dark metallic
      { name: 'Brilliant Blue Metallic',  hex: '#1D4E8E' },  // AMG GT / C 63
      { name: 'Solarbeam Yellow',         hex: '#F0DA0A' },  // AMG GT / A 45 S
      { name: 'AMG Green Hell Magno',     hex: '#869561' },  // AMG GT R — named for the Nürburgring
      { name: 'Selenite Grey Magno',      hex: '#71767A' },  // AMG GT R / C 63 — matte
      { name: 'Patagonia Red Metallic',   hex: '#9A1C22' },  // AMG GT R / Black Series
    ],
  },
  {
    label: 'Nissan',
    colors: [
      { name: 'Bayside Blue',        hex: '#0B4EA2' },  // R34 GT-R, revived on R35 — daylight read
      { name: 'Midnight Purple II',  hex: '#3B2A50' },  // R34 V-Spec — DAYLIGHT read; a hex can't hold the flip
      { name: 'Midnight Purple III', hex: '#6A5C7E' },  // R34 V-Spec — DAYLIGHT read; this one flips green/gold
      { name: 'Millennium Jade',     hex: '#6C7059' },  // R34 M-Spec Nür (2002)
      { name: 'Championship Blue',   hex: '#2A5EA6' },  // BT2 — R33 GT-R LM Limited, the Calsonic blue (NOT R32)
      { name: 'Gun Metallic',        hex: '#55595C' },  // R35 GT-R
      { name: 'Super Silver',        hex: '#B9BDC0' },  // R35 GT-R — the launch silver
      { name: 'Solid Red',           hex: '#C41230' },  // R35 GT-R
      { name: 'Ikazuchi Yellow',     hex: '#F0C020' },  // Z (RZ34)
      { name: 'Seiran Blue',         hex: '#4E9AD4' },  // Z (RZ34)
    ],
  },
  {
    label: 'JDM Legends',
    colors: [
      { name: 'Championship White',      hex: '#F2F2EE' },  // Honda NSX-R, Integra Type R, Civic Type R
      { name: 'Berlina Black',           hex: '#0C0C0F' },  // Honda S2000 and NSX
      { name: 'New Formula Red',         hex: '#CE1126' },  // Acura/Honda NSX and S2000
      { name: 'Long Beach Blue Pearl',   hex: '#1E4F9E' },  // NSX; revived on the 2021 Type S
      { name: 'Renaissance Red',         hex: '#B2202C' },  // Toyota Supra A80 — the MkIV red
      { name: 'Nitro Yellow',            hex: '#E9C31A' },  // Toyota GR Supra A90
      { name: 'Innocent Blue Mica',      hex: '#96B9D4' },  // Mazda RX-7 FD3S
      { name: 'Competition Yellow Mica', hex: '#F2CE21' },  // RX-7 FD3S R1, 1993 only (~350 cars)
      { name: 'World Rally Blue Pearl',  hex: '#1858A6' },  // Subaru WRX STI — the rally blue
      { name: 'Rally Red',               hex: '#C21F26' },  // Mitsubishi Lancer Evolution VIII / IX / X
    ],
  },
  {
    label: 'Lexus',
    colors: [
      { name: 'Whitest White',            hex: '#F8F8F6' },  // LFA — the launch colour
      { name: 'Pearl Yellow',             hex: '#EEC63C' },  // LFA
      { name: 'Pearl Blue',               hex: '#2A6BB5' },  // LFA
      { name: 'Matte Black',              hex: '#1C1C1E' },  // LFA — special order
      { name: 'Absolutely Red',           hex: '#CC1122' },  // IS300, SC430, IS F
      { name: 'Ultrasonic Blue Mica 2.0', hex: '#1A5FC4' },  // RC F / GS F / IS F
      { name: 'Molten Pearl',             hex: '#B4632E' },  // RC F — the 2015 launch colour
      { name: 'Infrared',                 hex: '#A50F26' },  // RC F and LC 500
      { name: 'Nori Green Pearl',         hex: '#32453B' },  // LC 500
      { name: 'Structural Blue',          hex: '#0B4CA8' },  // LC 500 Structural Blue Edition
    ],
  },
  {
    label: 'Ferrari',
    colors: [
      { name: 'Rosso Corsa',         hex: '#D40000' },  // the archetypal Ferrari red, every era
      { name: 'Rosso Dino',          hex: '#FC652E' },  // the Dino 246 red-orange; still on modern specials
      { name: 'Giallo Modena',       hex: '#FCE903' },  // Modena's civic yellow — F40 onward
      { name: 'Blu Tour de France',  hex: '#2243AA' },  // named for the 250 GT Tour de France
      { name: 'Azzurro California',  hex: '#7FA6C6' },  // the 250 California light blue
      { name: 'Verde British',       hex: '#004225' },  // Ferrari's British racing green — 250/275 era
      { name: 'Argento Nurburgring', hex: '#CACBCE' },  // the front-mid-engine GT silver
      { name: 'Nero Daytona',        hex: '#231F1C' },  // metallic black, F50 onward
      { name: 'Grigio Silverstone',  hex: '#585C64' },  // 458 Speciale onward
      { name: 'Bianco Avus',         hex: '#F2F3F6' },  // the classic Ferrari white
    ],
  },
  {
    label: 'Lamborghini',
    colors: [
      { name: 'Verde Mantis',     hex: '#7DC23B' },  // Gallardo / Murciélago, carried to the Huracán
      { name: 'Verde Ithaca',     hex: '#AEFF7E' },  // Aventador — the neon green of the era
      { name: 'Arancio Borealis', hex: '#FBA400' },  // Gallardo, then the Huracán Performante
      { name: 'Giallo Orion',     hex: '#F5C518' },  // Murciélago, then Aventador
      { name: 'Blu Cepheus',      hex: '#39BFFE' },  // Murciélago through Urus
      { name: 'Rosso Mars',       hex: '#CE1126' },  // Aventador, Huracán, Urus
      { name: 'Viola Pasifae',    hex: '#6B0686' },  // Aventador and Huracán
      { name: 'Grigio Telesto',   hex: '#7692A5' },  // the stealth grey
      { name: 'Nero Nemesis',     hex: '#312F30' },  // matte black — Huracán / Aventador
      { name: 'Bianco Monocerus', hex: '#EDEDED' },  // Huracán Performante and Urus
    ],
  },
  {
    label: 'British & Hyper',
    colors: [
      { name: 'Papaya Spark',              hex: '#FF7A1A' },  // McLaren, code 3965 — reads LIGHTER than McLaren Orange #FF8000
      { name: 'Volcano Yellow',            hex: '#F0C400' },  // McLaren — 12C through 720S
      { name: 'Ceramic Grey',              hex: '#ADB0B2' },  // McLaren MSO grey of the 10,000th car (570S, 2016)
      { name: 'Silica White',              hex: '#E8E7E2' },  // McLaren — 570S, GT, Super Series
      { name: 'Aston Martin Racing Green', hex: '#0A3622' },  // Aston Martin — DB and Vantage
      { name: 'Lightning Silver',          hex: '#C7CACC' },  // Aston Martin — DB9, DB11, Vantage
      { name: 'Ultra Blue',                hex: '#0E5AC8' },  // Jaguar F-Type R / SVR
      { name: 'Chrome Orange',             hex: '#F25C05' },  // Lotus Elise / Exige
      { name: 'Racing Green',              hex: '#17472F' },  // Lotus code B86 — verified on the Exige (there is no Lotus 'Motorsport Green')
      { name: 'French Racing Blue',        hex: '#1B3D8F' },  // Bugatti — Chiron Sport and Veyron
    ],
  },
];

/** Find a paint's name across every ladder here, for display. */
export function paintNameFor(hex?: string | null): string | undefined {
  if (!hex) return undefined;
  const h = hex.toLowerCase();
  const main = MAIN_COLORS.find((c) => c.hex.toLowerCase() === h);
  if (main) return main.name;
  for (const g of CLUB_PALETTES) {
    const hit = g.colors.find((c) => c.hex.toLowerCase() === h);
    if (hit) return hit.name;
  }
  return undefined;
}
