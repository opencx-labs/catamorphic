#!/bin/zsh
# Copies the rendered film into the website worktree and bumps every ?v= hash.
set -e
cd "$(dirname "$0")"
SITE=${1:?website checkout}
cp work-desktop-film.mp4 work-desktop-film.vtt work-desktop-poster.jpg "$SITE/site/assets/"
HASH=$(md5 -q work-desktop-film.mp4 | cut -c1-8)
W=$(ffprobe -v error -select_streams v:0 -show_entries stream=width -of csv=p=0 work-desktop-film.mp4)
H=$(ffprobe -v error -select_streams v:0 -show_entries stream=height -of csv=p=0 work-desktop-film.mp4)
python3 - "$SITE/site/index.html" "$HASH" "$W" "$H" <<'PY'
import re, sys
path, h, w, ht = sys.argv[1:]
s = open(path).read()
s = re.sub(r'(work-desktop-(?:film\.mp4|film\.vtt|poster\.jpg))\?v=[0-9a-f]{8}', rf'\1?v={h}', s)
s = re.sub(r'(<video[^>]*?\n\s*)width="\d+"(\s*\n\s*)height="\d+"', rf'\1width="{w}"\2height="{ht}"', s, count=1)
open(path, 'w').write(s)
PY
grep -n "v=$HASH\|width=\|height=" "$SITE/site/index.html" | head
(cd "$SITE" && python3 scripts/check_site.py && node --check site/site.js && ffmpeg -v error -xerror -i site/assets/work-desktop-film.mp4 -f null - && echo SITE-OK)
