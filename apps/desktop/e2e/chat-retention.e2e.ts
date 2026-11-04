import path from "node:path";
import { afterAll, beforeAll, expect, it } from "vitest";
import { type AppHandle, focusWindow, launchApp } from "./harness.js";
import { CHATS_SECTION, writeSidebarSections } from "./sidebar-config.js";

let app: AppHandle;
let sessionId: string;
const front = "section[data-chat-local-id]:not([inert], [inert] *)";
const artifacts = process.env.CATAMORPHIC_E2E_ARTIFACTS_DIR ?? "/tmp";
beforeAll(async () => {
  app = await launchApp();
  await app.cdp("Page.addScriptToEvaluateOnNewDocument", {
    source: `window.__stepCommits=0;window.__REACT_DEVTOOLS_GLOBAL_HOOK__={supportsFiber:true,inject(){return 1},onCommitFiberRoot(){window.__stepCommits++},onCommitFiberUnmount(){}}`,
  });
  await app.reload();
  await writeSidebarSections(app, [CHATS_SECTION]);
  ({ sessionId } = await app.eval<{
    sessionId: string;
  }>(`(async()=>{
    const api=window.catamorphicDesktop;
    const project=await api.createProject({name:'Long chat fixture',rootPath:${JSON.stringify(path.join(artifacts, "retention-project"))}});
    const agent=await api.agentsCreate({name:'Fixture helper',harness:'ai-sdk'});
    await api.agentsSetDefault(agent.id);
    const {url}=await api.getServerState();
    const base=url+'/api/projects/'+project.id+'/agent/sessions';
    const created=await fetch(base,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({agentId:agent.id,title:'Long review',source:'desktop'})});
    const {id}=await created.json();
    const sent=await fetch(base+'/'+id+'/commands',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({type:'send',commandId:crypto.randomUUID(),text:'retained history fixture'})});
    if(!sent.ok)throw new Error(await sent.text());
    return {base,sessionId:id};
  })()`));
  await focusWindow(app);
  const row = `aside [data-session-id="${sessionId}"] [data-tree-primary]`;
  await app.waitFor(`!!document.querySelector(${JSON.stringify(row)})`);
  await app.eval(`document.querySelector(${JSON.stringify(row)}).click()`);
  await app.waitFor(
    `document.querySelector(${JSON.stringify(front)})?.textContent.includes('Finished reading the fixture documents.')`,
    { timeoutMs: 60_000, label: "long fixture settled" },
  );
}, 180_000);
afterAll(async () => {
  await app?.stop();
});

