// depart_facing_test — a GPS course noted below driving pace must not become the car's facing
// (src/departureBearing.ts noteCourse/getDepartureBearing, fed by src/locationPrivacy.ts noteFix).
//
//   node --experimental-strip-types tools/sim-qc/depart_facing_test.mts
//
// Olaf, 2026-09-22 14:14:04Z (07:14 PDT), crash_reports handle=Enablewhore:
//   14:13:59.636  draw-cmp surf=phone mode=pin d=0.0m spd=1 nav=0 acc=4m sep=2m gps=withheld
//                 raw=49.244420,-122.822340 … parked=1 hu=1 spotAge=45398s hdg=0 gpsHdg=295 … fixAge=13637
//                 (the FIRST fresh fix in 8 h: 0.28 m/s, course 295, the phone 2 m from the parked car)
//   14:14:04.226  depart-rank constrained=1 fsrc=course n=2 facing=295 chosenBr=330 off=35 …
//   14:14:42.141  off-route tripped d=54m streak=0 why=diverging step=0
//   14:14:42.564  reroute-result id=1 age=0s moved=0m n=2 stops=0/0 bearing=90 applied
//   14:14:44.094  pose-fix surf=car fixAge=82 acc=2 course=90 spd=31 … road=92 rk=0.98
// The car left EAST, 155° from the "facing". The spot the car had been sitting in all night carried the course
// of the last moving fix before the stop — 01:37:21.986 `draw-cmp … spd=9 … hdg=110 gpsHdg=110`, then
// 01:38:14.054 `carplay-disconnect` (the witnessed park that freezes it) — and getDepartureBearing() never
// consulted it, because a course ≤ 90 s old always answered first and noteCourse() had no speed gate.
// Same shape at 01:17:30Z (facing=191, departed 14°, reroute 45 s later) and Rodrigo 09-21 05:12Z
// (facing=273, itself a 0–1 km/h course).
//
// The fix: noteCourse(heading, speedMs) drops a course below SPOT_WRITE_MAX_SPEED_MS (1.5 m/s — the line the
// car spot's own facing is observed at, carSpotTrust.ts; no new number). C1 and C4 FAIL on the tree before the
// fix (fsrc=course/295) and pass after; C2/C3/C6 are the regression guards for what must NOT change; C8 is the
// review's replay that failed at DRIVING_SPEED_MS 2.5 (a 2.0 m/s U-turn park answered the pre-turn course).
import { registerHooks } from "node:module";
import assert from "node:assert/strict";
// Same no-op stand-ins as uturn_rank_test.mts: departureBearing.ts reaches react-native, expo-* and the
// axios stack through nav.ts. locationPrivacy.ts additionally WRITES AsyncStorage from noteFix and
// noteCarConnected (fire-and-forget, `.catch(() => {})`), so that stub needs real promise-returning methods.
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
    if (STUB.has(s) || s.startsWith("expo-") || s.startsWith("@expo/")) return { url: EMPTY, shortCircuit: true };
    if (s.startsWith(".") && !/\.[a-z]+$/i.test(s)) { try { return n(s + ".ts", c); } catch {} }
    return n(s, c);
  },
});
const { noteCourse, getDepartureBearing, departureBearingSource } = await import("../../src/departureBearing.ts");
const { noteFix, noteCarConnected, carSpot } = await import("../../src/locationPrivacy.ts");
const { SPOT_MAX_AGE_MS, SPOT_WRITE_MAX_SPEED_MS } = await import("../../src/carSpotTrust.ts");

// The clock is ours: every timestamp in these modules comes from Date.now().
let clock = 0;
Date.now = () => clock;
const utc = (h: number, m: number, s: number, d = 22) => Date.UTC(2026, 8, d, h, m, s);
const S = 1000;

let fails = 0;
const out: string[] = [];
async function check(name: string, origin: { lat: number; lng: number }, wantDeg: number | null, wantSrc: string) {
  const got = await getDepartureBearing(origin);
  const src = departureBearingSource();
  const ok = got === wantDeg && src === wantSrc;
  if (!ok) fails++;
  out.push(`${ok ? "ok  " : "FAIL"} ${name}: facing=${got} fsrc=${src} (want ${wantDeg}/${wantSrc})`);
}

// ── C1 OLAF 2026-09-22, replayed from the rows above ─────────────────────────────────────────────────────
{
  const stop = { lat: 49.244423, lng: -122.822350 };      // 01:37:21.986 draw-cmp gps=
  const walk = { lat: 49.244420, lng: -122.822340 };      // 14:13:59.636 draw-cmp raw= (0.8 m from the stop)
  clock = utc(1, 37, 21);
  noteCarConnected(true);                                 // CarPlay was attached (surf=car rows at 01:37:21.756)
  noteFix(stop.lat, stop.lng, 2.5, 110);                  // the last MOVING fix: spd=9 km/h, course 110
  noteCourse(110, 2.5);
  for (let i = 1; i <= 3; i++) { clock = utc(1, 37, 21 + i); noteFix(stop.lat, stop.lng, 0, null); noteCourse(undefined, 0); }
  clock = utc(1, 38, 14); noteCarConnected(false);        // carplay-disconnect app=background nav=0 fix=1
  clock = utc(14, 13, 46);                                // first fresh fix in 8 h: fixAge=13637 at 14:13:59.636
  noteFix(walk.lat, walk.lng, 0.28, 295);                 // 0.28 m/s (draw-cmp spd=1), course 295
  noteCourse(295, 0.28);
  const spot = carSpot();
  assert.ok(spot && spot.hdg === 110, `C1 precondition: the spot must carry hdg 110, got ${JSON.stringify(spot)}`);
  assert.ok(spot!.t! >= utc(1, 37, 21) && spot!.t! <= utc(1, 37, 24), `C1 precondition: spot t at the stop, got ${spot!.t}`);
  assert.ok(utc(14, 14, 4) - spot!.t! <= SPOT_MAX_AGE_MS, "C1 precondition: the spot is inside its 24 h life");
  clock = utc(14, 14, 4);                                 // depart-rank 14:14:04.226
  await check("C1 Olaf 09-22 14:14Z: 0.28 m/s course 295 at the parked car → the spot's 110", walk, 110, "spot");
}

