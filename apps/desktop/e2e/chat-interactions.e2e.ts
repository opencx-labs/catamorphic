import { afterAll, beforeAll, expect, it } from "vitest";
import { type AppHandle, launchApp } from "./harness.js";

let app: AppHandle;
const dock = "document.querySelector('[data-chat-local-id]:not([inert])')";
const input = `${dock}.querySelector('[data-composer-input]')`;

async function click(selector: string) {
  const point = await app.waitFor<{ x: number; y: number }>(`(() => {
    const e=document.querySelector(${JSON.stringify(selector)}); if(!e)return false;
    const r=e.getBoundingClientRect();return r.width&&r.height?{x:r.x+r.width/2,y:r.y+r.height/2}:false;
  })()`);
  await app.clickPointer(point);
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
  await app.insertText(
    "Review the example document and keep this composer steady while changing chat size.",
  );
});
afterAll(async () => {
  await app?.stop();
});

interface SizeFrame {
  width: number;
  inputWidth: number;
  inputHeight: number;
}
async function observeResize(action: () => Promise<void>) {
  await app.eval(`(() => {
    window.__chatSizeFrames=[];window.__chatSizeDone=false;
    const start=performance.now();
    requestAnimationFrame(function sample(t) {
      const s=${dock};const i=${input};
      if(s&&i){const r=s.getBoundingClientRect();const c=i.getBoundingClientRect();
        window.__chatSizeFrames.push({width:r.width,inputWidth:c.width,inputHeight:c.height});}
      if(t-start<700)requestAnimationFrame(sample);else window.__chatSizeDone=true;
    });return true;
  })()`);
  await action();
  await app.waitFor("window.__chatSizeDone", {
    label: "chat resize frames captured",
  });
  const frames = await app.eval<SizeFrame[]>("window.__chatSizeFrames");
  expect(frames.length).toBeGreaterThan(2);
  expect(new Set(frames.map((f) => Math.round(f.width))).size).toBeGreaterThan(
    2,
  );
  for (const field of ["inputWidth", "inputHeight"] as const) {
    const ends = [frames[0]?.[field] ?? 0, frames.at(-1)?.[field] ?? 0];
    expect(
      Math.min(...frames.map((f) => f[field])),
      `${field} never undershoots its endpoints`,
    ).toBeGreaterThanOrEqual(Math.min(...ends) - 1);
    expect(
      Math.max(...frames.map((f) => f[field])),
      `${field} never overshoots its endpoints`,
    ).toBeLessThanOrEqual(Math.max(...ends) + 1);
  }
}

it("keeps the composer from narrowing and wrapping during maximize and float", async () => {
  await observeResize(() =>
    click('[data-floating-chat]:not([inert]) button[aria-label="Open as tab"]'),
  );
  await observeResize(() => app.press("Escape"));
});

it("focuses the composer from the empty sides without taking text selection", async () => {
  await click(
    '[data-floating-chat]:not([inert]) button[aria-label="Open as tab"]',
  );
  await app.waitFor(
    `!${dock}.getAnimations().some(a=>a.playState==='running')`,
  );
  for (const side of ["left", "right"]) {
    const at = await app.eval<{ x: number; y: number }>(`(() => {
      const r=${dock}.getBoundingClientRect();${input}.blur();
      return {x:${JSON.stringify(side)}==='left'?r.left+5:r.right-5,y:r.top+r.height/2};
    })()`);
    await app.clickPointer(at);
    await app.waitFor(`document.activeElement===${input}`, {
      label: `${side} gutter focuses composer`,
    });
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
  await observeResize(() => app.press("Escape"));
  await observeResize(() =>
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