it("releases a large folded log and closed details while preserving choices and collapse motion", async () => {
  const count = (selector: string) =>
    app.eval<number>(
      `document.querySelector(${JSON.stringify(front)}).querySelectorAll(${JSON.stringify(selector)}).length`,
    );
  await app.waitFor(
    `document.querySelector(${JSON.stringify(front)})?.querySelector('[data-testid="chat-turn-steps-count"]')?.textContent==='500'`,
  );
  await app.waitFor(
    `document.querySelector(${JSON.stringify(front)}).querySelector('[data-testid="chat-turn-steps-toggle"]')?.getAttribute('aria-expanded')==='false' && !document.querySelector(${JSON.stringify(front)}).querySelector('[data-testid="chat-step"]')`,
    { label: "settled steps released after closing" },
  );
  expect(await count('[data-testid="chat-step"]')).toBe(0);
  const resting = await count("*");
  await app.eval(
    `document.querySelector(${JSON.stringify(front)}).querySelector('[data-testid="chat-turn-steps-toggle"]').focus()`,
  );
  await app.press("Enter");
  await app.waitFor(
    `document.querySelector(${JSON.stringify(front)}).querySelectorAll('[data-testid="chat-step"]').length>10`,
  );
  await app.eval(`(()=>{
    const list=document.querySelector(${JSON.stringify(front)}).querySelector('[data-testid="chat-step-window"]');
    let scroller=list.parentElement;
    while(scroller&&!/^(auto|scroll)$/.test(getComputedStyle(scroller).overflowY))scroller=scroller.parentElement;
    window.__stepScroller=scroller;
  })()`);
  await app.waitFor(
    `(()=>{const list=document.querySelector(${JSON.stringify(front)}).querySelector('[data-testid="chat-step-list"]');return list.getBoundingClientRect().height>10000&&!list.getAnimations().some(a=>a.playState==='running')})()`,
  );
  const followingPosition = await app.eval<number>(
    "window.__stepScroller.scrollTop",
  );
  if (followingPosition > 0) {
    await app.cdp("Input.dispatchMouseEvent", {
      type: "mouseWheel",
      x: 600,
      y: 300,
      deltaX: 0,
      deltaY: -240,
    });
    await app.waitFor(`window.__stepScroller.scrollTop<${followingPosition}-1`);
  }
  await app.eval(
    `(()=>{const list=document.querySelector(${JSON.stringify(front)}).querySelector('[data-testid="chat-step-window"]'),s=window.__stepScroller;s.scrollTop+=list.getBoundingClientRect().top-s.getBoundingClientRect().top;})()`,
  );
  await app.waitFor(
    `document.querySelector(${JSON.stringify(front)}).querySelector('[data-testid="chat-step"]')?.textContent.includes('document 0')`,
  );
  expect(await count('[data-testid="chat-step-detail"]')).toBe(0);
  const expanded = await count("*");
  expect(expanded).toBeLessThan(resting + 1_500);
  expect(await count('[data-testid="chat-step"]')).toBeLessThan(220);
  await app.eval(
    `document.querySelector(${JSON.stringify(front)}).querySelector('[data-testid="chat-step"] button').focus()`,
  );
  await app.press("Enter");
  await app.waitFor(
    `!!document.querySelector(${JSON.stringify(front)}).querySelector('[data-testid="chat-step-detail"]')`,
  );
  expect(await count('[data-testid="chat-step-detail"]')).toBe(1);
  await app.screenshot(path.join(artifacts, "retained-details-open.png"));
  // Start the close and seek its real transition in one task: slow native
  // runners need not happen to deliver a tool call inside its 200ms tween.
  const motion = await app.eval<{
    heights: number[];
    inert: boolean;
  }>(`(async()=>{
    const chat=document.querySelector(${JSON.stringify(front)});
    chat.querySelector('[data-testid="chat-turn-steps-toggle"]').click();
    await new Promise(requestAnimationFrame);
    const node=chat.querySelector('[data-testid="chat-step-list"]');
    const animation=node.getAnimations().find(a=>a instanceof CSSTransition&&a.transitionProperty==='grid-template-rows');
    if(!animation)throw new Error('The step list has no closing transition');
    const saved=animation.currentTime,duration=animation.effect.getComputedTiming().duration;
    const heights=[0,.2,.5,.8,.9995].map(f=>{animation.currentTime=duration*f;return node.getBoundingClientRect().height});
    animation.currentTime=saved;
    return {heights,inert:node.inert};
  })()`);
  expect(motion.inert).toBe(true);
  expect(motion.heights[0]).toBeGreaterThan(1_000);
  expect(motion.heights[2]).toBeGreaterThan(1);
  expect(motion.heights[2]).toBeLessThan(motion.heights[0] ?? 0);
  expect(motion.heights.at(-1)).toBeLessThan(2);
  await app.waitFor(
    `!document.querySelector(${JSON.stringify(front)}).querySelector('[data-testid="chat-step"]')`,
  );
  expect(await count("*")).toBeLessThan(resting + 10);
  await app.eval(
    `document.querySelector(${JSON.stringify(front)}).querySelector('[data-testid="chat-turn-steps-toggle"]').click()`,
  );
  await app.waitFor(
    `document.querySelector(${JSON.stringify(front)}).querySelector('[data-testid="chat-step-detail"]')?.textContent.includes('Document 0')`,
  );
  expect(await count('[data-testid="chat-step-detail"]')).toBe(1);
  await app.eval(
    `document.querySelector(${JSON.stringify(front)}).querySelector('[data-testid="chat-turn-steps-toggle"]').click()`,
  );
  await app.waitFor(
    `!document.querySelector(${JSON.stringify(front)}).querySelector('[data-testid="chat-step"]')`,
  );
  await app.screenshot(path.join(artifacts, "retained-history-folded.png"));
});

