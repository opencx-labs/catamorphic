#!/bin/zsh
# One continuous take: viewport → record → scenes → stop. Logs to take.log.
cd "$(dirname "$0")"
: "${CDP_PORT:?set CDP_PORT to the desktop's debugging port}"
rm -rf raw && mkdir -p raw && rm -f markers.jsonl start.json
node film.mjs viewport
sleep 1.5
bun capture.mjs > capture.log 2>&1 &
CAP=$!
sleep 4
node film.mjs browser
sleep 1.5
node film.mjs chat1
sleep 2
node film.mjs theme
sleep 2
node film.mjs chat2
sleep 2
node film.mjs app
sleep 6
node mark.mjs "final hold end"
kill -INT $CAP
wait $CAP
node film.mjs reset
echo TAKE-DONE
