import { afterAll, beforeAll, expect, it } from "vitest";
import { type AppHandle, focusWindow, launchApp } from "./harness.js";

let app: AppHandle;
const dock = "document.querySelector('[data-chat-local-id]:not([inert])')";
const input = `${dock}.querySelector('[data-composer-input]')`;
const draftText =
  "Review the example document and keep this composer steady while changing chat size.";

async function click(selector: string) {
  const point = await app.waitFor<{ x: number; y: number }>(`(() => {
    const e=document.querySelector(${JSON.stringify(selector)}); if(!e)return false;
    const r=e.getBoundingClientRect();return r.width&&r.height?{x:r.x+r.width/2,y:r.y+r.height/2}:false;
  })()`);
  await app.clickPointer(point);
}

/** Select the fixture text without depending on platform menu shortcuts. */
async function selectComposerContents() {
  await app.eval(`(() => {
    const editor = ${input}; editor.focus();
    const range = document.createRange(); range.selectNodeContents(editor);
    const selection = getSelection();
    selection.removeAllRanges(); selection.addRange(range);
  })()`);
  await app.waitFor(`document.activeElement === ${input}
    && !getSelection().isCollapsed
    && ${input}.contains(getSelection().anchorNode)`);
}

beforeAll(async () => {
  app = await launchApp();
  await app.eval(
    `window.catamorphicDesktop.createProject({name:'Chat interactions',rootPath:${JSON.stringify("/tmp/chat-interactions-project")}})`,
  );
  await app.reload();
  await app.waitFor("!!document.querySelector('[data-workspace-ready]')");
  await click('[data-dock-rail] button[aria-label="New chat"]');
  await app.waitFor(`!!${input}`);
  await click("[data-floating-chat]:not([inert]) [data-composer-input]");
  await app.insertText("Hello layout");
  await app.press("Enter");
  await app.waitFor(`${dock}.textContent.includes('You said: Hello layout')`);
  await app.waitFor(`!${dock}.querySelector('[aria-label="Stop the agent"]')`);
  await click("[data-floating-chat]:not([inert]) [data-composer-input]");
  await app.insertText(draftText);
});
afterAll(async () => {
  await app?.stop();
});

interface SizeFrame {
  time: number;
  width: number;
  inputWidth: number;
  inputHeight: number;
}
async function observeResize(tab: boolean, action: () => Promise<void>) {
  await app.waitFor(
    `${dock}.parentElement.getAnimations({subtree:true}).every(a=>
      a.playState!=='running' || a.effect?.getTiming().iterations===Infinity)`,
    { label: "chat is at rest before resizing" },
  );
  await app.eval(`(() => {
    window.__chatSizeFrames=[];
    window.__sampleChatSize=(time)=>{
      const s=${dock};const i=${input};
      if(s&&i){const r=s.getBoundingClientRect();const c=i.getBoundingClientRect();
        window.__chatSizeFrames.push({time,width:r.width,inputWidth:c.width,inputHeight:c.height});}
    };
    window.__sampleChatSize(-1);return true;
  })()`);
  // Sample the actual CSS transitions at explicit times. A busy renderer can
  // skip every intermediate real-time RAF during the 250 ms resize.
  await app.cdp("Animation.enable");
  await app.cdp("Animation.setPlaybackRate", { playbackRate: 0 });
  try {
    await action();
    await app.waitFor(
      `(() => {
      const chat=${dock};
      return (chat.dataset.chatTab==='true')===${tab}
        && chat.getAnimations().some(a=>a instanceof CSSTransition
          && a.transitionProperty==='max-width');
    })()`,
      { label: `chat ${tab ? "tab" : "floating"} pose has a width transition` },
    );
    await app.eval(`(async () => {
      const nextFrame=()=>new Promise(requestAnimationFrame);
      const moving=${dock}.parentElement.getAnimations({subtree:true})
        .filter(a=>a.effect?.getTiming().iterations!==Infinity);
      // Include the parent padding transition as well as the card and
      // composer, keeping their timelines aligned. Preserve the pre-action
      // sample and t=0 so an instantaneous layout jump still fails.
      for(const time of [0,1,25,50,75,100,125,150,175,200,225,250,300]) {
        for(const animation of moving)animation.currentTime=time;
        await nextFrame();window.__sampleChatSize(time);
      }
      for(const animation of moving)animation.finish();
      await nextFrame();await nextFrame();window.__sampleChatSize(320);
      return true;
    })()`);
  } finally {
    await app.cdp("Animation.setPlaybackRate", { playbackRate: 1 });
    await app.cdp("Animation.disable");
    await app.eval("delete window.__sampleChatSize;true");
  }
  const frames = await app.eval<SizeFrame[]>("window.__chatSizeFrames");
  const detail = JSON.stringify(frames);
  expect(frames.length, detail).toBeGreaterThan(2);
  expect(
    new Set(frames.map((f) => Math.round(f.width))).size,
    detail,
  ).toBeGreaterThan(2);
  for (const field of ["inputWidth", "inputHeight"] as const) {
    const ends = [frames[0]?.[field] ?? 0, frames.at(-1)?.[field] ?? 0];
    expect(
      Math.min(...frames.map((f) => f[field])),
      `${field} never undershoots its endpoints: ${detail}`,
    ).toBeGreaterThanOrEqual(Math.min(...ends) - 1);
    expect(
      Math.max(...frames.map((f) => f[field])),
      `${field} never overshoots its endpoints: ${detail}`,
    ).toBeLessThanOrEqual(Math.max(...ends) + 1);
  }
}