it("bounds scrolling headers and preserves details, selection and native Tab order across gaps", async () => {
  const chat = `document.querySelector(${JSON.stringify(front)})`;
  await app.eval(
    `${chat}.querySelector('[data-testid="chat-turn-steps-toggle"]').click()`,
  );
  await app.waitFor(
    `!!${chat}.querySelector('[data-testid="chat-step-window"]')`,
  );
  await app.eval(`(()=>{
    const list=${chat}.querySelector('[data-testid="chat-step-window"]');
    let scroller=list.parentElement;
    while(scroller&&!/^(auto|scroll)$/.test(getComputedStyle(scroller).overflowY))scroller=scroller.parentElement;
    window.__stepScroller=scroller;
  })()`);
  await app.waitFor(
    `(()=>{const list=${chat}.querySelector('[data-testid="chat-step-list"]');return list.getBoundingClientRect().height>10000&&!list.getAnimations().some(a=>a.playState==='running')})()`,
  );
  const position = await app.eval<number>("window.__stepScroller.scrollTop");
  if (position > 0) {
    await app.cdp("Input.dispatchMouseEvent", {
      type: "mouseWheel",
      x: 600,
      y: 300,
      deltaX: 0,
      deltaY: -240,
    });
    await app.waitFor(`window.__stepScroller.scrollTop<${position}-1`);
  }
  for (const fraction of [0, 0.25, 0.5, 0.9, 1, 0.5, 0]) {
    await app.eval(`(()=>{
      const list=${chat}.querySelector('[data-testid="chat-step-window"]'),s=window.__stepScroller;
      s.scrollTop+=list.getBoundingClientRect().top-s.getBoundingClientRect().top+list.getBoundingClientRect().height*${fraction};
    })()`);
    await app.waitFor(
      `(()=>{const view=window.__stepScroller.getBoundingClientRect();return [...${chat}.querySelectorAll('[data-step-key]')].filter(row=>{const rect=row.getBoundingClientRect();return rect.bottom>view.top&&rect.top<view.bottom}).length>=10})()`,
    );
    expect(
      await app.eval<number>(
        `${chat}.querySelectorAll('[data-testid="chat-step"]').length`,
      ),
    ).toBeLessThan(220);
  }
  // Keep a real open output and its inner scroll position while it is distant.
  await app.waitFor(
    `${chat}.querySelector('[data-testid="chat-step"]')?.textContent.includes('document 0')`,
  );
  await app.eval(
    `${chat}.querySelector('[data-testid="chat-step"] button').focus()`,
  );
  if (
    await app.eval(
      `${chat}.querySelector('[data-testid="chat-step"] button').getAttribute('aria-expanded')!=='true'`,
    )
  )
    await app.press("Enter");
  await app.waitFor(
    `!!${chat}.querySelector('[data-testid="chat-step-detail"]')`,
  );
  await app.eval(`(()=>{
    const detail=${chat}.querySelector('[data-testid="chat-step-detail"]');
    detail.scrollTop=160;window.__openStep=detail;window.__openScroll=detail.scrollTop;
    const range=document.createRange();range.selectNodeContents(detail);range.setEnd(detail.firstChild,20);
    const selection=document.getSelection();selection.removeAllRanges();selection.addRange(range);
    window.__selectedStepText=selection.toString();
    if(!window.__selectedStepText||!window.__openScroll)throw new Error('The retained output must have a real selection and inner scroll');
    const list=${chat}.querySelector('[data-testid="chat-step-window"]');window.__stepScroller.scrollTop+=list.getBoundingClientRect().height/2;
  })()`);
  await app.waitFor(
    `(()=>{const view=window.__stepScroller.getBoundingClientRect();return window.__stepScroller.scrollTop>2000&&[...${chat}.querySelectorAll('[data-step-key]')].filter(row=>{const rect=row.getBoundingClientRect();return rect.bottom>view.top&&rect.top<view.bottom}).length>=10})()`,
  );
  expect(
    await app.eval(
      `window.__openStep.isConnected&&window.__openStep.scrollTop===window.__openScroll&&document.getSelection().toString()===window.__selectedStepText`,
    ),
  ).toBe(true);
  await app.eval(
    `document.getSelection().removeAllRanges();document.activeElement.blur()`,
  );
  // Focus the last mounted header before a skipped range. Native Tab must
  // visit the next logical step, rather than jump to the composer.
  const boundary = await app.eval<{ label: string; next: number }>(`(()=>{
    const list=${chat}.querySelector('[data-testid="chat-step-window"]');
    const gap=[...list.children].filter(n=>n.hasAttribute('data-step-gap')&&n.previousElementSibling?.matches('[data-step-key]')).at(-1);
    const row=gap.previousElementSibling;row.querySelector('button').focus({preventScroll:true});
    const index=Number(/[0-9]+/.exec(row.querySelector('button').textContent)[0]);
    return {label:row.textContent,next:index+1};
  })()`);
  await app.press("Tab");
  await app.waitFor(
    `document.activeElement?.closest('[data-step-key]')?.textContent.includes('document ${boundary.next}')`,
  );
  await app.press("Tab", 8);
  await app.waitFor(
    `document.activeElement?.closest('[data-step-key]')?.textContent.includes('document ${boundary.next - 1}')`,
  );
  await app.screenshot(path.join(artifacts, "windowed-steps-middle.png"));
  expect(app.getRendererErrors()).toEqual([]);
});

