#!/bin/zsh
# The browser scene alone, for splicing over the main take's opening:
# viewport → record → browser → hold → stop. Logs to take-browser.log.
cd "$(dirname "$0")"
: "${CDP_PORT:?set CDP_PORT to the desktop's debugging port}"
rm -rf raw && mkdir -p raw && rm -f markers.jsonl start.json
node film.mjs viewport
sleep 1.5
# The desktop keeps rendering while covered when it runs with a debugging
# port (main/index.ts); still refuse to film a feed that delivers nothing.
bun capture.mjs > capture.log 2>&1 &
CAP=$!
sleep 4
if [ "$(ls raw | wc -l | tr -d ' ')" -lt 3 ]; then
  echo "SCREENCAST-STALLED: $(ls raw | wc -l) frames in 4s (is the window covered?)"
  kill -INT $CAP; sleep 2; kill -9 $CAP 2>/dev/null; exit 1
fi
node film.mjs browser
sleep 3
node mark.mjs "browser hold end"
kill -INT $CAP
wait $CAP
node film.mjs reset
rm -rf raw-browser && mv raw raw-browser && mv markers.jsonl markers-browser.jsonl && mv start.json start-browser.json
echo TAKE-DONE
