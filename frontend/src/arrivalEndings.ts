// arrivalEndings.ts — WHAT Nova says on arrival: one utterance, place first, then the weather
// at the destination right now, then one context-chosen closer (2026-09-05).
//
// Jeff, 2026-09-05 23:20: "Nova also says the destination name AFTER telling the weather on
// arrival. It should say something like: 'You have arrived at <saved place name>. The weather
// is 19 degrees right now.' Then add a series of endings like 'great driving' / 'enjoy the sun'
// — make up 10-20 of them around the drive / weather / work / home / the custom place name."
//
// Pure and dependency-free (no React / react-native imports; the one `import type` is erased)
// so tools/sim-qc/arrival_line_test.mts drives it under plain Node
// (`node --experimental-strip-types`). src/nav.ts owns WHEN the line is spoken and prefetched;
// this module owns WHAT is said, so the order is fixed by construction:
//
//   "You have arrived at Lake. It's 19 degrees and sunny right now. Enjoy the sun."
//   "You have arrived. Great driving."                       (no usable label, no forecast)
//
// The weather sentence is skipped ENTIRELY when there is no forecast or the temperature is not
// a finite number — "undefined degrees" cannot be composed.

import type { WeatherKind } from "./weatherLayer";
import { chooseArrivalPlaceCloser } from "./arrivalPlaceClosers.ts";

/** The business at the destination (src/placeIdentity.ts), when one was resolved. */
export type ArrivalPlaceInfo = { name: string; primaryType: string | null; types: readonly string[]; openNow?: boolean | null; quip?: string | null };

export type ArrivalPlaceKind = "home" | "work" | "custom";

export type ArrivalWeather = {
  /** Temperature in the driver's display unit (°F when speedUnit is mph, else °C), spoken as-is. */
  temp: number;
  /** Always Celsius: the cold / hot closers threshold on this whatever the display unit. */
  tempC: number;
  kind: WeatherKind;
};

export type ArrivalEndingCtx = {
  placeKind?: ArrivalPlaceKind | null;
  /** The cleaned spoken label; the {name} closers need it and are skipped without it. */
  placeName?: string | null;
  weather?: ArrivalWeather | null;
  /** Local hour 0–23. */
  hour?: number | null;
  /** Minutes since nav started, when known. */
  driveMin?: number | null;
};

export type EndingTag =
  | "home" | "work" | "custom" | "sunny" | "rain" | "snow" | "cold" | "hot" | "night" | "long" | "generic";

export type ArrivalEnding = {
  text: string;
  tags: readonly EndingTag[];
  /** Assumes a drive back — never right for an arrival at home. */
  notHome?: boolean;
};

// Spoken-friendly closers: at most 8 words each, no emoji, no dashes (the TTS voice reads an
// em dash as a beat of silence at best). {name} is the cleaned custom place name.
export const ARRIVAL_ENDINGS: readonly ArrivalEnding[] = [
  { text: "Welcome home.", tags: ["home"] },
  { text: "Home safe, nice work.", tags: ["home"] },
  { text: "Have a great day at work.", tags: ["work"] },
  { text: "Go get 'em.", tags: ["work"] },
  { text: "Enjoy {name}.", tags: ["custom"] },
  { text: "Have a great time at {name}.", tags: ["custom"] },
  { text: "Enjoy the sun.", tags: ["sunny"] },
  { text: "Perfect day for it.", tags: ["sunny"] },
  { text: "Stay dry.", tags: ["rain"] },
  { text: "Drive safe on the way back.", tags: ["rain", "snow"], notHome: true },
  { text: "Stay warm out there.", tags: ["snow", "cold"] },
  { text: "Bundle up, it's chilly.", tags: ["cold"] },
  { text: "Stay cool and drink some water.", tags: ["hot"] },
  { text: "Get some rest.", tags: ["night"] },
  { text: "Sleep well.", tags: ["night"] },
  { text: "Great driving, that was a long one.", tags: ["long"] },
  { text: "Nice work on the long haul.", tags: ["long"] },
  { text: "Great driving.", tags: ["generic"] },
  { text: "Nice drive.", tags: ["generic"] },
  { text: "Thanks for driving with Hairpin.", tags: ["generic"] },
];

