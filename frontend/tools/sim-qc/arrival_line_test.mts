// arrival_line_test.mts — text gate for src/arrivalEndings.ts, the ONE arrival utterance (2026-09-05).
// Run: node --experimental-strip-types tools/sim-qc/arrival_line_test.mts
// EXITS NON-ZERO ON FAILURE — this is a gate, not a printout.
//
// Jeff, 2026-09-05 23:20: "Nova also says the destination name AFTER telling the weather on
// arrival. It should say something like: 'You have arrived at <saved place name>. The weather
// is 19 degrees right now.' Then add a series of endings." The receipts from his 20:36 PDT
// arrival: `tts-say len=45 → tts-play len=50` right before `arrive-speak` was the final-leg
// prepare callout ("In 50 m, you will arrive at your destination.", m→meters = +5) and the
// 18-char arrival line ("This is it — Lake.") followed it. This gate pins the one utterance:
//   1. ORDER: place, then weather, then the closer — every context, every random pick;
//   2. NO LABEL: "You have arrived." (empty / coordinate pair / over-long address);
//   3. NO FORECAST: no weather sentence at all, and never "undefined" or "NaN" anywhere;
//   4. every context maps to a non-empty closer that carries that context's tag;
//   5. 20 consecutive picks in one context never repeat back-to-back;
//   6. no closer contains a dash or an emoji, none exceeds 8 words, no "{name}" leaks;
//   7. Jeff's example composes EXACTLY: "You have arrived at Lake. It's 19 degrees and sunny
//      right now. <closer>" (and, with the random seam pinned, "... Enjoy Lake.");
//   8. the receipt fields (wx / endingIndex) describe the text they ride with.
// Running this under plain Node is itself the proof that the module has no react-native import.
import {
  ARRIVAL_ENDINGS, chooseArrivalEnding, composeArrivalLine, endingTagsFor, resetArrivalEndingMemory,
  arrivalWeatherSentence, cleanArrivalLabel, type ArrivalEndingCtx, type ArrivalWeather, type EndingTag,
} from "../../src/arrivalEndings.ts";

const fails: string[] = [];
const check = (ok: boolean, msg: string) => { if (!ok) fails.push(msg); };

const SUNNY: ArrivalWeather = { temp: 19, tempC: 19, kind: "clear-day" };
const CONTEXTS: Record<EndingTag, ArrivalEndingCtx> = {
  home: { placeKind: "home", placeName: "Home", hour: 14 },
  work: { placeKind: "work", placeName: "Work", hour: 9 },
  custom: { placeKind: "custom", placeName: "Lake", hour: 14 },
  sunny: { weather: SUNNY, hour: 14 },
  rain: { weather: { temp: 12, tempC: 12, kind: "rain" }, hour: 14 },
  snow: { weather: { temp: 10, tempC: 10, kind: "snow" }, hour: 14 },    // 10 °C so "cold" does not also apply
  cold: { weather: { temp: 2, tempC: 2, kind: "cloudy" }, hour: 14 },
  hot: { weather: { temp: 31, tempC: 31, kind: "cloudy" }, hour: 14 },
  night: { hour: 22 },
  long: { hour: 14, driveMin: 95 },
  generic: { hour: 14 },
};
const TAGS = Object.keys(CONTEXTS) as EndingTag[];
const endingText = (index: number, name: string | null) => ARRIVAL_ENDINGS[index].text.replace("{name}", name ?? "");

// ── 6: the pool itself
check(ARRIVAL_ENDINGS.length >= 15 && ARRIVAL_ENDINGS.length <= 20, `pool size ${ARRIVAL_ENDINGS.length} (want 15–20)`);
const EMOJI = /[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}]/u;
for (const e of ARRIVAL_ENDINGS) {
  const words = e.text.replace("{name}", "Lake").trim().split(/\s+/).length;
  check(words <= 8, `"${e.text}" is ${words} words (max 8)`);
  check(!/[—–]/.test(e.text), `"${e.text}" contains a dash`);
  check(!EMOJI.test(e.text), `"${e.text}" contains an emoji`);
  check(/[.!?]$/.test(e.text), `"${e.text}" does not end a sentence`);
  check(e.tags.length > 0, `"${e.text}" has no tags`);
}
for (const t of TAGS) {
  check(ARRIVAL_ENDINGS.some((e) => e.tags.includes(t)), `no ending is tagged "${t}"`);
}

