// weather_word_test — the weather WORD and GLYPH come from what the sky looks like and what is
// falling, not from a model's cover percentage or a probability (src/weatherLayer.ts, 2026-09-22).
//
//   node --experimental-strip-types tools/sim-qc/weather_word_test.mts
//
// Jeff, 2026-09-22: "it always shows cloudy even when its sunny and no clouds … scout mentioned
// twice it was raining at the end destination but it had not rained all day and sunny."
// MEASURED that afternoon: OpenWeather id 803 clouds=77 % at his location while METAR CYXX read
// FEW043TCU SCT046 BKN250 (a broken deck of cirrus at 25,000 ft — sunny to anyone under it); his
// 13:42 PDT greeting read a 3-hour forecast block for a 3-minute drive; the same feed carried a
// block `id=500 light rain pop=0.23 rain3h=0.16`.
import { registerHooks } from "node:module";
const EXPORTS = [
  "AccessibilityInfo","ActivityIndicator","Alert","Animated","AppRegistry","AppState","Audio",
  "DeviceEventEmitter","Dimensions","Easing","File","FlatList","Image","ImageBackground",
  "InterruptionModeAndroid","InterruptionModeIOS","Keyboard","KeyboardAvoidingView","LineLayer",
  "Linking","Modal","NativeModules","PanResponder","PixelRatio","Pressable","SafeAreaView",
  "ScrollView","ShapeSource","StyleSheet","Switch","Text","TextInput","TouchableOpacity",
  "Vibration","View","processColor","useCallback","useEffect","useRef","useState",
  "useWindowDimensions","getHeadingAsync","api","requireOptionalNativeModule",
  "requireNativeModule","EventEmitter","NativeModulesProxy","createAudioPlayer","setAudioModeAsync",
];
const EMPTY = "data:text/javascript,"
  + "const client=()=>({interceptors:{request:{use(){}},response:{use(){}}},get(){},post(){},put(){},delete(){},defaults:{headers:{}}});"
  + "export default { setAccessToken(){}, create:client, ...client() };"
  + "export const Platform={OS:'ios',select:(o)=>o.ios??o.default};"
  + EXPORTS.map((n) => `export const ${n}=(()=>{const f=function(){};f.create=()=>({});f.addEventListener=()=>({remove(){}});f.getHeadingAsync=()=>Promise.resolve(null);return f;})();`).join("");
const STORAGE = "data:text/javascript,"
  + "export default { getItem:()=>Promise.resolve(null), setItem:()=>Promise.resolve(), removeItem:()=>Promise.resolve() };";
const STUB = new Set(["react", "react-native", "@rnmapbox/maps", "axios"]);
registerHooks({
  resolve(s: string, c: any, n: any) {
    if (s === "@react-native-async-storage/async-storage") return { url: STORAGE, shortCircuit: true };
    if (STUB.has(s) || s.startsWith("expo-") || s.startsWith("@expo/") || s.startsWith("@react-native")) return { url: EMPTY, shortCircuit: true };
    if (s.startsWith(".") && !/\.[a-z]+$/i.test(s)) { try { return n(s + ".ts", c); } catch {} }
    return n(s, c);
  },
});
const W = await import("../../src/weatherLayer.ts");

let fails = 0;
const ok = (name: string, cond: boolean, detail = "") => { if (!cond) { fails++; console.log(`  FAIL ${name} ${detail}`); } else console.log(`  ok   ${name} ${detail}`); };
const cond = (over: Partial<any>) => ({ tempC: 20, tempF: 68, feelsLikeC: 20, feelsLikeF: 68, description: "Clear", icon: "", humidity: 50, windSpeedKph: 0, windSpeedMph: 0, windDirectionDeg: 0, precipProbability: 0, visibility: 10, uvIndex: 0, isDaytime: true, fetchedAt: 0, ...over });

console.log("S. the sky as seen — sun stays until overcast");
{
  // demoteTraceRain(id, pop, mm, clouds) returns owDesc(id) for dry ids, so it is the one exported door to the mapping.
  ok("S1 id 803 'broken clouds' (Jeff's 77 %, METAR BKN250 cirrus) → Partly cloudy → glyph partly-day (sun + cloud)",
    W.demoteTraceRain(803, 0, 0, 77) === "Partly cloudy" && W.weatherKind(cond({ description: "Partly cloudy" })) === "partly-day");
  ok("S2 id 801 / 802 → Partly cloudy", W.demoteTraceRain(801, 0, 0, 20) === "Partly cloudy" && W.demoteTraceRain(802, 0, 0, 40) === "Partly cloudy");
  ok("S3 id 804 overcast (≥ 85 %) → Overcast → glyph cloudy (the grey cloud is earned)",
    W.demoteTraceRain(804, 0, 0, 92) === "Overcast" && W.weatherKind(cond({ description: "Overcast" })) === "cloudy");
  ok("S4 id 800 → Clear → clear-day / clear-night by daylight",
    W.demoteTraceRain(800, 0, 0, 0) === "Clear" && W.weatherKind(cond({ description: "Clear" })) === "clear-day" && W.weatherKind(cond({ description: "Clear", isDaytime: false })) === "clear-night");
  ok("S5 fog / snow / thunder untouched", W.demoteTraceRain(741, 0, 0, 100) === "Fog" && W.demoteTraceRain(600, 0.2, 0.1, 90) === "Snow" && W.demoteTraceRain(211, 0.2, 0.1, 90) === "Thunderstorm");
}

