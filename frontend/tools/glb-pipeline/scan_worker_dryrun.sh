#!/bin/bash
# scan_worker_dryrun.sh — prove the scan worker's logic with ZERO credits spent and ZERO
# bytes published. Runs on this Mac: no Docker, no `supabase start`, no service role.
#
#   1. builds the GLB fixtures (raw Tripo converts + scan_finish.py reference) from a
#      manual render directory, if one is given
#   2. `deno check` + `deno lint` + `deno test` for supabase/functions/scan-worker
#   3. starts tools/glb-pipeline/tripo_stub.py on :8787
#   4. runs supabase/functions/scan-worker/dryrun.ts against the stub, the read-only
#      fetch-scan door, and the PUBLIC models bucket (HEAD/GET only)
#
# Usage:
#   tools/glb-pipeline/scan_worker_dryrun.sh [--render-dir <tripo-<scan> dir>] [--fixtures <dir>]
#
# Secrets: the anon key is read from src/supabase.ts (public by design) and the
# fetch-scan key from ~/.hairpin/publish-model.key (read only, never printed). Both are
# optional — without them steps 1–2 of the dry run are skipped.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
FN="$ROOT/supabase/functions/scan-worker"
STUB="$ROOT/tools/glb-pipeline/tripo_stub.py"
RENDER_DIR=""
FIXTURES="${GLB_FIXTURES_DIR:-}"
PORT=8787
while [ $# -gt 0 ]; do
  case "$1" in
    --render-dir) RENDER_DIR="$2"; shift 2 ;;
    --fixtures) FIXTURES="$2"; shift 2 ;;
    --port) PORT="$2"; shift 2 ;;
    *) echo "unknown arg $1" >&2; exit 2 ;;
  esac
done

if command -v deno >/dev/null 2>&1; then DENO=(deno); else DENO=(npx --yes deno@2.6.4); fi
echo "deno: $("${DENO[@]}" --version | head -1)"

# 1. fixtures
if [ -n "$RENDER_DIR" ]; then
  FIXTURES="${FIXTURES:-$(mktemp -d)/scan-worker-fixtures}"
  mkdir -p "$FIXTURES"
  cp "$RENDER_DIR"/map/tripo-out/*/model.glb "$FIXTURES/raw_twin.glb"
  cp "$RENDER_DIR"/hero/tripo-out/*/model.glb "$FIXTURES/raw_hero.glb"
  python3 "$ROOT/tools/glb-pipeline/scan_finish.py" "$FIXTURES/raw_twin.glb" "$FIXTURES/ref_twin.glb" >/dev/null
  python3 "$ROOT/tools/glb-pipeline/scan_finish.py" "$FIXTURES/raw_hero.glb" "$FIXTURES/ref_hero.glb" >/dev/null
fi
if [ -z "$FIXTURES" ] || [ ! -f "$FIXTURES/raw_twin.glb" ]; then
  echo "need fixtures: pass --render-dir <manual tripo render dir> or --fixtures <dir with raw_twin.glb raw_hero.glb>" >&2
  exit 2
fi
export GLB_FIXTURES_DIR="$FIXTURES"
echo "fixtures: $FIXTURES"; ls -l "$FIXTURES"

# 2. static + unit
( cd "$FN" && "${DENO[@]}" check index.ts dryrun.ts && "${DENO[@]}" lint && "${DENO[@]}" test --allow-read --allow-env --allow-net )

# 3. stub
python3 -m py_compile "$STUB"
python3 "$STUB" --port "$PORT" --fixtures "$FIXTURES" --polls 2 > "$FIXTURES/stub.log" 2>&1 &
STUB_PID=$!
trap 'kill $STUB_PID 2>/dev/null || true' EXIT
sleep 1
curl -s "http://127.0.0.1:$PORT/v3/account/balance" >/dev/null || { echo "stub did not start"; cat "$FIXTURES/stub.log"; exit 1; }

# 4. dry run
export TRIPO_BASE_URL="http://127.0.0.1:$PORT"
export FETCH_SCAN_ANON="$(grep -oE '"eyJ[A-Za-z0-9._-]+"' "$ROOT/src/supabase.ts" | head -1 | tr -d '"' || true)"
if [ -f "$HOME/.hairpin/publish-model.key" ]; then export HAIRPIN_PUBLISH_KEY="$(cat "$HOME/.hairpin/publish-model.key")"; fi
( cd "$FN" && "${DENO[@]}" run --allow-read --allow-env --allow-net dryrun.ts )
RC=$?

echo
echo "═══ stub request log (every Tripo payload the worker sent) ═══"
cat "$FIXTURES/stub.log"
exit $RC
