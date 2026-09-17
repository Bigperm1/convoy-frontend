// nav_lock_regions_test — the marker placer must never leave a `//` marker where it is not a comment: between JSX children
// it switches to the `{/* … */}` form, inside a template literal it REFUSES, and a `// @ts-expect-error` stays glued to
// its target. Run with the other gates.
import { placeMarkers } from "./nav_lock_regions.mts";
const tsx = [
  "export function Foo({ spd }: { spd: number }) {",          // 1
  "  const hot = spd > 2000;",                                 // 2
  "  const label = `speed",                                    // 3
  "  is ${spd}`;",                                             // 4
  "  return (",                                                // 5
  "    <View>",                                                // 6
  "      <Text>{label}</Text>",                                // 7
  "      <Text>plain</Text>",                                  // 8
  "    </View>",                                               // 9
  "  );",                                                      // 10
  "}",                                                         // 11
  "// @ts-expect-error legacy",                                // 12
  "export const X: number = 'a';",                             // 13
].join("\n");
const r = placeMarkers("t.tsx", tsx, [
  { id: "ok-statement", begin: 2, end: 2 },
  { id: "bad-template", begin: 4, end: 4 },
  { id: "jsx-children", begin: 7, end: 8 },
  { id: "directive", begin: 13, end: 13 },
]);
console.log("placed:", r.placed.join(","), "| refused:", r.refused.map((x) => x.id).join(","));
// JSX: a whole child element takes the {/* … */} form; a line inside an opening tag's attribute list is refused.
const tsx2 = ["export const A = () => (", "  <View>", "    <Camera", "      zoom={16.35}", "      pitch={48}", "    />", "    <Text>hi</Text>", "  </View>", ");"].join("\n");
const j = placeMarkers("j.tsx", tsx2, [{ id: "jsx-camera", begin: 3, end: 6 }]);
const jsxOk = j.placed.includes("jsx-camera") && j.text.includes("{/* 🔒 NAV-LOCK begin jsx-camera") && !/^\s*\/\/.*NAV-LOCK/m.test(j.text);
console.log("jsx child → JSX-form marker, never a // line:", jsxOk);
const out = r.text.split("\n");
const di = out.findIndex((l) => l.includes("begin directive"));
console.log("directive marker sits ABOVE the @ts-expect-error line:", out[di + 1].includes("@ts-expect-error"));
const pass = jsxOk && r.placed.includes("ok-statement") && r.placed.includes("directive") && r.refused.some((x) => x.id === "bad-template") && r.placed.includes("jsx-children") && r.text.includes("{/* 🔒 NAV-LOCK begin jsx-children") && out[di + 1].includes("@ts-expect-error");
console.log(pass ? "PASS nav_lock_regions" : "FAIL nav_lock_regions");
if (!pass) process.exit(1);