it("keeps narrow light-theme rows filled through a reduced-motion fold and reopen", async () => {
  await app.cdp("Emulation.setEmulatedMedia", {
    features: [{ name: "prefers-reduced-motion", value: "reduce" }],
  });
  try {
    await app.eval(
      `window.catamorphicDesktop.devWindow('setSize',720,800);window.catamorphicDesktop.setTheme({selection:'light',overrides:{}})`,
    );
    const chat = `document.querySelector(${JSON.stringify(front)})`;
    await app.eval(`(()=>{
      const list=${chat}.querySelector('[data-testid="chat-step-window"]'),s=window.__stepScroller;
      document.activeElement.blur();s.scrollTop+=list.getBoundingClientRect().top-s.getBoundingClientRect().top+list.getBoundingClientRect().height-s.clientHeight;
    })()`);
    await app.waitFor(
      `${chat}.querySelector('[data-step-key]') && [...${chat}.querySelectorAll('[data-step-key]')].some(row=>row.textContent.includes('document 499'))`,
    );
    expect(
      await app.eval<number>(
        `${chat}.querySelectorAll('[data-step-key]').length`,
      ),
    ).toBeLessThan(220);
    await app.screenshot(
      path.join(artifacts, "windowed-steps-narrow-light.png"),
    );
    await app.eval(
      `${chat}.querySelector('[data-testid="chat-turn-steps-toggle"]').click()`,
    );
    await app.waitFor(`!${chat}.querySelector('[data-testid="chat-step"]')`);
    await app.eval(
      `${chat}.querySelector('[data-testid="chat-turn-steps-toggle"]').click()`,
    );
    await app.waitFor(`${chat}.querySelectorAll('[data-step-key]').length>10`);
    expect(
      await app.eval(
        `${chat}.querySelector('[data-testid="chat-step-list"]') && getComputedStyle(${chat}.querySelector('[data-testid="chat-step-list"]')).transitionDuration.split(',').every(value=>Number.parseFloat(value)<0.001)`,
      ),
    ).toBe(true);
    await app.waitFor(
      `!${chat}.querySelector('[data-testid="chat-step-list"]').getAnimations().some(a=>a.playState==='running')`,
      { timeoutMs: 1000, label: "reduced-motion list settled" },
    );
    expect(app.getRendererErrors()).toEqual([]);
  } finally {
    await app.cdp("Emulation.setEmulatedMedia", {
      features: [{ name: "prefers-reduced-motion", value: "no-preference" }],
    });
    await app.eval(
      `window.catamorphicDesktop.devWindow('setSize',1200,800);window.catamorphicDesktop.setTheme({selection:'dark',overrides:{}})`,
    );
  }
});

