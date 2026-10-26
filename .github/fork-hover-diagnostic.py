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
