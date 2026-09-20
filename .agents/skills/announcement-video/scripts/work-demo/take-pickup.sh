#!/bin/zsh
# Pickup take: continues from the main take's end state (see film.mjs pickup).
cd "$(dirname "$0")"
: "${CDP_PORT:?set CDP_PORT to the desktop's debugging port}"
rm -rf raw && mkdir -p raw && rm -f markers.jsonl start.json
node film.mjs viewport
sleep 1.5
bun capture.mjs > capture.log 2>&1 &
CAP=$!
sleep 3
node film.mjs pickup
sleep 1
kill -INT $CAP
wait $CAP
node film.mjs reset
echo PICKUP-DONE
