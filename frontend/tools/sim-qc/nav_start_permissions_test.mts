// nav_start_permissions_test — starting navigation never opens an OS notification-permission dialog, on iOS or Android,
// whatever the notification status (undetermined / denied / granted); it still takes the "nav" background-location
// hold, persists the overview polyline for the cold car map, and creates the Android nav channel.
// Run: node --experimental-strip-types tools/sim-qc/nav_start_permissions_test.mts
//   NAV_SOURCE_FILE=<path> runs it against another copy of src/navNotification.ts.
//
// The REAL startNavBanner is lifted out of src/navNotification.ts with the TypeScript parser, transpiled, and run in a
// vm context where every name it reads from module scope is a fake. startNavBanner swallows every error (`catch {}`
// around the channel, the storage writes, and the whole body → `return false`), so a missing stub used to look exactly
// like a failed start. Every catch clause is therefore rewritten to RECORD what it swallowed, and each case asserts
// nothing was swallowed: a missing stub (ReferenceError) or a wrong-shaped one (TypeError) fails naming the identifier
// and the line of the catch that swallowed it. Section H proves that on purpose-broken contexts.
//
// History: written by Codex 2026-09-06 (cae7bbb9) as nav_start_permissions_test.cjs. It went red on 2026-09-09
// (fa59a2dc added resetColdDrive(); 3563f63e added resetColdHeal(odoNowM()) on 09-15) and nobody saw it: the standard
// gate loop, `git ls-files 'tools/sim-qc/*_test.mts'`, never matched a .cjs, and the ReferenceError read as
// `result false`. Converted to .mts with the stubs and the swallow recorder 2026-09-25.
// ⚠ A harness gate: it proves the JS start sequence, not what a device shows. src/navNotification.ts is hash-locked
// (nav_lock_test.mts) — this file only reads it.
// EXITS NON-ZERO ON FAILURE.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import ts from "typescript";

let fails = 0;
const ok = (name: string, cond: boolean, detail = "") => {
  if (!cond) { fails++; console.log(`  FAIL ${name} ${detail}`); } else console.log(`  ok   ${name} ${detail}`);
};

const file = process.env.NAV_SOURCE_FILE || fileURLToPath(new URL("../../src/navNotification.ts", import.meta.url));
const source = ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true);
const start = source.statements.find((n): n is ts.FunctionDeclaration => ts.isFunctionDeclaration(n) && n.name?.text === "startNavBanner");
if (!start) { console.log(`\nFAIL nav_start_permissions (startNavBanner not found in ${file})`); process.exit(1); }
const baseLine = source.getLineAndCharacterOfPosition(start.getStart(source)).line;

// ── the swallow recorder: `catch (e) { … }` → `catch (e) { __swallowed(e, "<line>"); … }`, and `catch {}` gets a binding.
let catchSites = 0, unsupportedCatches = 0;
const recordCatches: ts.TransformerFactory<ts.SourceFile> = (ctx) => (sf) => {
  const f = ctx.factory;
  const visit = (node: ts.Node): ts.Node => {
    if (ts.isCatchClause(node)) {
      const block = ts.visitEachChild(node.block, visit, ctx);
      const bound = node.variableDeclaration?.name;
      if (bound && !ts.isIdentifier(bound)) { unsupportedCatches++; return f.updateCatchClause(node, node.variableDeclaration, block); }
      catchSites++;
      const name = bound ? bound.text : "__caught";
      const where = `${file.replace(/^.*\/(src\/)/, "$1")}:${baseLine + sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1}`;
      const record = f.createExpressionStatement(f.createCallExpression(f.createIdentifier("__swallowed"), undefined, [f.createIdentifier(name), f.createStringLiteral(where)]));
      return f.updateCatchClause(node, node.variableDeclaration ?? f.createVariableDeclaration(name), f.updateBlock(block, [record, ...block.statements]));
    }
    return ts.visitEachChild(node, visit, ctx);
  };
  return ts.visitNode(sf, visit) as ts.SourceFile;
};
const code = ts.transpileModule(start.getText(source), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
  transformers: { before: [recordCatches] },
}).outputText;

type Status = "undetermined" | "denied" | "granted";
type Run = { result: unknown; prompts: number; acquisitions: string[]; writes: [string, string][]; channels: string[]; swallowed: string[] };

