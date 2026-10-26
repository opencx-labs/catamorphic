from pathlib import Path

p = Path('apps/desktop/e2e/project-dock-scope.e2e.ts')
s = p.read_text()
s = 'import { execFileSync } from "node:child_process";\nimport fs from "node:fs";\n' + s
s = s.replace('  await app.movePointer(point);', '''  await app.eval(`(() => {
    window.__clickTarget=${JSON.stringify(selector)};
    window.__pointerTrace ??= [];
    if(!window.__pointerTracing){
      window.__pointerTracing=true;
      window.addEventListener('pointermove', e=>{
        window.__pointerTrace.push({x:e.clientX,y:e.clientY,trusted:e.isTrusted,buttons:e.buttons,target:e.target?.tagName});
        if(window.__pointerTrace.length>12)window.__pointerTrace.shift();
      },true);
    }
    return true;
  })()`);
  console.log('NATIVE_POINTER_TARGET',selector,point);
  await app.movePointer(point);
  console.log('AFTER_NATIVE_MOVE',selector,JSON.stringify(await app.eval(`(() => {
    const node=document.querySelector(window.__clickTarget);
    const r=node?.getBoundingClientRect();
    const hidden=[];
    for(let n=node;n;n=n.parentElement)
      if(getComputedStyle(n).opacity!=='1')hidden.push({tag:n.tagName,cls:n.className,opacity:getComputedStyle(n).opacity,hover:n.matches(':hover')});
    return {rect:r?.toJSON(),hidden,hover:node?.matches(':hover'),pointer:window.__pointerTrace,documentFocus:document.hasFocus()};
  })()`)));''')
s = s.replace('  await app?.stop();', '''  if(app) console.log('FINAL_HOVER_DIAGNOSTIC',JSON.stringify(await app.eval(`(async () => {
    const node=document.querySelector(window.__clickTarget);
    const r=node?.getBoundingClientRect();
    const ancestors=[];
    for(let n=node;n;n=n.parentElement){
      const style=getComputedStyle(n);
      ancestors.push({tag:n.tagName,cls:n.className,hover:n.matches(':hover'),opacity:style.opacity,visibility:style.visibility,pointerEvents:style.pointerEvents,animations:n.getAnimations().map(a=>({state:a.playState,timing:a.effect?.getTiming()}))});
    }
    return {selector:window.__clickTarget,rect:r?.toJSON(),hit:r&&document.elementFromPoint(r.x+r.width/2,r.y+r.height/2)?.outerHTML.slice(0,200),pointer:window.__pointerTrace,hover:matchMedia('(hover:hover)').matches,anyHover:matchMedia('(any-hover:hover)').matches,fine:matchMedia('(pointer:fine)').matches,coarse:matchMedia('(pointer:coarse)').matches,documentFocus:document.hasFocus(),window:await window.catamorphicDesktop.devWindow('get'),ancestors};
  })()`).catch(e=>String(e))));
  try {
    console.log('NATIVE_WINDOW_INVENTORY',execFileSync('python3',['../../.github/native-window-state.py'],{encoding:'utf8'}));
    execFileSync('screencapture',['-x','/tmp/fork-hover-display.png']);
  } catch(e) { console.log('NATIVE_CAPTURE_ERROR',String(e)); }
  try {
    fs.writeFileSync('/tmp/fork-privacy.log',execFileSync('log',['show','--style','compact','--last','10m','--predicate','eventMessage CONTAINS[c] "local network" OR eventMessage CONTAINS[c] "hosted-compute"'],{encoding:'utf8',maxBuffer:20*1024*1024}));
    fs.writeFileSync('/tmp/fork-processes.log',execFileSync('ps',['-axo','pid,ppid,comm'],{encoding:'utf8'}));
  } catch(e) { console.log('PRIVACY_LOG_ERROR',String(e)); }
  await app?.stop();''')
p.write_text(s)

# Vitest sorts fresh files by size. Keep the original preceding suite ahead
# of this instrumented file so the diagnostic reproduces the hosted order.
previous = Path('apps/desktop/e2e/chat-trusted-hosts.e2e.ts')
previous.write_text(previous.read_text() + '\n/* Diagnostic ordering only. ' + ' ' * 6000 + ' */\n')
