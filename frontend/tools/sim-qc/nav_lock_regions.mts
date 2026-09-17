// nav_lock_regions — places the 🔒 NAV-LOCK region markers that tools/sim-qc/nav_lock_test.mts pins, and PROVES the
// markers are comments: the file is parsed with the TypeScript compiler before and after, printed with comments
// removed, and the two programs must be identical. (Inside JSX children or a template literal a `//` line is TEXT —
// it would render on screen — and a marker between a `// @ts-expect-error` and its target would un-suppress it.)
// Between JSX CHILDREN the marker takes the JSX comment form `{/* 🔒 NAV-LOCK begin <id> … */}` (an empty expression
// container: renders nothing); the placer tries `//` first and falls back to it, and refuses when neither is a no-op.
// Every accepted placement is cross-checked with @babel/parser — the parser Metro bundles with.
//
//   node --experimental-strip-types tools/sim-qc/nav_lock_regions.mts --check plan.json   # dry run, writes nothing
//   node --experimental-strip-types tools/sim-qc/nav_lock_regions.mts --apply plan.json   # writes the markers
//   node --experimental-strip-types tools/sim-qc/nav_lock_regions.mts --verify            # every marker in every
//                                                          # manifest file is a real comment (run after hand edits)
//
// plan.json: { "<repo-relative file>": [ { "id": "reroute-accept", "begin": 1201, "end": 1260, "what": "…" }, … ] }
// `begin`/`end` are 1-based, inclusive, and refer to the file AS IT IS NOW (markers are inserted bottom-up, so the
// numbers of one plan stay valid while it is applied). Placing markers changes no behaviour and needs no approval;
// PINNING them does — that is nav_lock_test.mts --relock / --init with Jeff's words.
import { readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";

// Same pattern as nav_lock_test.mts REGION_MARK (that module runs the gate at import, so it cannot be imported here).
const REGION_MARK = /^\s*(?:\/\/|\{\/\*).*\bNAV-LOCK (begin|end) ([A-Za-z0-9_.:-]+)/;

const require = createRequire(import.meta.url);
const ts = require("typescript") as typeof import("typescript");
const ROOT = new URL("../../", import.meta.url);
const read = (rel: string) => readFileSync(new URL(rel, ROOT), "utf8");

export function printedProgram(file: string, text: string): string {
  const kind = file.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, kind);
  const errs = ((sf as any).parseDiagnostics ?? []).length;
  return (errs ? `/*PARSE-ERRORS:${errs}*/` : "") + ts.createPrinter({ removeComments: true, newLine: ts.NewLineKind.LineFeed }).printFile(sf);
}
// A JSX-form marker is an EMPTY expression container between children: it prints as `{}` and splits the whitespace-only
// JSX text around it (which JSX discards). So that form is compared with `{}` and all whitespace removed — any marker
// that became real content (its words inside a string, a template, JSX text) still shows up as a difference.
const loose = (printed: string) => printed.replace(/\s+/g, "").replace(/\{\}/g, "");
// Metro parses with Babel, not TypeScript: the same before/after proof through @babel/parser + generator, when present.
let babel: { parse: (t: string) => string } | null = null;
try {
  const parser = require("@babel/parser"); const gen = require("@babel/generator").default;
  babel = { parse: (t: string) => loose(gen(parser.parse(t, { sourceType: "module", plugins: ["jsx", "typescript"] }), { comments: false, compact: true }).code) };
} catch { babel = null; }
export function babelShape(text: string): string | null {
  if (!babel) return "";
  try { return babel.parse(text); } catch { return null; }
}
export function babelSame(before: string, after: string): boolean {
  const a = babelShape(before), b = babelShape(after);
  return a != null && a === b;
}

type Region = { id: string; begin: number; end: number; what?: string };
const DIRECTIVE = /@ts-(expect-error|ignore|nocheck)|eslint-disable-next-line/;
const beginLine = (indent: string, id: string, jsx = false) => jsx
  ? `${indent}{/* 🔒 NAV-LOCK begin ${id} — Jeff's say-so required to change this (tools/sim-qc/nav_lock_test.mts) */}`
  : `${indent}// 🔒 NAV-LOCK begin ${id} — Jeff's say-so required to change this (tools/sim-qc/nav_lock_test.mts)`;
const endLine = (indent: string, id: string, jsx = false) => jsx ? `${indent}{/* 🔒 NAV-LOCK end ${id} */}` : `${indent}// 🔒 NAV-LOCK end ${id}`;

export function placeMarkers(file: string, text: string, regions: Region[]): { text: string; placed: string[]; refused: { id: string; why: string }[] } {
  const refused: { id: string; why: string }[] = []; const placed: string[] = [];
  // Each placement is proven a no-op against the file AS IT STANDS (earlier markers included), in both parsers.
  let curPrinted = printedProgram(file, text);
  let curBabel = babelShape(text);
  let lines = text.split("\n");
  const existing = new Set<string>(); for (const l of lines) { const m = REGION_MARK.exec(l); if (m) existing.add(m[2]); }
  const sane = regions
    .filter((r) => {
      if (!/^[A-Za-z0-9_.:-]+$/.test(r.id)) { refused.push({ id: r.id, why: "id has characters outside [A-Za-z0-9_.:-]" }); return false; }
      if (existing.has(r.id)) { refused.push({ id: r.id, why: "already marked in the file" }); return false; }
      if (!(r.begin >= 1 && r.end >= r.begin && r.end <= lines.length)) { refused.push({ id: r.id, why: `lines ${r.begin}-${r.end} outside the file (${lines.length})` }); return false; }
      return true;
    })
    .sort((a, b) => b.begin - a.begin);
  for (let i = 0; i + 1 < sane.length; i++) if (sane[i + 1].end >= sane[i].begin) { refused.push({ id: sane[i + 1].id, why: `overlaps ${sane[i].id}` }); sane.splice(i + 1, 1); i--; }
  for (const r of sane) {
    let b = r.begin - 1;                                   // 0-based index of the region's first line
    while (b > 0 && DIRECTIVE.test(lines[b - 1])) b--;       // never split a suppression comment from its target
    for (let k = b; k <= r.end - 1; k++) if (REGION_MARK.test(lines[k])) { b = -1; break; }
    if (b < 0) { refused.push({ id: r.id, why: "contains another region's marker" }); continue; }
    const indent = /^\s*/.exec(lines[b])![0];
    const make = (jsx: boolean) => [...lines.slice(0, b), beginLine(indent, r.id, jsx), ...lines.slice(b, r.end), endLine(indent, r.id, jsx), ...lines.slice(r.end)];
    let trial = make(false);
    let pr = printedProgram(file, trial.join("\n"));
    let ok = pr === curPrinted;
    if (!ok && file.endsWith(".tsx")) { trial = make(true); pr = printedProgram(file, trial.join("\n")); ok = !pr.startsWith("/*PARSE-ERRORS") && loose(pr) === loose(curPrinted); }
    const bs = ok ? babelShape(trial.join("\n")) : null;
    if (ok && (bs == null || bs !== curBabel)) ok = false;
    if (!ok) { refused.push({ id: r.id, why: "no marker form is a no-op here (a template literal, or the range splits a construct)" }); continue; }
    lines = trial; curPrinted = pr; curBabel = bs; placed.push(r.id);
  }
  return { text: lines.join("\n"), placed, refused };
}

const args = process.argv.slice(2);
if (args[0] === "--verify") {
  const manifest = JSON.parse(readFileSync(new URL("./data/nav-lock.json", import.meta.url), "utf8"));
  let bad = 0;
  for (const [file, spec] of Object.entries<any>(manifest.files)) {
    if (!spec.regions) continue;
    const src = read(file);
    const without = src.split("\n").filter((l) => !REGION_MARK.test(l)).join("\n");
    const same = loose(printedProgram(file, src)) === loose(printedProgram(file, without)) && babelSame(without, src);
    console.log(`${same ? "ok  " : "BAD "} ${file}: ${Object.keys(spec.regions).length} region(s)${same ? "" : " — a NAV-LOCK marker is not a comment where it stands"}`);
    if (!same) bad++;
  }
  process.exit(bad ? 1 : 0);
}
if (args[0] === "--check" || args[0] === "--apply") {
  const plan = JSON.parse(readFileSync(args[1], "utf8")) as Record<string, Region[]>;
  let refusedN = 0, placedN = 0;
  for (const [file, regions] of Object.entries(plan)) {
    const src = read(file);
    const res = placeMarkers(file, src, regions);
    placedN += res.placed.length; refusedN += res.refused.length;
    console.log(`${file}: ${res.placed.length} placed${res.refused.length ? `, ${res.refused.length} REFUSED` : ""}`);
    for (const r of res.refused) console.log(`    refused ${r.id}: ${r.why}`);
    if (args[0] === "--apply" && res.placed.length) writeFileSync(new URL(file, ROOT), res.text);
  }
  console.log(`${args[0] === "--apply" ? "applied" : "dry run"}: ${placedN} region(s) placed, ${refusedN} refused`);
  process.exit(0);
}
if (import.meta.url === `file://${process.argv[1]}`) { console.error("usage: --check plan.json | --apply plan.json | --verify"); process.exit(2); }
