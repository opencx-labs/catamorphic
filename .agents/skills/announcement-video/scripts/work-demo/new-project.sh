#!/bin/zsh
# Creates a fresh demo project from demo/ and records its id and folder.
cd "$(dirname "$0")"
: "${CDP_PORT:?}"
SLUG=${1:?slug}
NAME=${PROJECT_NAME:-Lisbon offsite}
OUT=$(node poke.mjs "const dir = await evaluate('window.catamorphicDesktop.defaultProjectsDir()'); const p = await evaluate('window.catamorphicDesktop.createProject({ name: ' + JSON.stringify('$NAME') + ', rootPath: ' + JSON.stringify(dir + '/$SLUG') + ' })'); return { id: p.id, root: dir + '/$SLUG' };")
ID=$(echo "$OUT" | python3 -c "import json,sys; print(json.load(sys.stdin)['id'])")
ROOT=$(echo "$OUT" | python3 -c "import json,sys; print(json.load(sys.stdin)['root'])")
cp -R demo/. "$ROOT/"
printf '[install.scopes]\n"@catamorphic" = "http://%s:4873"\n' "$(ipconfig getifaddr en0)" > "$ROOT/.work/bunfig.toml"
git -C "$ROOT" add -A
git -C "$ROOT" -c user.name="Sam Okafor" -c user.email="sam@example.com" commit -qm "Offsite plan, team and budget"
echo "$ID $ROOT" | tee project.txt