export const COLD_MAX_C = 5;
export const HOT_MIN_C = 28;
export const NIGHT_FROM_HOUR = 21;
export const NIGHT_UNTIL_HOUR = 4;   // exclusive: 21:00 through 03:59 is "night"
export const LONG_DRIVE_MIN = 60;

/** The closer contexts this arrival is in — the tags its candidate endings may carry. */
export function endingTagsFor(ctx: ArrivalEndingCtx): EndingTag[] {
  const tags: EndingTag[] = [];
  if (ctx.placeKind === "home") tags.push("home");
  else if (ctx.placeKind === "work") tags.push("work");
  else if (ctx.placeKind === "custom" && ctx.placeName) tags.push("custom");
  const k = ctx.weather?.kind;
  if (k === "clear-day" || k === "partly-day") tags.push("sunny");
  else if (k === "rain" || k === "thunder") tags.push("rain");
  else if (k === "snow") tags.push("snow");
  const c = ctx.weather?.tempC;
  if (typeof c === "number" && Number.isFinite(c)) {
    if (c < COLD_MAX_C) tags.push("cold");
    else if (c > HOT_MIN_C) tags.push("hot");
  }
  const h = ctx.hour;
  if (typeof h === "number" && (h >= NIGHT_FROM_HOUR || h < NIGHT_UNTIL_HOUR)) tags.push("night");
  if (typeof ctx.driveMin === "number" && ctx.driveMin > LONG_DRIVE_MIN) tags.push("long");
  return tags;
}

let _lastEndingIdx = -1;
/** Test seam: forget the last pick so a gate can start each scenario clean. */
export function resetArrivalEndingMemory(): void { _lastEndingIdx = -1; }

/**
 * Pick one closer for this arrival. Candidates are every ending tagged with one of the
 * arrival's contexts (the generic ones only when nothing specific applies); the closer chosen
 * last time is never chosen again back-to-back — when excluding it empties a one-entry pool,
 * the generic set steps in. `rand` is injectable for the gate.
 */
export function chooseArrivalEnding(
  ctx: ArrivalEndingCtx,
  rand: () => number = Math.random,
): { index: number; text: string } {
  const tags = endingTagsFor(ctx);
  const specific: number[] = [];
  const generic: number[] = [];
  ARRIVAL_ENDINGS.forEach((e, i) => {
    if (e.notHome && ctx.placeKind === "home") return;
    if (e.tags.includes("generic")) generic.push(i);
    else if (e.tags.some((t) => tags.includes(t))) specific.push(i);
  });
  let pool = (specific.length ? specific : generic).filter((i) => i !== _lastEndingIdx);
  if (!pool.length) pool = generic.filter((i) => i !== _lastEndingIdx);
  const index = pool[Math.min(pool.length - 1, Math.max(0, Math.floor(rand() * pool.length)))];
  _lastEndingIdx = index;
  return { index, text: ARRIVAL_ENDINGS[index].text.replace("{name}", ctx.placeName ?? "") };
}

// A label only earns its way into speech if it reads as a place. Anything absurdly long
// is almost always a full formatted address with a country and postcode glued on, which
// is a mouthful mid-drive; fall back to the unnamed form rather than recite it.
// (Moved here from src/nav.ts unchanged, 2026-09-05, so the gate can drive it.)
export const ARRIVAL_LABEL_MAX = 60;
export function cleanArrivalLabel(label?: string | null): string | null {
  let t = (label || "").trim();
  if (!t) return null;
  // Drop a trailing country/postcode tail from formatted addresses so "123 Main St,
  // Langley, BC V3A 1B2, Canada" speaks as "123 Main Street, Langley".
  const parts = t.split(",").map((x) => x.trim()).filter(Boolean);
  if (parts.length > 2) t = parts.slice(0, 2).join(", ");
  if (!t || t.length > ARRIVAL_LABEL_MAX) return null;
  // A bare coordinate pair is a label in name only.
  if (/^-?\d+(\.\d+)?\s*,\s*-?\d+(\.\d+)?$/.test(t)) return null;
  return t;
}