// Every name startNavBanner reads from module scope. A new call in the source with no stub here fails T* below as a
// swallowed ReferenceError naming it — add the stub, never a try around the call.
async function run(platform: "ios" | "android", status: Status, breakContext?: (ctx: Record<string, any>) => void): Promise<Run> {
  const writes: [string, string][] = [], channels: string[] = [], acquisitions: string[] = [], swallowed: string[] = [];
  let prompts = 0;
  const context: Record<string, any> = {
    exports: {}, Platform: { OS: platform }, Date,
    _stopPromise: null, _route: null, _routePolyline: null, _navEnding: false,
    _stepIdx: 0, _notifiedStep: -1, _routeLookAt: 0, _progressReadAt: 0, _progressWritten: "",
    ROUTE_KEY: "route", PROGRESS_KEY: "progress", NAV_POLY_KEY: "polyline", NAV_CHANNEL: "nav",
    buildSlimRoute: (_route: unknown, label?: string) => ({ routeId: 1, label }),
    resetColdArrival() {}, resetColdDrive() {}, resetColdHeal() {}, odoNowM: () => 0,
    setMapView2D() {}, setCarState() {},
    AsyncStorage: { async setItem(key: string, value: string) { writes.push([key, value]); } },
    async acquireBgLocation(owner: string) { acquisitions.push(owner); return true; },
    Notifications: {
      async getPermissionsAsync() { return { status, granted: status === "granted" }; },
      async requestPermissionsAsync() { prompts++; return { status: "granted", granted: true }; },
      async setNotificationChannelAsync(id: string) { channels.push(id); },
      AndroidImportance: { HIGH: 4 },
    },
    // The error comes from the vm realm, so read name/message, never instanceof.
    __swallowed(e: any, where: string) { swallowed.push(`${where} ${e?.name ?? typeof e}: ${e?.message ?? String(e)}`); },
  };
  breakContext?.(context);
  vm.runInNewContext(code, context);
  const result = await context.exports.startNavBanner({ polyline: "route-line" }, "Destination");
  return { result, prompts, acquisitions, writes, channels, swallowed };
}

console.log("S · the harness");
ok("S1 startNavBanner found and transpiled", code.includes("startNavBanner"), `(${file.replace(/^.*\/(src\/)/, "$1")}:${baseLine + 1})`);
ok("S2 every catch clause records what it swallows", catchSites > 0 && unsupportedCatches === 0, `sites=${catchSites} unsupported=${unsupportedCatches}`);

console.log("T · nav start: no permission prompt, hold taken, polyline persisted — every platform × notification status");
for (const platform of ["ios", "android"] as const) {
  for (const status of ["undetermined", "denied", "granted"] as const) {
    const id = `T ${platform}/${status}`;
    const r = await run(platform, status);
    ok(`${id} nothing swallowed (a missing or wrong-shaped stub lands here by name)`, r.swallowed.length === 0, r.swallowed.join(" | "));
    ok(`${id} startNavBanner returns true`, r.result === true, `result=${String(r.result)}`);
    ok(`${id} no notification-permission prompt`, r.prompts === 0, `prompts=${r.prompts}`);
    ok(`${id} background-location hold taken once as "nav"`, JSON.stringify(r.acquisitions) === '["nav"]', JSON.stringify(r.acquisitions));
    ok(`${id} overview polyline persisted for the cold car map`, r.writes.some(([k, v]) => k === "polyline" && v === "route-line"), JSON.stringify(r.writes.map(([k]) => k)));
    const want = platform === "android" ? '["nav"]' : "[]";
    ok(`${id} nav channel ${platform === "android" ? "created" : "not touched"}`, JSON.stringify(r.channels) === want, JSON.stringify(r.channels));
  }
}

console.log("H · the gate fails loudly, not as `return false`, when the harness is out of step with the source");
{
  // The 2026-09-09 → 09-25 rot, reproduced: the outer catch turns the ReferenceError into `false`. The stub removed is
  // the first of these the source actually calls, so the section also holds on older copies (NAV_SOURCE_FILE).
  const fnText = start.getText(source);
  const probe = ["resetColdDrive", "resetColdArrival", "setMapView2D", "buildSlimRoute"].find((n) => new RegExp(`\\b${n}\\(`).test(fnText));
  ok("H0 the source calls a stub this section can remove", !!probe, `probe=${probe}`);
  const r = await run("ios", "undetermined", (c) => { if (probe) delete c[probe]; });
  ok("H1 a missing stub is swallowed as `return false` by the source …", r.result === false, `result=${String(r.result)}`);
  ok("H2 … and the recorder names it", r.swallowed.some((s) => s.includes(`ReferenceError: ${probe} is not defined`)), r.swallowed.join(" | "));
}
{
  // An inner catch hides a wrong-shaped fake completely: the start still returns true, so only the recorder sees it.
  const r = await run("android", "granted", (c) => { delete c.Notifications.AndroidImportance; });
  ok("H3 a wrong-shaped stub inside an inner catch still returns true …", r.result === true, `result=${String(r.result)}`);
  ok("H4 … and the recorder catches the TypeError", r.swallowed.some((s) => /TypeError/.test(s)), r.swallowed.join(" | "));
}

console.log(fails === 0 ? "\nPASS nav_start_permissions" : `\nFAIL nav_start_permissions (${fails})`);
if (fails) process.exit(1);
