#!/bin/zsh
# The Garage Showroom stills (2026-09-22): the map's own GLBs rendered headless with model-viewer 4.0 on
# magenta, then keyed + given the class-sprite paint layers by build_stills.py. Output → assets/images/garage/.
#   tools/garage-stills/render.sh        (needs Google Chrome; downloads the GLBs into a temp dir)
# Angles: the 2D arrow straight down (0° 90°), the 3D arrow from the chase cam — behind and above at the
# map's 48° pitch (0° 138°: the arrow GLB lies in X/Y, nose +Y, top +Z). (Class-car stills: see build_stills.py.)
set -e
HERE=${0:A:h}; FE=${HERE:h:h}; W=$(mktemp -d); OUT=$W/hi; mkdir -p $OUT
cp $HERE/view.html $W/ && cp $FE/assets/models/green-arrow-v10.glb $W/arrow.glb
(cd $W && python3 -m http.server 8779 >/dev/null 2>&1) & SRV=$!; sleep 1
CH="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
r() { "$CH" --headless=new --use-angle=swiftshader --enable-unsafe-swiftshader --force-device-scale-factor=4 --window-size=900,560 \
  --virtual-time-budget=60000 --hide-scrollbars --user-data-dir=$W/prof-$1 --screenshot=$OUT/$1.png \
  "http://localhost:8779/view.html?src=$2&orbit=$3" >/dev/null 2>&1 || true; }
r arrow-top arrow.glb "0deg%2090deg%20auto"; r arrow-chase arrow.glb "0deg%20138deg%20auto"
kill $SRV
python3 $HERE/build_stills.py $OUT $FE/assets/images/garage
python3 $HERE/preview.py $FE/assets/images/garage $W/preview.png && echo "preview: $W/preview.png"