it("settles fractional scroller geometry without repeatedly rewriting gaps", async () => {
  const mutations = await app.eval<{
    changes: number;
    commits: number;
  }>(`new Promise(resolve=>{
    const s=window.__stepScroller,list=document.querySelector(${JSON.stringify(front)}).querySelector('[data-testid="chat-step-window"]');
    const previous=s.style.height;s.style.height='calc(100% - 0.5px)';
    const row=[...list.querySelectorAll('[data-step-key]')].find(row=>row.querySelector('button').getAttribute('aria-expanded')==='false');
    const previousRowHeight=row.style.height;row.style.height='22.515625px';
    let frames=0,changes=0,commits=0,observer;
    const sample=()=>{
      if(++frames===10){commits=window.__stepCommits;observer=new MutationObserver(records=>{changes+=records.filter(r=>r.target.hasAttribute('data-step-gap')).length});observer.observe(list,{subtree:true,attributes:true,attributeFilter:['style']});}
      if(frames<30)requestAnimationFrame(sample);
      else{observer.disconnect();const count=window.__stepCommits-commits;s.style.height=previous;row.style.height=previousRowHeight;resolve({changes,commits:count});}
    };requestAnimationFrame(sample);
  })`);
  expect(mutations.changes).toBeLessThan(3);
  expect(mutations.commits).toBeLessThan(10);
  expect(app.getRendererErrors()).toEqual([]);
});

it("fills the next main-thread frame after a jump beyond overscan", async () => {
  const position = await app.eval<number>("window.__stepScroller.scrollTop");
  if (position > 0) {
    await app.cdp("Input.dispatchMouseEvent", {
      type: "mouseWheel",
      x: 600,
      y: 300,
      deltaX: 0,
      deltaY: -240,
    });
    await app.waitFor(`window.__stepScroller.scrollTop<${position}-1`);
  }
  const visible = await app.eval<number>(`new Promise(resolve=>{
    const s=window.__stepScroller,list=document.querySelector(${JSON.stringify(front)}).querySelector('[data-testid="chat-step-window"]');
    document.activeElement.blur();
    s.addEventListener('scroll',()=>requestAnimationFrame(()=>{
      const view=s.getBoundingClientRect();
      resolve([...list.querySelectorAll('[data-step-key]')].filter(row=>{const rect=row.getBoundingClientRect();return rect.bottom>view.top&&rect.top<view.bottom}).length);
    }),{once:true});
    s.scrollTop+=list.getBoundingClientRect().top-s.getBoundingClientRect().top+list.getBoundingClientRect().height*.3;
  })`);
  expect(visible).toBeGreaterThanOrEqual(10);
});