// ── C2 DRIVE, STOP, PLOT INSIDE 90 s — the case the course memory exists for (unchanged) ────────────────
const elsewhere = { lat: 49.30, lng: -123.10 };           // > 25 m from any spot written above
{
  clock += 3600 * S; const T = clock;
  noteCourse(90, 15);
  clock = T + 5 * S; noteCourse(88, 8);
  for (let i = 0; i < 5; i++) { clock = T + (10 + i) * S; noteCourse(undefined, 0); }   // iOS -1 → undefined at rest
  clock = T + 60 * S;
  await check("C2 stopped 50 s ago after driving → last at-speed course 88", elsewhere, 88, "course");
}

// ── C3 THE SAME STOP, PLOT AT T+120 s WITH A WITNESSED PARK → the spot's facing (OTA-AZ guard) ────────────
{
  clock += 3600 * S; const T = clock;
  noteCourse(90, 15);
  noteCarConnected(true);
  clock = T + 5 * S; noteFix(elsewhere.lat, elsewhere.lng, 2.5, 88); noteCourse(88, 2.5);
  for (let i = 0; i < 5; i++) { clock = T + (10 + i) * S; noteFix(elsewhere.lat, elsewhere.lng, 0, null); noteCourse(undefined, 0); }
  clock = T + 40 * S; noteCarConnected(false);
  clock = T + 120 * S;
  await check("C3 course expired (115 s), witnessed park → spot 88", elsewhere, 88, "spot");
}

// ── C4 A CARRIED PHONE, NO SPOT NEARBY — a walker's course is nobody's facing ────────────────────────────
const lot = { lat: 49.20, lng: -122.90 };
{
  clock += 3600 * S; const T = clock;
  noteCourse(295, 0.28);
  clock = T + 18 * S;
  await check("C4 walking 0.28 m/s course 295, no spot → none", lot, null, "none");
}

// ── C5 THE BOUNDARY IS SPOT_WRITE_MAX_SPEED_MS — the spot's own line, so course and spot agree ─────────────
{
  clock += 3600 * S; noteCourse(200, SPOT_WRITE_MAX_SPEED_MS); clock += 1 * S;
  await check(`C5a course at exactly ${SPOT_WRITE_MAX_SPEED_MS} m/s → recorded`, lot, 200, "course");
  clock += 3600 * S; noteCourse(200, SPOT_WRITE_MAX_SPEED_MS - 0.01); clock += 1 * S;
  await check(`C5b course at ${(SPOT_WRITE_MAX_SPEED_MS - 0.01).toFixed(2)} m/s → dropped`, lot, null, "none");
}

// ── C6 NO SPEED GIVEN — fail-open, documented ────────────────────────────────────────────────────────────
{
  clock += 3600 * S; noteCourse(45); clock += 1 * S;
  await check("C6 noteCourse(45) with no speed → 45 (fail-open)", lot, 45, "course");
}

// ── C7 RODRIGO 09-21 05:12Z CONTROL: two low-speed courses; the spot is ASSUMED to carry no heading (his
//    persisted copy was refused written-moving; nothing prints the in-memory one) ──────────────────────────
{
  clock += 3600 * S; const T = clock;
  const rod = { lat: 49.242496, lng: -123.003784 };
  clock = T - 115 * S; noteCourse(181, 0.28);           // 05:10:11 draw-cmp spd=1 gpsHdg=181
  clock = T - 52 * S; noteCourse(331, 0);               // 05:11:14 draw-cmp spd=0 gpsHdg=331
  clock = T;
  await check("C7 Rodrigo: 0–1 km/h courses only, no spot heading → none (rank by ETA alone)", rod, null, "none");
}

// ── C8 THE REVIEW'S REPLAY — a slow U-turn park must still be the facing (fails at 2.5 m/s, passes at 1.5) ──
{
  clock += 3600 * S;
  const P = { lat: 49.25, lng: -123.10 };
  const step = (dt: number, lat: number, lng: number, spd: number, crs: number | null) => { clock += dt * S; noteFix(lat, lng, spd, crs); noteCourse(crs ?? undefined, spd); };
  for (let i = 0; i < 20; i++) step(1, P.lat, P.lng - 0.0030 + i * 0.00014, 10, 90);          // 20 s east at 10 m/s (arms the driving latch)
  const turn = [120, 150, 180, 210, 240, 270, 270, 270];                                      // U-turn park across the street at 2.0 m/s (7 km/h)
  for (let i = 0; i < turn.length; i++) step(1, P.lat + 0.00002 * i, P.lng - 0.0002 + 0.00001 * i, 2.0, turn[i]);
  for (let i = 0; i < 5; i++) step(1, P.lat + 0.00016, P.lng - 0.00013, 0, null);           // at rest
  clock += 30 * S;
  await check("C8 plot 30 s after a 2.0 m/s U-turn park facing 270 → 270 (the turn, not the approach)", { lat: P.lat + 0.00016, lng: P.lng - 0.00013 }, 270, "course");
}

console.log(out.join("\n"));
console.log(fails ? `FAIL depart_facing (${fails})` : "PASS depart_facing");
process.exit(fails ? 1 : 0);