/** The condition word after "and": "It's 19 degrees and sunny right now." */
export function arrivalWeatherWord(kind: WeatherKind): string | null {
  switch (kind) {
    case "clear-day": return "sunny";
    case "clear-night": return "clear";
    case "partly-day":
    case "partly-night": return "partly cloudy";
    case "cloudy": return "cloudy";
    case "fog": return "foggy";
    case "rain": return "raining";
    case "snow": return "snowing";
    case "thunder": return "stormy";
    default: return null;
  }
}

/** The weather sentence, or null when there is nothing sayable (no forecast / no finite temp). */
export function arrivalWeatherSentence(w: ArrivalWeather | null | undefined): string | null {
  if (!w || typeof w.temp !== "number" || !Number.isFinite(w.temp)) return null;
  const t = Math.round(w.temp);
  const n = t < 0 ? `minus ${Math.abs(t)}` : `${t}`;
  const unit = Math.abs(t) === 1 ? "degree" : "degrees";
  const cond = arrivalWeatherWord(w.kind);
  return cond ? `It's ${n} ${unit} and ${cond} right now.` : `It's ${n} ${unit} right now.`;
}

export type ArrivalLineInput = {
  destLabel?: string | null;
  placeKind?: ArrivalPlaceKind | null;
  /** The resolved business at the destination — names the arrival when the destination is not a
   *  saved place, and picks the closer by what the place IS (src/arrivalPlaceClosers.ts). */
  place?: ArrivalPlaceInfo | null;
  weather?: ArrivalWeather | null;
  hour?: number | null;
  driveMin?: number | null;
};

export type ArrivalUtterance = {
  text: string;
  /** Whether the weather sentence is in it (the `wx=` receipt field). */
  wx: boolean;
  /** Index into ARRIVAL_ENDINGS (the `ending=` receipt field); 100 = a place-type closer,
   *  101 = the closed line, 102 = a generated quip. */
  endingIndex: number;
  /** The cleaned place actually spoken, null for the unnamed form. */
  place: string | null;
  /** `poi=` receipt: the arrival was named after a resolved business. */
  poi: boolean;
};

/** The whole arrival line: "You have arrived at {place}." + weather sentence + closer. */
export function composeArrivalLine(input: ArrivalLineInput, rand: () => number = Math.random): ArrivalUtterance {
  // A saved place keeps its own name and closers ("Welcome home."); otherwise a resolved business
  // names the arrival and its type picks the closer (Jeff, 2026-09-06: "you have arrived at
  // International Motorsports, looking to buy a bike today?").
  const poi = !input.placeKind && !!input.place?.name ? input.place : null;
  const place = poi ? poi.name : cleanArrivalLabel(input.destLabel);
  const opener = place ? `You have arrived at ${place}.` : "You have arrived.";
  const wx = arrivalWeatherSentence(input.weather);
  const poiCloser = poi ? chooseArrivalPlaceCloser(poi, rand) : null;
  if (poiCloser) {
    const idx = poiCloser.src === "quip" ? 102 : poiCloser.src === "closed" ? 101 : 100;
    return { text: [opener, wx, poiCloser.text].filter(Boolean).join(" "), wx: !!wx, endingIndex: idx, place, poi: true };
  }
  const ending = chooseArrivalEnding({
    placeKind: input.placeKind ?? null,
    placeName: place,
    weather: input.weather ?? null,
    hour: input.hour ?? null,
    driveMin: input.driveMin ?? null,
  }, rand);
  return { text: [opener, wx, ending.text].filter(Boolean).join(" "), wx: !!wx, endingIndex: ending.index, place, poi: !!poi };
}
