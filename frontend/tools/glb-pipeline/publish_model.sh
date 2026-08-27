#!/bin/bash
# publish_model.sh — push a finished car GLB into the public `models` bucket.
#
# THE ONE DOOR (Jeff, 2026-08-28: "we need to find a way to get it into the bucket
# cause how are users cars gonne hit the bucket?"): uploads go through the
# `publish-model` Supabase edge function, which holds the service role server-side.
# Nothing else can write to `models` — anon has no INSERT there, on purpose.
#
# AUTH: the secret lives in ~/.hairpin/publish-model.key (this machine only, never
# in git). Rotation = `openssl rand -hex 32 > ~/.hairpin/publish-model.key` + paste
# the new value into the function and redeploy.
#
# RULES (enforced SERVER-side; listed here so failures make sense):
#   .glb only, <= 30 MB, GLB magic checked, name = [A-Za-z0-9._-]+
#   409 = the name already exists. That is a FEATURE: Mapbox caches models by
#   URL/id, so a re-bake must ship under a NEW filename + a model-id generation
#   bump in vehicleAssets — overwriting live bytes strands devices on the cache.
#
# Usage: ./publish_model.sh /path/to/car.glb [remote-name.glb]
set -euo pipefail

FILE="${1:?usage: publish_model.sh <file.glb> [remote-name.glb]}"
NAME="${2:-$(basename "$FILE")}"
KEYFILE="$HOME/.hairpin/publish-model.key"
FN_URL="https://pgtbjiszjglznjagolse.supabase.co/functions/v1/publish-model"
# The shipped client anon key (public by design; RLS-gated). Read from the app
# source so this script never carries its own copy.
ANON=$(grep -oE '"eyJ[A-Za-z0-9._-]+"' "$(dirname "$0")/../../src/supabase.ts" | head -1 | tr -d '"')

[ -f "$FILE" ] || { echo "no such file: $FILE" >&2; exit 1; }
[ -f "$KEYFILE" ] || { echo "missing $KEYFILE — generate with: openssl rand -hex 32 > $KEYFILE" >&2; exit 1; }
[ -n "$ANON" ] || { echo "could not read the anon key from src/supabase.ts" >&2; exit 1; }

echo "publishing $(basename "$FILE") ($(stat -f%z "$FILE") B) as $NAME ..."
RESP=$(curl -s -m 180 -X POST "$FN_URL?name=$NAME" \
  -H "Authorization: Bearer $ANON" \
  -H "x-publish-key: $(cat "$KEYFILE")" \
  -H "Content-Type: application/octet-stream" -H "Expect:" \
  --data-binary @"$FILE")
echo "$RESP"

# verify the round trip byte-for-byte — an upload is not published until the
# public URL serves the same bytes back.
URL="https://pgtbjiszjglznjagolse.supabase.co/storage/v1/object/public/models/$NAME"
TMP=$(mktemp)
curl -s -m 120 -o "$TMP" "$URL"
if [ "$(md5 -q "$FILE")" = "$(md5 -q "$TMP")" ]; then
  echo "✅ live + byte-identical: $URL"
else
  echo "❌ round-trip mismatch — do NOT ship this URL" >&2; rm -f "$TMP"; exit 1
fi
rm -f "$TMP"