console.log("R. a forecast block's rain is only rain when the model is sure AND it is worth an umbrella");
{
  ok("R1 the measured block id=500 pop=0.23 rain3h=0.16 clouds=53 → Partly cloudy, not Rain", W.demoteTraceRain(500, 0.23, 0.16, 53) === "Partly cloudy");
  ok("R2 id=500 pop=1 rain3h=1.65 clouds=99 → Rain (real rain stays)", W.demoteTraceRain(500, 1, 1.65, 99) === "Rain");
  ok("R3 sure but trace: pop=0.9 rain3h=0.2 → by cover (Overcast at 90 %)", W.demoteTraceRain(500, 0.9, 0.2, 90) === "Overcast");
  ok("R4 wet but unsure: pop=0.3 rain3h=2 → by cover", W.demoteTraceRain(501, 0.3, 2, 40) === "Partly cloudy");
  ok("R5 the boundary is inclusive: pop=0.5 rain3h=0.5 → Rain", W.demoteTraceRain(500, W.RAIN_POP_MIN, W.RAIN_MM_MIN, 50) === "Rain");
  ok("R6 drizzle (3xx) follows the same rule", W.demoteTraceRain(300, 0.1, 0.05, 10) === "Clear" && W.demoteTraceRain(300, 0.8, 0.6, 80) === "Drizzle");
  ok("R7 the spoken word: Partly cloudy → 'partly cloudy'; Rain → 'raining' (novaGreeting weatherWord reads weatherKind)",
    W.weatherKind(cond({ description: "Partly cloudy" })) === "partly-day" && W.weatherKind(cond({ description: "Rain" })) === "rain");
}

console.log("A. arrival weather: what is THERE NOW when you are nearly there, the block otherwise");
{
  const now = Date.UTC(2026, 8, 22, 20, 42, 0);           // Jeff's 13:42 PDT greeting
  const cur = cond({ description: "Partly cloudy", fetchedAt: now - 60_000, owId: 803, cloudsPct: 77 });
  const block = { startMs: Date.UTC(2026, 8, 22, 20, 0, 0), endMs: Date.UTC(2026, 8, 22, 23, 0, 0), condition: cond({ description: "Rain", owId: 500, pop: 0.6, rainMm: 0.8 }) };
  const dest = { hours: [block], current: cur };
  const p1 = W.pickArrivalWeather(dest, now + 3 * 60_000, now);
  ok("A1 a 3-minute drive → the destination's CURRENT conditions (src=cur), not the block's rain", p1?.src === "cur" && p1?.cond.description === "Partly cloudy");
  const p2 = W.pickArrivalWeather(dest, now + 2 * 3600_000, now);
  ok("A2 a 2-hour drive → the forecast block (src=fc)", p2?.src === "fc" && p2?.cond.description === "Rain");
  const p3 = W.pickArrivalWeather({ hours: [block], current: cond({ description: "Clear", fetchedAt: now - 45 * 60_000 }) }, now + 3 * 60_000, now);
  ok("A3 a 45-min-old current reading is not fresh (30 min) → the block", p3?.src === "fc");
  const p4 = W.pickArrivalWeather({ hours: null, current: cur }, now + 3 * 3600_000, now);
  ok("A4 no forecast at all → current, whatever the distance", p4?.src === "cur");
  ok("A5 the boundary: exactly 90 min → current; 90 min + 1 s → block", W.pickArrivalWeather(dest, now + W.NEAR_ARRIVAL_MS, now)?.src === "cur" && W.pickArrivalWeather(dest, now + W.NEAR_ARRIVAL_MS + 1000, now)?.src === "fc");
  ok("A6 nothing → null", W.pickArrivalWeather(null, now, now) === null && W.pickArrivalWeather({ hours: null, current: null }, now, now) === null);
}

console.log(fails ? `\nFAIL weather_word (${fails})` : "\nPASS weather_word");
process.exit(fails ? 1 : 0);
