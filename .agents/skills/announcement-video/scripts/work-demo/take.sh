#!/bin/zsh
# One continuous take: record, then open → belem → light → workflow → app → use.
cd "$(dirname "$0")"
: "${CDP_PORT:?set CDP_PORT}"
NAME=${1:-main}
rm -rf raw-$NAME && rm -f markers.jsonl start.json pointer.jsonl sparse.flag
node scenes.mjs prep || exit 1
RAW=raw-$NAME QUALITY=88 node capture.mjs > capture-$NAME.log 2>&1 &
CAP=$!
sleep 3
node scenes.mjs open && node scenes.mjs belem && node scenes.mjs light && node scenes.mjs workflow && node scenes.mjs app && node scenes.mjs use
STATUS=$?
kill -INT $CAP
wait $CAP
rm -f sparse.flag
cp markers.jsonl markers-$NAME.jsonl; cp pointer.jsonl pointer-$NAME.jsonl
echo TAKE-DONE $STATUS