it("inserts a line break with Shift+keypad Enter without sending", async () => {
  await focusWindow(app);
  await click("[data-floating-chat]:not([inert]) [data-composer-input]");
  await selectComposerContents();
  await app.insertText("First line");
  await app.cdp("Input.dispatchKeyEvent", {
    type: "keyDown",
    key: "Enter",
    code: "NumpadEnter",
    location: 3,
    windowsVirtualKeyCode: 13,
    modifiers: 8,
  });
  await app.cdp("Input.dispatchKeyEvent", {
    type: "keyUp",
    key: "Enter",
    code: "NumpadEnter",
    location: 3,
    windowsVirtualKeyCode: 13,
    modifiers: 8,
  });
  await app.insertText("Second line");
  expect(await app.eval(`${input}.innerText`)).toBe("First line\nSecond line");
  expect(
    await app.eval(`${dock}.querySelector('[role="log"]').textContent`),
  ).not.toContain("You said: First line");
  // The later resize checks retain the suite's shared draft.
  await selectComposerContents();
  await app.insertText(draftText);
});

it("keeps the composer from narrowing and wrapping during maximize and float", async () => {
  for (const width of [1280, 1024]) {
    await app.eval(
      `window.catamorphicDesktop.devWindow('setSize',${width},730)`,
    );
    await app.waitFor(`innerWidth===${width}`);
    await observeResize(true, () =>
      click(
        '[data-floating-chat]:not([inert]) button[aria-label="Open as tab"]',
      ),
    );
    await observeResize(false, () => app.press("Escape"));
  }
});

it("focuses the composer from the empty sides without taking text selection", async () => {
  await app.eval("window.catamorphicDesktop.devWindow('setSize',1024,730)");
  await app.waitFor("innerWidth===1024");
  await click(
    '[data-floating-chat]:not([inert]) button[aria-label="Open as tab"]',
  );
  await app.waitFor(
    `!${dock}.getAnimations().some(a=>a.playState==='running')`,
  );
  await focusWindow(app);
  for (const side of ["left", "right"]) {
    // Exercise the empty gutter, clear of pane dividers, native resize
    // bands and the scrollbar at the very edge.
    const at = await app.eval<{
      x: number;
      y: number;
      inChat: boolean;
    }>(`(() => {
      const r=${dock}.getBoundingClientRect();${input}.blur();
      window.__gutterClick=null;
      window.addEventListener('click',event=>{
        window.__gutterClick={meta:event.metaKey,ctrl:event.ctrlKey,
          alt:event.altKey,shift:event.shiftKey};
      },{once:true,capture:true});
      const x=${JSON.stringify(side)}==='left'?r.left+20:r.right-20;
      const y=r.top+r.height/2;
      return {x,y,inChat:${dock}.contains(document.elementFromPoint(x,y))};
    })()`);
    expect(at.inChat, `${side} gutter belongs to the chat`).toBe(true);
    await app.clickPointer(at);
    expect(
      await app.waitFor("window.__gutterClick", {
        label: "unmodified native click reaches the chat",
      }),
    ).toEqual({ meta: false, ctrl: false, alt: false, shift: false });
    try {
      await app.waitFor(`document.activeElement===${input}`, {
        label: `${side} gutter focuses composer`,
      });
    } catch (error) {
      const detail = await app.eval(`(() => {
        const hit=document.elementFromPoint(${at.x},${at.y});
        return {point:${JSON.stringify(at)},hasFocus:document.hasFocus(),
          activeTag:document.activeElement?.tagName,
          activeRole:document.activeElement?.getAttribute('role'),
          collapsed:getSelection()?.isCollapsed,hitTag:hit?.tagName,
          hitRole:hit?.getAttribute('role'),hitClass:hit?.className};
      })()`);
      throw new Error(`${side} gutter focus: ${JSON.stringify(detail)}`, {
        cause: error,
      });
    }
  }
  // A real drag selects the reply; the section's click must preserve it.
  const rect = await app.eval<{ x: number; y: number }>(`(() => {
    const p=[...${dock}.querySelectorAll('.cat-markdown p')].find(e=>e.textContent.includes('Hello layout'));
    const r=p.getBoundingClientRect();return {x:r.left+2,y:r.top+r.height/2};
  })()`);
  await app.cdp("Input.dispatchMouseEvent", {
    type: "mousePressed",
    ...rect,
    button: "left",
    clickCount: 1,
  });
  await app.cdp("Input.dispatchMouseEvent", {
    type: "mouseMoved",
    x: rect.x + 100,
    y: rect.y,
    button: "left",
    buttons: 1,
  });
  await app.cdp("Input.dispatchMouseEvent", {
    type: "mouseReleased",
    x: rect.x + 100,
    y: rect.y,
    button: "left",
    clickCount: 1,
  });
  expect(await app.eval("getSelection().toString().length")).toBeGreaterThan(0);
  expect(await app.eval(`document.activeElement===${input}`)).toBe(false);
});