// ── 4 + 5: every context picks a closer that carries its tag; 20 in a row never repeat
for (const t of TAGS) {
  const ctx = CONTEXTS[t];
  const tags = endingTagsFor(ctx);
  if (t === "generic") check(tags.length === 0, `generic context derived tags [${tags.join(",")}]`);
  else check(tags.includes(t), `context "${t}" derives tags [${tags.join(",")}] without "${t}"`);
  resetArrivalEndingMemory();
  const first = chooseArrivalEnding(ctx);
  check(first.text.trim().length > 0, `context "${t}": empty closer`);
  check(ARRIVAL_ENDINGS[first.index].tags.includes(t), `context "${t}": first pick "${first.text}" is not tagged "${t}"`);
  let prev = first.index;
  for (let i = 0; i < 20; i++) {
    const pick = chooseArrivalEnding(ctx);
    check(pick.text.trim().length > 0, `context "${t}": empty closer on pick ${i}`);
    check(pick.index !== prev, `context "${t}": "${pick.text}" repeated back-to-back on pick ${i}`);
    check(!pick.text.includes("{name}"), `context "${t}": "{name}" leaked in "${pick.text}"`);
    prev = pick.index;
  }
}
// A one-entry pool (hot) must alternate with the generic set rather than repeat itself.
resetArrivalEndingMemory();
const hotA = chooseArrivalEnding(CONTEXTS.hot), hotB = chooseArrivalEnding(CONTEXTS.hot);
check(hotA.index !== hotB.index && ARRIVAL_ENDINGS[hotB.index].tags.includes("generic"),
  `hot: one-entry pool did not fall back to generic (got "${hotA.text}" then "${hotB.text}")`);
// "Drive safe on the way back." is never right at home.
resetArrivalEndingMemory();
for (let i = 0; i < 60; i++) {
  const pick = chooseArrivalEnding({ placeKind: "home", placeName: "Home", weather: { temp: 8, tempC: 8, kind: "rain" }, hour: 14 });
  check(!/way back/i.test(pick.text), `home + rain picked "${pick.text}"`);
}

// ── 1 + 8: order and receipt fields, across every context and many random picks
const RE_OPENER = /^You have arrived( at (.+?))?\. /;
let ordered = 0;
for (const t of TAGS) {
  for (let i = 0; i < 25; i++) {
    const ctx = CONTEXTS[t];
    const r = composeArrivalLine({ destLabel: ctx.placeName ?? null, placeKind: ctx.placeKind, weather: ctx.weather, hour: ctx.hour, driveMin: ctx.driveMin });
    const m = RE_OPENER.exec(r.text + " ");
    check(!!m, `context "${t}": does not open with the arrival: "${r.text}"`);
    const closer = endingText(r.endingIndex, r.place);
    check(r.text.endsWith(closer), `context "${t}": does not end with its closer "${closer}": "${r.text}"`);
    const wxAt = r.text.indexOf("It's ");
    const closerAt = r.text.lastIndexOf(closer);
    const openerEnd = m ? m[0].length : 0;
    if (r.wx) check(wxAt >= openerEnd - 1 && wxAt < closerAt, `context "${t}": weather not between place and closer: "${r.text}"`);
    else check(wxAt < 0 || wxAt === closerAt, `context "${t}": wx=0 but a weather sentence is present: "${r.text}"`);
    check(r.wx === / right now\./.test(r.text.slice(0, closerAt)), `context "${t}": wx flag disagrees with the text: "${r.text}"`);
    check(!/undefined|NaN|\{name\}|null/.test(r.text), `context "${t}": placeholder leaked: "${r.text}"`);
    if (m && ordered === 0 && r.wx) ordered = 1;
  }
}

// ── 7: Jeff's example, exactly
resetArrivalEndingMemory();
const lake = composeArrivalLine({ destLabel: "Lake", placeKind: "custom", weather: SUNNY, hour: 14, driveMin: 30 });
check(lake.text === `You have arrived at Lake. It's 19 degrees and sunny right now. ${endingText(lake.endingIndex, "Lake")}`,
  `Jeff's example composed as "${lake.text}"`);
