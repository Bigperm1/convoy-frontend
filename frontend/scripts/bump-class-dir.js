// bump-class-dir.js — rename assets/images/classes-vN → classes-v(N+1) and
// repoint the two require sites. Run this to GUARANTEE a class-image OTA lands
// on devices even when a native build has embedded the current dir.
//
// WHY: expo-updates dedupes EMBEDDED assets by PATH-key, not content. Once a
// native build bakes in `classes-vN`, changing those files' CONTENT via OTA is
// silently ignored (the embedded copy wins). A fresh dir = fresh path/key = no
// embedded match = forced download. See memory: ota-asset-path-key-trap.
//
// RULE: bump right AFTER cutting a native build (which embeds the current dir),
// before the next image-change OTA. Between native builds it's optional (a dir
// that was never embedded already delivers content changes).
//
//   node scripts/bump-class-dir.js
const fs = require("fs");
const path = require("path");

const IMG_DIR = "assets/images";
const REQUIRE_FILES = ["src/vehicleAssets.ts", "src/classLayers.tsx", "scripts/class-bands.js", "scripts/class-asset.js", "scripts/class-transparent.js"];

// find the current classes-vN
const cur = fs.readdirSync(IMG_DIR).filter((d) => /^classes-v\d+$/.test(d)).sort((a, b) => parseInt(b.slice(9)) - parseInt(a.slice(9)))[0];
if (!cur) { console.error("no classes-vN dir found under " + IMG_DIR); process.exit(1); }
const n = parseInt(cur.slice("classes-v".length), 10);
const next = `classes-v${n + 1}`;

fs.renameSync(path.join(IMG_DIR, cur), path.join(IMG_DIR, next));
console.log(`renamed ${cur} → ${next}`);

for (const f of REQUIRE_FILES) {
  if (!fs.existsSync(f)) continue;
  const before = fs.readFileSync(f, "utf8");
  const after = before.split(`images/${cur}/`).join(`images/${next}/`);
  if (after !== before) { fs.writeFileSync(f, after); console.log(`  repointed ${f}`); }
}
console.log(`\nDone. New class images now live at ${IMG_DIR}/${next}/ and WILL deliver via OTA.`);
