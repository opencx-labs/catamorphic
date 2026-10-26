from pathlib import Path

p = Path('apps/desktop/e2e/project-dock-scope.e2e.ts')
s = p.read_text()
s = s.replace('  await app.movePointer(point);', '''  await app.eval(`(() => {
    window.__clickTarget=${JSON.stringify(selector)};
    window.__pointerTrace ??= [];
    if(!window.__pointerTracing){
      window.__pointerTracing=true;
      window.addEventListener('pointermove', e=>{
        window.__pointerTrace.push({x:e.clientX,y:e.clientY,trusted:e.isTrusted,target:e.target?.tagName});
        if(window.__pointerTrace.length>12)window.__pointerTrace.shift();
      },true);
    }
    return true;
  })()`);
  console.log('NATIVE_POINTER_TARGET',selector,point);
  await app.movePointer(point);''')
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
  await app?.stop();''')
p.write_text(s)
