#!/bin/zsh
# A fresh set for a take: unlink the last demo project, create a new one from
# demo/, switch the window to it, add its bookmark, seed real chats, prep.
cd "$(dirname "$0")"
: "${CDP_PORT:?}"
SLUG=${1:?slug, e.g. lisbon-3}
rm -f start.json
OLD=$(cut -d' ' -f1 project.txt 2>/dev/null)
./new-project.sh "$SLUG" || exit 1
NEW=$(cut -d' ' -f1 project.txt)
cat > pokes-switch.js <<JS
if ("$OLD") await evaluate('window.catamorphicDesktop.deleteProject({ projectId: "$OLD" }).then(() => true, (e) => String(e))');
await evaluate('location.reload()');
await pause(4500);
await clickEl('document.querySelector("button[aria-haspopup=listbox]")', 'switcher');
await pause(700);
await clickEl('[...document.querySelectorAll("[role=option]")].find(o => o.textContent === "Lisbon offsite")', 'project');
await pause(2000);
const profileId = await evaluate('window.catamorphicDesktop.profilesList().then(p => p.lastActiveProfileId ?? p.defaultProfileId)');
await evaluate('window.catamorphicDesktop.bookmarksAdd(' + JSON.stringify({ projectId: "$NEW", profileId: "PROFILE", label: "Lisbon guide", url: "https://en.wikivoyage.org/wiki/Lisbon", faviconUrl: "https://en.wikivoyage.org/static/favicon/wikivoyage.ico" }).replace('"PROFILE"', JSON.stringify(profileId)) + ')');
return profileId;
JS
node poke.mjs pokes-switch.js
# Film on Work Dark: the profile theme is a file, and the take asks to change it.
DESKTOP_DATA=${DESKTOP_DATA:-~/.catamorphic/dev/work-film/desktop}
PROFILE_DIR=$(ls -d "$DESKTOP_DATA"/profiles/*/ | head -1)
printf '{"selection":"dark"}' > "$PROFILE_DIR/theme.json"
node scenes.mjs seed || exit 1
node close-bubbles.mjs
# The seed turns opened their own files; the palette should not offer them.
node poke.mjs "await evaluate(\"window.catamorphicDesktop.historyClear()\")"
node scenes.mjs prep
