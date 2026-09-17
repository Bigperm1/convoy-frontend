// nav_lock_test — THE NAVIGATION LOCK (Jeff, 2026-09-17: "lets lock in/gate the navigation settings, i think we have
// finally got 95% there, i dont want anything to change without my say so").
//
// Three locks, one manifest (tools/sim-qc/data/nav-lock.json):
//   • CODE-LOCKED files ("hash"): the pure drive-engine modules. Any change to their CODE (comments and whitespace
//     ignored) fails this gate — not just constants: a new branch, a reordered rule, a "harmless" refactor.
//   • VALUE-LOCKED constants ("locked"): in the big mixed files (ConvoyMapbox.tsx, CarMapView.tsx, nav.ts, …) every
//     tunable literal is pinned by value, and any NEW module-scope literal constant that is neither locked nor listed
//     in "ignored" fails too (a knob cannot be smuggled in beside a locked one).
//   • REGION-LOCKED code ("regions"): the inline drive logic inside those mixed files — an effect, a closure, a
//     threshold written as a bare number — sits between two marker comments and is pinned by the same code hash:
//         // 🔒 NAV-LOCK begin <id> — Jeff's say-so required (tools/sim-qc/nav_lock_test.mts)
//         …code…
//         // 🔒 NAV-LOCK end <id>
//     (between JSX children the marker is `{/* 🔒 NAV-LOCK begin <id> … */}`). Removing or renaming a marker fails; so
//     does a marker pair the manifest does not know. ⚠ NEVER type a marker by hand — inside JSX children or a template
//     literal a `//` line is TEXT, not a comment.
//     tools/sim-qc/nav_lock_regions.mts places them and proves (TypeScript printer, comments removed) that the
//     program is byte-identical with and without them.
//
// The ONLY way through a failure is Jeff's say-so, recorded in the manifest:
//   node --experimental-strip-types tools/sim-qc/nav_lock_test.mts --relock "Jeff, 2026-09-2x: <his words>"
// which rewrites the pinned values/hashes from the current tree and appends the quote to "approvals". Never relock
// without the quote; never edit the JSON by hand to make the gate pass. Runs with every other sim-qc gate before
// an OTA or a cut (ship-ota / cut-build skills), and RULES.md carries the rule.
//
//   node --experimental-strip-types tools/sim-qc/nav_lock_test.mts            # the gate (exit 1 on any drift)
//   node --experimental-strip-types tools/sim-qc/nav_lock_test.mts --list src/chaseZoom.ts   # what the extractor sees
//   node --experimental-strip-types tools/sim-qc/nav_lock_test.mts --relock "<quote>"        # Jeff-approved re-pin
import { readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";

const ROOT = new URL("../../", import.meta.url);
const MANIFEST_URL = new URL("./data/nav-lock.json", import.meta.url);

type FileSpec = { hash?: string; locked?: Record<string, string>; regions?: Record<string, string>; ignored?: string[]; watchNew?: boolean; why?: string };
type Manifest = { approvedBy: string; approvedAt: string; note: string; approvals: { at: string; quote: string; changes: string[] }[]; files: Record<string, FileSpec> };

export function stripComments(src: string): string {
  // /* … */ then // … (not inside strings — good enough for our sources, which put URLs in comments, not code),
  // then every run of whitespace → one space, so a reformat is not a "change".
  const noBlock = src.replace(/\/\*[\s\S]*?\*\//g, " ");
  const noLine = noBlock.split("\n").map((l) => {
    let out = ""; let inS: string | null = null;
    for (let i = 0; i < l.length; i++) {
      const c = l[i];
      if (inS) { out += c; if (c === "\\") { out += l[i + 1] ?? ""; i++; } else if (c === inS) inS = null; continue; }
      if (c === "'" || c === '"' || c === "`") { inS = c; out += c; continue; }
      if (c === "/" && l[i + 1] === "/") break;
      out += c;
    }
    return out;
  }).join("\n");
  return noLine.replace(/\s+/g, " ").trim();
}
export const codeHash = (src: string): string => "sha256:" + createHash("sha256").update(stripComments(src)).digest("hex");

// Module-scope literal constants: `export const NAME[: T] = <literal>;` or `const NAME = …` / `let NAME = …` at column 0
// where NAME is SHOUTY (tuning knobs are). The literal runs to the terminating `;` with bracket balance, so arrays and
// small objects are captured whole; trailing `// …` comments are stripped; whitespace is normalised.
export function extractLiterals(src: string): Map<string, { value: string; line: number }> {
  const out = new Map<string, { value: string; line: number }>();
  const lines = src.split("\n");
  const head = /^(?:export\s+)?(?:const|let)\s+([A-Z][A-Z0-9_]+)\s*(?::[^=]+)?=\s*(.*)$/;
  for (let i = 0; i < lines.length; i++) {
    const m = head.exec(lines[i]);
    if (!m) continue;
    let body = m[2];
    let j = i;
    const depth = (s: string) => { let d = 0, inS: string | null = null; for (let k = 0; k < s.length; k++) { const c = s[k]; if (inS) { if (c === "\\") k++; else if (c === inS) inS = null; continue; } if (c === "'" || c === '"' || c === "`") { inS = c; continue; } if (c === "/" && s[k + 1] === "/") break; if ("([{".includes(c)) d++; else if (")]}".includes(c)) d--; } return d; };
    let text = body;
    while ((depth(stripComments(text)) > 0 || !/;\s*(\/\/.*)?$/.test(text.trimEnd())) && j + 1 < lines.length && j - i < 60) { j++; text += "\n" + lines[j]; }
    let lit = stripComments(text).replace(/;\s*$/, "").trim();
    // The initializer's TEXT is what gets pinned (comments stripped, whitespace normalised): numbers incl. 90_000,
    // arithmetic (6 * 3600_000), booleans, strings, `undefined`, arrays/objects, a Platform ternary, a reference to
    // another constant. Skipped: anything that is code rather than a setting — functions, requires, JSX, style sheets —
    // and initializers too long to be a knob. A constant built from another is pinned as written; the other's own pin
    // catches a change to it.
    if (lit.length === 0 || lit.length > 400) continue;
    if (/=>|\bfunction\b|\brequire\(|\bimport\(|StyleSheet\.create|\bnew\s+[A-Z]|<[A-Z][A-Za-z]*[\s/>]|\bawait\b|\buse[A-Z]\w*\(/.test(lit)) continue;
    out.set(m[1], { value: lit, line: i + 1 });
  }
  return out;
}
// `OBJ.field` — a field inside a module-scope object literal (DEFAULT_SETTINGS.speedCameras).
export function extractObjField(src: string, obj: string, field: string): { value: string; line: number } | null {
  const lines = src.split("\n");
  const start = lines.findIndex((l) => new RegExp(`^(?:export\\s+)?const\\s+${obj}\\b`).test(l));
  if (start < 0) return null;
  for (let i = start + 1; i < lines.length && i < start + 400; i++) {
    if (/^\};?\s*$/.test(lines[i])) break;
    const m = new RegExp(`^\\s*${field}\\s*:\\s*(.*)$`).exec(lines[i]);
    if (m) return { value: stripComments(m[1]).replace(/,\s*$/, "").trim(), line: i + 1 };
  }
  return null;
}
// Marker-delimited regions: `// … NAV-LOCK begin <id>` … `// … NAV-LOCK end <id>` (the marker lines themselves are
// not part of the pinned text). A begin without its end is simply absent, so the gate reports the region MISSING.
export const REGION_MARK = /^\s*(?:\/\/|\{\/\*).*\bNAV-LOCK (begin|end) ([A-Za-z0-9_.:-]+)/;
export function extractRegions(src: string): Map<string, { text: string; line: number; endLine: number }> {
  const out = new Map<string, { text: string; line: number; endLine: number }>();
  const lines = src.split("\n"); const open = new Map<string, number>();
  for (let i = 0; i < lines.length; i++) {
    const m = REGION_MARK.exec(lines[i]);
    if (!m) continue;
    if (m[1] === "begin") open.set(m[2], i);
    else if (open.has(m[2])) { const b = open.get(m[2])!; out.set(m[2], { text: lines.slice(b + 1, i).join("\n"), line: b + 1, endLine: i + 1 }); open.delete(m[2]); }
  }
  return out;
}
const norm = (v: string) => v.replace(/\s+/g, " ").trim();
const read = (rel: string) => readFileSync(new URL(rel, ROOT), "utf8");

const args = process.argv.slice(2);
if (args[0] === "--list") {
  const src = read(args[1]);
  for (const [k, v] of extractLiterals(src)) console.log(`${args[1]}:${v.line}  ${k} = ${v.value}`);
  for (const [k, v] of extractRegions(src)) console.log(`${args[1]}:${v.line}-${v.endLine}  REGION ${k}  ${codeHash(v.text).slice(7, 19)}`);
  process.exit(0);
}
if (args[0] === "--init") {
  // First lock from a spec: { hash: [files], values: [files], fields: { file: ["OBJ.field", …] }, ignored: { file: [names] } }
  const spec = JSON.parse(readFileSync(args[1], "utf8"));
  const quote = args.slice(2).join(" ").trim();
  if (!/jeff/i.test(quote)) { console.error("--init needs Jeff's words"); process.exit(2); }
  const files: Record<string, FileSpec> = {};
  for (const f of spec.hash ?? []) files[f] = { hash: codeHash(read(f)), why: "pure drive-engine module: code-locked" };
  for (const f of spec.values ?? []) {
    const src = read(f); const lits = extractLiterals(src); const locked: Record<string, string> = {};
    for (const [k, v] of lits) if (!(spec.ignored?.[f] ?? []).includes(k)) locked[k] = v.value;
    for (const fld of spec.fields?.[f] ?? []) { const [o, ff] = fld.split("."); const cur = extractObjField(src, o, ff); if (cur) locked[fld] = cur.value; }
    const regions: Record<string, string> = {};
    for (const [id, r] of extractRegions(src)) regions[id] = codeHash(r.text);
    files[f] = { locked, ...(Object.keys(regions).length ? { regions } : {}), ignored: spec.ignored?.[f] ?? [], watchNew: true, why: "mixed file: tunable literals value-locked, inline drive logic region-locked, new constants forbidden" };
  }
  const today = quote.match(/20\d\d-\d\d-\d\d/)?.[0] ?? "(date in quote)";
  const m: Manifest = { approvedBy: "Jeff", approvedAt: today, note: "THE NAVIGATION LOCK — see tools/sim-qc/nav_lock_test.mts and RULES.md §4. Edit only via --relock with Jeff's words.", approvals: [{ at: today, quote, changes: ["initial lock"] }], files };
  writeFileSync(MANIFEST_URL, JSON.stringify(m, null, 2) + "\n");
  console.log(`initialised: ${Object.keys(files).length} files, ${Object.values(files).reduce((a, f) => a + (f.hash ? 1 : Object.keys(f.locked ?? {}).length + Object.keys(f.regions ?? {}).length), 0)} locks`);
  process.exit(0);
}
const manifest: Manifest = JSON.parse(readFileSync(MANIFEST_URL, "utf8"));

function currentOf(file: string, name: string, lits: Map<string, { value: string; line: number }>, src: string) {
  if (name.includes(".")) { const [o, f] = name.split("."); return extractObjField(src, o, f); }
  return lits.get(name) ?? null;
}

if (args[0] === "--relock") {
  const quote = args.slice(1).join(" ").trim();
  if (!/jeff/i.test(quote) || quote.length < 12) { console.error("--relock needs Jeff's words, e.g. --relock \"Jeff, 2026-09-20: raise the nose cap to 70\""); process.exit(2); }
  const changes: string[] = [];
  for (const [file, spec] of Object.entries(manifest.files)) {
    const src = read(file); const lits = extractLiterals(src);
    if (spec.hash !== undefined) { const h = codeHash(src); if (h !== spec.hash) { changes.push(`${file}: code ${spec.hash.slice(7, 19)} → ${h.slice(7, 19)}`); spec.hash = h; } }
    if (spec.locked) for (const name of Object.keys(spec.locked)) {
      const cur = currentOf(file, name, lits, src);
      if (!cur) { changes.push(`${file}:${name} REMOVED`); delete spec.locked[name]; continue; }
      if (norm(cur.value) !== norm(spec.locked[name])) { changes.push(`${file}:${name} ${spec.locked[name]} → ${cur.value}`); spec.locked[name] = cur.value; }
    }
    if (spec.watchNew && spec.locked) for (const [name, v] of lits) if (!(name in spec.locked) && !(spec.ignored ?? []).includes(name)) { changes.push(`${file}:${name} NEW = ${v.value} (locked)`); spec.locked[name] = v.value; }
    if (spec.hash === undefined) {
      const found = extractRegions(src); const pinned = spec.regions ?? {};
      for (const id of Object.keys(pinned)) {
        const r = found.get(id);
        if (!r) { changes.push(`${file}#${id} REGION REMOVED`); delete pinned[id]; continue; }
        const h = codeHash(r.text); if (h !== pinned[id]) { changes.push(`${file}#${id} region ${pinned[id].slice(7, 19)} → ${h.slice(7, 19)}`); pinned[id] = h; }
      }
      for (const [id, r] of found) if (!(id in pinned)) { changes.push(`${file}#${id} NEW REGION (locked)`); pinned[id] = codeHash(r.text); }
      if (Object.keys(pinned).length) spec.regions = pinned; else delete spec.regions;
    }
  }
  const today = quote.match(/20\d\d-\d\d-\d\d/)?.[0] ?? "(date in quote)";
  manifest.approvals.push({ at: today, quote, changes });
  manifest.approvedAt = today;
  writeFileSync(MANIFEST_URL, JSON.stringify(manifest, null, 2) + "\n");
  console.log(changes.length ? `relocked ${changes.length} change(s):\n  ${changes.join("\n  ")}` : "relocked: nothing had drifted (approval recorded)");
  process.exit(0);
}

let fails = 0; const say = (s: string) => { fails++; console.log(`  FAIL ${s}`); };
let checked = 0;
for (const [file, spec] of Object.entries(manifest.files)) {
  let src: string;
  try { src = read(file); } catch { say(`${file}: file missing — a locked nav module was deleted or moved`); continue; }
  const lits = extractLiterals(src);
  if (spec.hash !== undefined) { checked++; const h = codeHash(src); if (h !== spec.hash) say(`${file}: CODE CHANGED (${h.slice(7, 19)} ≠ locked ${spec.hash.slice(7, 19)}) — the drive engine may not change without Jeff's say-so`); }
  if (spec.locked) for (const [name, want] of Object.entries(spec.locked)) {
    checked++;
    const cur = currentOf(file, name, lits, src);
    if (!cur) say(`${file}:${name} MISSING (locked at ${want})`);
    else if (norm(cur.value) !== norm(want)) say(`${file}:${name} changed ${want} → ${cur.value} (line ${cur.line}) without Jeff's say-so`);
  }
  if (spec.watchNew) for (const [name, v] of lits) if (!(spec.locked && name in spec.locked) && !(spec.ignored ?? []).includes(name)) say(`${file}:${name} = ${v.value} (line ${v.line}) is a NEW module-scope constant — lock it or list it under "ignored", with Jeff's say-so`);
  if (spec.hash === undefined) {
    const found = extractRegions(src);
    for (const [id, want] of Object.entries(spec.regions ?? {})) {
      checked++;
      const r = found.get(id);
      if (!r) say(`${file}#${id}: REGION MISSING — its NAV-LOCK begin/end markers were removed or renamed`);
      else if (codeHash(r.text) !== want) say(`${file}#${id} (lines ${r.line}-${r.endLine}): LOCKED DRIVE LOGIC CHANGED (${codeHash(r.text).slice(7, 19)} ≠ locked ${want.slice(7, 19)}) without Jeff's say-so`);
    }
    for (const [id, r] of found) if (!(spec.regions && id in spec.regions)) say(`${file}#${id} (line ${r.line}): a NAV-LOCK region the manifest does not know — pin it via --relock with Jeff's say-so`);
  }
}
console.log(`nav-lock: ${Object.keys(manifest.files).length} files, ${checked} locks checked, approved by ${manifest.approvedBy} ${manifest.approvedAt} (${manifest.approvals.length} approval(s) on record)`);
console.log(fails === 0 ? "PASS nav_lock" : `FAIL nav_lock (${fails}) — see tools/sim-qc/nav_lock_test.mts header for the --relock ritual`);
if (fails) process.exit(1);