check(lake.wx === true && lake.place === "Lake", `Jeff's example receipt: wx=${lake.wx} place=${lake.place}`);
resetArrivalEndingMemory();
const pinned = composeArrivalLine({ destLabel: "Lake", placeKind: "custom", weather: SUNNY, hour: 14, driveMin: 30 }, () => 0);
check(pinned.text === "You have arrived at Lake. It's 19 degrees and sunny right now. Enjoy Lake.",
  `pinned example composed as "${pinned.text}"`);

// ── 2: the no-label form
for (const label of [null, undefined, "", "   ", "49.13823,-122.59453", "1234 Very Long Street Name Boulevard, Some Faraway Municipality Name"]) {
  const r = composeArrivalLine({ destLabel: label, weather: SUNNY, hour: 14 });
  check(r.text.startsWith("You have arrived. It's 19 degrees and sunny right now. "), `label ${JSON.stringify(label)}: "${r.text}"`);
  check(r.place === null, `label ${JSON.stringify(label)}: place=${r.place}`);
}
check(cleanArrivalLabel("123 Main St, Langley, BC V3A 1B2, Canada") === "123 Main St, Langley", "address tail trim changed");
check(composeArrivalLine({ destLabel: "123 Main St, Langley, BC V3A 1B2, Canada", hour: 14 }).text.startsWith("You have arrived at 123 Main St, Langley. "), "address form");
check(composeArrivalLine({ destLabel: "Home", placeKind: "home", hour: 14 }).text.startsWith("You have arrived at Home. "), "home form");

// ── 3: the no-forecast form and the weather sentence's edges
for (const w of [null, undefined, { temp: Number.NaN, tempC: Number.NaN, kind: "rain" as const }, { temp: Number.POSITIVE_INFINITY, tempC: 0, kind: "rain" as const }]) {
  const r = composeArrivalLine({ destLabel: "Lake", placeKind: "custom", weather: w, hour: 14 });
  check(!r.wx && !/degree|right now|undefined|NaN/.test(r.text), `weather ${JSON.stringify(w)}: "${r.text}"`);
  check(r.text.startsWith("You have arrived at Lake. ") && r.text.endsWith(endingText(r.endingIndex, "Lake")), `weather ${JSON.stringify(w)}: shape "${r.text}"`);
}
check(arrivalWeatherSentence({ temp: -3, tempC: -3, kind: "snow" }) === "It's minus 3 degrees and snowing right now.", "negative temperature");
check(arrivalWeatherSentence({ temp: 1, tempC: 1, kind: "cloudy" }) === "It's 1 degree and cloudy right now.", "singular degree");
check(arrivalWeatherSentence({ temp: 66.4, tempC: 19, kind: "clear-day" }) === "It's 66 degrees and sunny right now.", "fahrenheit passthrough / rounding");
check(arrivalWeatherSentence({ temp: 18, tempC: 18, kind: "thunder" }) === "It's 18 degrees and stormy right now.", "thunder word");
check(arrivalWeatherSentence({ temp: 14, tempC: 14, kind: "clear-night" }) === "It's 14 degrees and clear right now.", "clear-night word");
check(arrivalWeatherSentence({ temp: 14, tempC: 14, kind: "partly-night" }) === "It's 14 degrees and partly cloudy right now.", "partly word");

// ── summary
resetArrivalEndingMemory();
const samples = [
  composeArrivalLine({ destLabel: "Lake", placeKind: "custom", weather: SUNNY, hour: 14, driveMin: 30 }).text,
  composeArrivalLine({ destLabel: "Home", placeKind: "home", weather: { temp: 9, tempC: 9, kind: "rain" }, hour: 22, driveMin: 75 }).text,
  composeArrivalLine({ destLabel: "Work", placeKind: "work", weather: null, hour: 8 }).text,
  composeArrivalLine({ destLabel: null, weather: null, hour: 14 }).text,
];
console.log(
  `pool=${ARRIVAL_ENDINGS.length} closers | contexts=${TAGS.length} × (tagged first pick + 20 no-repeat picks) | ` +
  `order+receipt checks=${TAGS.length * 25} | no-label forms=6 | no-forecast forms=4 | hot→generic fallback | home never "way back"\n` +
  samples.map((s) => `  e.g. ${s}`).join("\n"),
);
if (fails.length) { console.error("FAIL:\n  " + fails.join("\n  ")); process.exit(1); }
console.log("PASS");