async function withWatchers(count: number, check: () => Promise<void>) {
  const shellOrigin = await app.eval<string>("window.origin");
  const removed = new Set<string>();
  const failures: unknown[] = [];
  const unsubscribe = app.onCdpEvent("Fetch.requestPaused", (raw) => {
    const event = raw as {
      requestId: string;
      request: { method: string; url: string; headers: Record<string, string> };
    };
    const preflight = event.request.method === "OPTIONS";
    const requestedHeaders = Object.entries(event.request.headers).find(
      ([name]) => name.toLowerCase() === "access-control-request-headers",
    )?.[1];
    if (event.request.method === "DELETE")
      removed.add(new URL(event.request.url).pathname.split("/").at(-1)!);
    const body =
      event.request.method === "DELETE"
        ? { ok: true }
        : {
            items: Array.from({ length: count }, (_, index) => ({
              id: `watch-${index}`,
              workflowName: `Wait for checks ${index}`,
              status: "active",
              triggerKinds: ["schedule"],
              lastRun: null,
              lastError: null,
              nextRunAt: null,
              expiresAt: null,
            })).filter((item) => !removed.has(item.id)),
          };
    void app
      .cdp("Fetch.fulfillRequest", {
        requestId: event.requestId,
        responseCode: preflight ? 204 : 200,
        responseHeaders: [
          { name: "content-type", value: "application/json" },
          { name: "access-control-allow-origin", value: shellOrigin },
          ...(preflight
            ? [
                {
                  name: "access-control-allow-methods",
                  value: "GET, DELETE, OPTIONS",
                },
                ...(requestedHeaders
                  ? [
                      {
                        name: "access-control-allow-headers",
                        value: requestedHeaders,
                      },
                    ]
                  : []),
              ]
            : []),
        ],
        ...(preflight
          ? {}
          : { body: Buffer.from(JSON.stringify(body)).toString("base64") }),
      })
      .catch((error) => failures.push(error));
  });
  await app.cdp("Fetch.enable", {
    patterns: [{ urlPattern: "*/watchers*", requestStage: "Request" }],
  });
  try {
    await app.reload();
    await app.waitFor(
      `document.querySelector(${JSON.stringify(front)})?.querySelectorAll('[data-watcher-id]').length===${count}`,
    );
    // Settle the measured-height entrance before inspecting its exit.
    await app.waitFor(
      `!document.querySelector(${JSON.stringify(front)}).querySelector('[data-testid="chat-watchers"]').closest('[data-collapsible]').getAnimations().some(a=>a.playState==='running')`,
    );
    await check();
    expect(failures).toEqual([]);
  } finally {
    unsubscribe();
    await app.cdp("Fetch.disable");
  }
}

it("closes a stopped watcher by height before removing its retained text", async () => {
  await withWatchers(1, async () => {
    const selector = `${front} [data-watcher-id="watch-0"]`;
    await app.eval(`(()=>{
      const row=document.querySelector(${JSON.stringify(selector)}),box=row.closest('[data-collapsible]');
      window.__watchExit=null;
      const observer=new MutationObserver(()=>{
        if(box.dataset.collapsible!=='closed')return;
        const animation=box.getAnimations().find(a=>a instanceof CSSTransition&&a.transitionProperty==='height');
        if(!animation)return;
        const saved=animation.currentTime,duration=animation.effect.getComputedTiming().duration;
        const heights=[0,.2,.5,.8,.9995].map(f=>{animation.currentTime=duration*f;return box.getBoundingClientRect().height});
        animation.currentTime=saved;
        window.__watchExit={heights,inert:!!row.closest('[inert]'),text:row.textContent};observer.disconnect();
      });observer.observe(box,{attributes:true});
      row.querySelector('button[aria-label="Stop watcher Wait for checks 0"]').focus();
    })()`);
    await app.press("Enter");
    const motion = await app.waitFor<{
      heights: number[];
      inert: boolean;
      text: string;
    }>("window.__watchExit", { label: "watcher closing height transition" });
    expect(motion.inert).toBe(true);
    expect(motion.text).toContain("Wait for checks");
    expect(motion.heights[0]).toBeGreaterThan(10);
    expect(motion.heights[2]).toBeGreaterThan(0);
    expect(motion.heights[2]).toBeLessThan(motion.heights[0] ?? 0);
    expect(motion.heights.at(-1)).toBeLessThan(1);
    await app.waitFor(`!document.querySelector(${JSON.stringify(selector)})`);
  });
});

