// uturn_rank_test — a route that asks for a U-turn must lose to a clean one that costs about the same
// (src/departureBearing.ts orderRoutesForward + src/nav.ts countRouteUturns).
//
//   node --experimental-strip-types tools/sim-qc/uturn_rank_test.mts
//
// Rodrigo (WhatsApp "Hairpin App Testing", 2026-09-20 23:37): "the app loves to send me on borderline illegal
// u-turns. On my last drive tonight it tried to make me do two u turns that weren't safe. Something I haven't
// experience with waze or gmaps" — and 23:46, after a week of running Waze alongside: "it never sent me in
// weird u turns". Jeff, 2026-09-21: "you can fix them ...go".
//
// MEASURED, live Directions replay 2026-09-21 at his 05:12:06Z departure point (49.242496,-123.003784):
//   alt0  363 s  departs 102°  0 U-turns   "Turn right onto Willingdon Avenue"
//   alt1  336 s  departs 360°  1 U-turn    "Make a left U-turn at Willingdon Avenue… if permitted"
// His row: `depart-rank facing=273 chosenBr=344 cands=179/402s,344/379s` — we took alt1. Both scored "forward"
// (inside the 75° gate), so the tie-break was pure duration and a clean route lost by 27 SECONDS.
//
// The OTHER half of his night is the negative control here: at his first reroute (49.243657,-123.003267) BOTH
// alternatives carried the same U-turn — Willingdon is a divided arterial and his destination was behind him —
// so the penalty must cancel out and leave the order alone. Ranking cannot fix that one and must not pretend to.
import { registerHooks } from "node:module";
// orderRoutesForward lives in departureBearing.ts, which reaches react-native, expo-* and the
// axios/AsyncStorage stack through nav.ts — none of which Node can parse. No gate in this
// directory had ever stubbed that surface, which is precisely why the route RANKING had no
// gate until tonight. Everything below is a no-op stand-in; the code under test touches none
// of it (it is pure arithmetic over durations, bearings and maneuver keys), and if a future
// edit makes it touch one, this gate fails loudly rather than testing a stub.
// Every named export the stubbed modules are asked for anywhere in src/, so an unrelated
// import three files away cannot break this gate. All no-ops: the code under test is pure
// arithmetic over durations, bearings and maneuver keys and touches none of them.
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
const STUB = new Set([
  "react", "react-native", "@rnmapbox/maps", "axios",
  "@react-native-async-storage/async-storage",
]);
registerHooks({
  resolve(s: string, c: any, n: any) {
    if (STUB.has(s) || s.startsWith("expo-") || s.startsWith("@expo/")) return { url: EMPTY, shortCircuit: true };
    if (s.startsWith(".") && !/\.[a-z]+$/i.test(s)) { try { return n(s + ".ts", c); } catch {} }
    return n(s, c);
  },
});
const { countRouteUturns } = await import("../../src/nav.ts");
const { orderRoutesForward, hasEarlyUturn, UTURN_PENALTY_S, EARLY_UTURN_M, UTURN_ONLY_TOLERANCE_DEG } = await import("../../src/departureBearing.ts");
const { countUturns } = await import("../../src/mapboxDirections.ts");

let fails = 0;
const ok = (name: string, cond: boolean, detail = "") => { console.log(`${cond ? "  ok  " : "  FAIL"} ${name} ${detail}`); if (!cond) fails++; };

// A NavRoute as the app builds it: steps carry the JOINED maneuver key (mapboxManeuverKey),
// and start/end so routeInitialBearing can read a departure direction.
// ~0.0009° of latitude ≈ 100 m, enough to clear routeInitialBearing's 25 m floor.
const D = 0.0009;
function route(id: string, durS: number, departDeg: number, uturns: number, uturnAtM = 400) {
  const start = { lat: 49.2425, lng: -123.0038 };
  const rad = (departDeg * Math.PI) / 180;
  const end = { lat: start.lat + D * Math.cos(rad), lng: start.lng + D * Math.sin(rad) / Math.cos((start.lat * Math.PI) / 180) };
  // Step 0 carries the distance travelled before the first U-turn, so hasEarlyUturn can
  // tell "U-turn 400 m in" from "U-turn 5 km in".
  const steps: any[] = [{ maneuver: "depart", distance_m: uturnAtM, start, end }];
  for (let i = 0; i < uturns; i++) steps.push({ maneuver: "continue|uturn", distance_m: 50, start: end, end });
  steps.push({ maneuver: "arrive", distance_m: 0, start: end, end });
  return { id, duration_in_traffic_s: durS, steps };
}
const ids = (rs: any[]) => rs.map((r) => r.id).join(",");

console.log("countRouteUturns reads the app's joined key");
ok("C1 continue|uturn counts", countRouteUturns(route("x", 100, 0, 1)) === 1);
ok("C2 a clean route counts 0", countRouteUturns(route("x", 100, 0, 0)) === 0);
ok("C3 two U-turns count 2", countRouteUturns(route("x", 100, 0, 2)) === 2);
ok("C4 a missing/!array steps list is 0, never a throw", countRouteUturns({} as any) === 0 && countRouteUturns(null) === 0);
// THE TRAP this test exists to nail down: the two counters are NOT interchangeable.
ok("C5 mapboxDirections.countUturns returns 0 on a NavRoute (raw-Mapbox shape only) — do not unify them",
  countUturns(route("x", 100, 0, 1) as any) === 0);

