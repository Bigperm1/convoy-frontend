// nav_lock_regions_test — the marker placer must REFUSE a 🔒 NAV-LOCK marker where a `//` line is not a comment (JSX
// children, a template literal) and must keep a `// @ts-expect-error` glued to its target. Run with the other gates.
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
  { id: "bad-jsx", begin: 7, end: 8 },
  { id: "directive", begin: 13, end: 13 },
]);
console.log("placed:", r.placed.join(","), "| refused:", r.refused.map((x) => x.id).join(","));
const out = r.text.split("\n");
const di = out.findIndex((l) => l.includes("begin directive"));
console.log("directive marker sits ABOVE the @ts-expect-error line:", out[di + 1].includes("@ts-expect-error"));
const pass = r.placed.includes("ok-statement") && r.placed.includes("directive") && r.refused.some((x) => x.id === "bad-template") && r.refused.some((x) => x.id === "bad-jsx") && out[di + 1].includes("@ts-expect-error");
console.log(pass ? "PASS nav_lock_regions" : "FAIL nav_lock_regions");
if (!pass) process.exit(1);