it.each([3, 8])(
  "slides surviving watchers into place after an exit (%s watches)",
  async (count) => {
    await withWatchers(count, async () => {
      await app.eval(`(()=>{
      const body=document.querySelector(${JSON.stringify(front)}).querySelector('[data-testid="chat-watchers"]');
      const positions=new Map([...body.querySelectorAll('[data-watcher-id]')].map(token=>[token.dataset.watcherId,token.closest('[data-collapsible]').getBoundingClientRect()]));
      window.__watchMoves=null;
      const observer=new MutationObserver(()=>{
        if(body.querySelector('[data-watcher-id="watch-0"]'))return;
        const moves=[...body.querySelectorAll('[data-watcher-id]')].flatMap(token=>{
          const box=token.closest('[data-collapsible]'),animation=box.getAnimations().find(a=>a.id==='watcher-move');
          if(!animation)return [];
          const saved=animation.currentTime,duration=animation.effect.getComputedTiming().duration;
          const points=[0,.5,.9995].map(f=>{animation.currentTime=duration*f;const rect=box.getBoundingClientRect();return {x:rect.left,y:rect.top}});
          animation.currentTime=saved;
          const before=positions.get(token.dataset.watcherId);
          return [{points,before:{x:before.left,y:before.top}}];
        });
        if(moves.length){window.__watchMoves=moves;observer.disconnect();}
      });observer.observe(body,{childList:true,subtree:true});
      body.querySelector('button[aria-label="Stop watcher Wait for checks 0"]').focus();
    })()`);
      await app.press("Enter");
      const moves = await app.waitFor<
        Array<{
          points: Array<{ x: number; y: number }>;
          before: { x: number; y: number };
        }>
      >("window.__watchMoves", { label: "watcher reflow transform" });
      for (const move of moves) {
        expect(
          Math.hypot(
            move.points[0]!.x - move.before.x,
            move.points[0]!.y - move.before.y,
          ),
        ).toBeLessThan(2);
        const distance = (point: { x: number; y: number }) =>
          Math.hypot(point.x - move.points[2]!.x, point.y - move.points[2]!.y);
        expect(distance(move.points[0]!)).toBeGreaterThan(2);
        expect(distance(move.points[1]!)).toBeGreaterThan(0);
        expect(distance(move.points[1]!)).toBeLessThan(
          distance(move.points[0]!),
        );
      }
      if (count === 8)
        expect(
          moves.some(
            (move) => Math.abs(move.points[0]!.y - move.points[2]!.y) > 5,
          ),
        ).toBe(true);
    });
  },
);

it("settles watcher exits and reflow immediately with reduced motion", async () => {
  await app.cdp("Emulation.setEmulatedMedia", {
    features: [{ name: "prefers-reduced-motion", value: "reduce" }],
  });
  try {
    await withWatchers(3, async () => {
      await app.eval(
        `document.querySelector(${JSON.stringify(front)}).querySelector('button[aria-label="Stop watcher Wait for checks 0"]').focus()`,
      );
      await app.press("Enter");
      await app.waitFor(
        `!document.querySelector(${JSON.stringify(front)}).querySelector('[data-watcher-id="watch-0"]')`,
      );
      const moving = await app.eval<boolean>(
        `document.querySelector(${JSON.stringify(front)}).querySelector('[data-testid="chat-watchers"]').getAnimations({subtree:true}).some(a=>a.playState==='running'&&a.effect.getComputedTiming().duration>1)`,
      );
      expect(moving).toBe(false);
    });
  } finally {
    await app.cdp("Emulation.setEmulatedMedia", { features: [] });
  }
});