console.log("\nRodrigo's departure, 2026-09-20 (the bug)");
{
  const clean = route("clean363", 363, 102, 0);
  const uturn = route("uturn336", 336, 360, 1);
  // facing=273 — both are inside the 75° forward gate, exactly as the field row shows.
  const out = orderRoutesForward([uturn, clean], 273);
  ok("R1 the clean route is chosen even though it is 27 s slower", out[0].id === "clean363", `order=${ids(out)}`);
  ok("R2 the U-turn route is still offered, just not first", out[1].id === "uturn336");
}

console.log("\nThe penalty must not become a ban");
{
  // A U-turn is sometimes genuinely the only sane line. 120 s buys 27 s comfortably;
  // it must not buy a five-minute detour.
  const clean = route("clean700", 700, 102, 0);
  const uturn = route("uturn336", 336, 360, 1);
  const out = orderRoutesForward([clean, uturn], 273);
  ok("P1 a 6-minute-slower clean route does NOT win", out[0].id === "uturn336", `order=${ids(out)}`);
  const justUnder = route("clean455", 336 + UTURN_PENALTY_S - 1, 102, 0);
  ok("P2 clean wins right below the penalty", orderRoutesForward([uturn, justUnder], 273)[0].id === "clean455");
  const justOver = route("clean457", 336 + UTURN_PENALTY_S + 1, 102, 0);
  ok("P3 and loses right above it", orderRoutesForward([uturn, justOver], 273)[0].id === "uturn336");
}

console.log("\nRodrigo's first reroute (the negative control — Mapbox's answer, not ours)");
{
  // Live replay 2026-09-21 at 49.243657,-123.003267: alt0 398 s U=1, alt1 427 s U=1.
  // Equal U-turn counts ⇒ the penalty cancels ⇒ plain fastest-first, unchanged.
  const a = route("alt398", 398, 360, 1);
  const b = route("alt427", 427, 360, 1);
  ok("N1 equal U-turn counts leave the order alone", orderRoutesForward([b, a], 360)[0].id === "alt398", `order=${ids(orderRoutesForward([b, a], 360))}`);
}

console.log("\nEARLY vs LATE: a U-turn 400 m in is a reversal; one 5 km in is not");
{
  ok("E1 a U-turn inside the first 600 m is early", hasEarlyUturn(route("x", 100, 0, 1, 400)));
  ok("E2 a U-turn beyond it is not", !hasEarlyUturn(route("x", 100, 0, 1, EARLY_UTURN_M + 1)));
  ok("E3 a clean route has none", !hasEarlyUturn(route("x", 100, 0, 0)));
  ok("E4 junk in, false out", !hasEarlyUturn(null) && !hasEarlyUturn({} as any));

  // THE FIELD CASE, with his real bearings: `depart-rank facing=273 cands=179/402s,344/379s`.
  // 179 is 94° off his facing — an ordinary right turn out of the lot — so the 75° gate had
  // ALREADY demoted the clean option, and a time penalty alone could never reach past the
  // U-turn route's "forward" status. The early-U-turn rule is what strips it.
  const cleanOffAxis = route("clean402", 402, 179, 0);
  const uturnForward = route("uturn379", 379, 344, 1, 400);
  const out = orderRoutesForward([uturnForward, cleanOffAxis], 273);
  ok("E5 Rodrigo's real row: the clean 94°-off route wins", out[0].id === "clean402", `order=${ids(out)}`);

  // …and the rule Jeff's original complaint depends on still holds: a route that genuinely
  // departs forward keeps its status when its U-turn is far down the line.
  const backwardsClean = route("back100", 100, 93, 0);          // 180° off a facing of 273
  const forwardLateUturn = route("fwd500", 500, 273, 1, 5000);  // U-turn 5 km in
  const out2 = orderRoutesForward([backwardsClean, forwardLateUturn], 273);
  ok("E6 forward-with-a-LATE-U-turn still beats backwards-and-clean", out2[0].id === "fwd500", `order=${ids(out2)}`);
}

console.log("\nNo heading, and the reroute tolerance");
{
  const clean = route("clean363", 363, 102, 0);
  const uturn = route("uturn336", 336, 360, 1);
  ok("H1 with no heading at all the penalty still applies", orderRoutesForward([uturn, clean])[0].id === "clean363");
  ok("H2 undefined heading is not treated as 0°", orderRoutesForward([uturn, clean], undefined)[0].id === "clean363");
  // Mid-drive the reroute path passes UTURN_ONLY_TOLERANCE_DEG (135°) so ordinary turns
  // are not demoted; the penalty has to keep working there too.
  // Mid-drive the reroute path passes 135° so ordinary turns are not demoted. The early-U-turn
  // rule has to keep working there too — that tolerance is about bearings, not about U-turns.
  ok("H3 at the 135° reroute tolerance", orderRoutesForward([uturn, clean], 273, UTURN_ONLY_TOLERANCE_DEG)[0].id === "clean363");
  ok("H4 a single route is returned untouched", orderRoutesForward([uturn], 273)[0].id === "uturn336");
  ok("H5 an empty list does not throw", orderRoutesForward([], 273).length === 0);
}

console.log(fails === 0 ? "\nPASS uturn_rank" : `\nFAIL uturn_rank (${fails})`);
// ⛔ EXIT EXPLICITLY. Unlike every other gate here this one imports nav.ts, which arms the
// timer-liveness pump at module load — so the event loop never drains and a PASSING run would
// hang forever instead of returning to the shell. Cost me one 120 s timeout to find.
process.exit(fails ? 1 : 0);