it("keeps resize bounded in a narrow window and respects reduced motion", async () => {
  await app.eval("window.catamorphicDesktop.devWindow('setSize',760,850)");
  await app.waitFor("innerWidth<=760");
  await observeResize(false, () => app.press("Escape"));
  await observeResize(true, () =>
    click('[data-floating-chat]:not([inert]) button[aria-label="Open as tab"]'),
  );
  await app.cdp("Emulation.setEmulatedMedia", {
    features: [{ name: "prefers-reduced-motion", value: "reduce" }],
  });
  await app.press("Escape");
  await app.waitFor(
    `!!document.querySelector('[data-floating-chat]:not([inert])')`,
  );
  expect(
    await app.eval(`matchMedia('(prefers-reduced-motion: reduce)').matches`),
  ).toBe(true);
  expect(await app.eval(`${input}.textContent`)).toContain(
    "Review the example document",
  );
  await app.cdp("Emulation.setEmulatedMedia", { features: [] });
  await app.eval("window.catamorphicDesktop.devWindow('setSize',1200,850)");
});

it("does not lay out every retained message on the first navigation key", async () => {
  await app.eval(`(() => {
    getSelection().removeAllRanges();
    const s=${dock}.querySelector('[role="log"]').firstElementChild;
    const fragment=document.createDocumentFragment();
    for(let n=0;n<500;n++) {
      const row=document.createElement('div');row.className='cat-row';row.style.contentVisibility='auto';row.style.containIntrinsicSize='auto 400px';
      const m=document.createElement('div');m.dataset.userMessage='true';m.textContent='Retained message '+n;row.append(m);
      for(let j=0;j<15;j++){const p=document.createElement('p');p.textContent='Retained paragraph for first-use layout. '.repeat(5);row.append(p);}
      fragment.append(row);
    }
    s.firstElementChild.prepend(fragment);s.scrollTop=s.scrollHeight;
    window.__navigationReads=0;
    const original=HTMLElement.prototype.getBoundingClientRect;
    window.__restoreNavigationProbe=()=>{HTMLElement.prototype.getBoundingClientRect=original};
    HTMLElement.prototype.getBoundingClientRect=function(){
      if(this.hasAttribute('data-user-message')||this.classList.contains('cat-row'))window.__navigationReads++;
      return original.call(this);
    };
    ${input}.focus();return true;
  })()`);
  try {
    await app.press("PageUp");
    expect(await app.eval<number>("window.__navigationReads")).toBeGreaterThan(
      0,
    );
    expect(await app.eval<number>("window.__navigationReads")).toBeLessThan(25);
  } finally {
    await app.eval("window.__restoreNavigationProbe();true");
  }
  expect(app.getRendererErrors()).toEqual([]);
});
