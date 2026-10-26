from pathlib import Path
import os

p = Path('apps/desktop/e2e/project-dock-scope.e2e.ts')
s = p.read_text()
variant = os.environ['DIAG_VARIANT']
assert variant in ('control', 'listener', 'geometry')
s = 'import { execFileSync } from "node:child_process";\nimport fs from "node:fs";\n' + s
if variant == 'listener':
    s = s.replace('  await focusWindow(app);', '''  await focusWindow(app);
  await app.eval(`(() => {
    window.__pointerTrace=[];
    window.addEventListener('pointermove', e=>{
      window.__pointerTrace.push({x:e.clientX,y:e.clientY,trusted:e.isTrusted,buttons:e.buttons,target:e.target?.tagName});
      if(window.__pointerTrace.length>12)window.__pointerTrace.shift();
    },true);
    return true;
  })()`);''')
if variant == 'geometry':
    s = s.replace('  await app.movePointer(point);', '''  await app.movePointer(point);
  await app.eval(`document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect().toJSON()`);''')
s = s.replace('  await app?.stop();', '''  if(app) console.log('FINAL_HOVER_DIAGNOSTIC',JSON.stringify(await app.eval(`(async () => {
    const node=document.querySelector('section:not([inert]) [data-testid="chat-fork"]');
    const r=node?.getBoundingClientRect();
    const ancestors=[];
    for(let n=node;n;n=n.parentElement){
      const style=getComputedStyle(n);
      ancestors.push({tag:n.tagName,cls:n.className,hover:n.matches(':hover'),opacity:style.opacity,visibility:style.visibility,pointerEvents:style.pointerEvents});
    }
    return {rect:r?.toJSON(),hit:r&&document.elementFromPoint(r.x+r.width/2,r.y+r.height/2)?.outerHTML.slice(0,200),pointer:window.__pointerTrace,hover:matchMedia('(hover:hover)').matches,documentFocus:document.hasFocus(),window:await window.catamorphicDesktop.devWindow('get'),ancestors};
  })()`).catch(e=>String(e))));
  try {
    console.log('NATIVE_WINDOW_INVENTORY',execFileSync('python3',['../../.github/native-window-state.py'],{encoding:'utf8'}));
    execFileSync('screencapture',['-x','/tmp/fork-hover-display.png']);
    fs.writeFileSync('/tmp/fork-privacy.log',execFileSync('log',['show','--style','compact','--last','10m','--predicate','eventMessage CONTAINS[c] "local network" OR eventMessage CONTAINS[c] "hosted-compute"'],{encoding:'utf8',maxBuffer:20*1024*1024}));
  } catch(e) { console.log('NATIVE_CAPTURE_ERROR',String(e)); }
  await app?.stop();''')
p.write_text(s)
# Preserve the original size-based ordering of the fresh Vitest shard.
previous = Path('apps/desktop/e2e/chat-trusted-hosts.e2e.ts')
previous.write_text(previous.read_text() + '\n/* Diagnostic ordering only. ' + ' ' * 6000 + ' */\n')

dock = Path('apps/desktop/src/renderer/components/dock-host.tsx')
text = dock.read_text()
old = '''  useEffect(
    () => localPresentations.acknowledge(remoteSnapshot.activeChatId),
    [remoteSnapshot.activeChatId],
  );'''
new = '''  useEffect(() => {
    // Main can confirm the activation before the local opening publishes.
    if (local.pendingActivation)
      localPresentations.acknowledge(remoteSnapshot.activeChatId);
  }, [remoteSnapshot.activeChatId, local.pendingActivation]);'''
assert text.count(old) == 1
dock.write_text(text.replace(old, new))

# The fork leaves its floating parent in the dock, as a new chat does.
app = Path('apps/desktop/src/renderer/app.tsx')
text = app.read_text()
old = '              chats: [...ws.chats, entry],'
new = """              chats: [
                ...ws.chats.map((chat) =>
                  chat.mode === "partial"
                    ? { ...chat, mode: "min" as const }
                    : chat,
                ),
                entry,
              ],"""
assert text.count(old) == 1
app.write_text(text.replace(old, new))
test = Path('apps/desktop/e2e/project-dock-scope.e2e.ts')
text = test.read_text()
anchor = '  await click(`${front(fork)} button[aria-label="Minimize chat to bubble"]`);'
assert text.count(anchor) == 1
text = text.replace(anchor, """  await app.waitFor(
    `window.catamorphicDesktop.dockSnapshot().then(s=>s.chats.some(c=>c.entry.localId===${JSON.stringify(original)}&&c.entry.mode==='min'))`,
    { label: "fork leaves its floating parent in the dock" },
  );
  await app.waitFor(
    `!document.querySelector(${JSON.stringify(front(original))})`,
  );
""" + anchor)
old = """  await click(
    `${front(original)} button[aria-label="Minimize chat to bubble"]`,
  );
  await app.waitFor(
    `window.catamorphicDesktop.dockSnapshot().then(s=>s.chats.some(c=>c.entry.localId===${JSON.stringify(original)}&&c.entry.mode==='min'))`,
    { label: "parent minimized" },
  );
"""
assert text.count(old) == 1
test.write_text(text.replace(old, ''))
