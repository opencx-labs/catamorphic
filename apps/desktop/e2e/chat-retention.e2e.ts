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
    `document.querySelector(${JSON.stringify(front)}).querySelectorAll('[data-testid="chat-step"]').length===500`,
  );
  expect(await count('[data-testid="chat-step-detail"]')).toBe(0);
  const expanded = await count("*");
  expect(expanded).toBeGreaterThan(resting + 3_000);
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

async function withWatchers(count: number, check: () => Promise<void>) {
  const removed = new Set<string>();
  const failures: unknown[] = [];
  const unsubscribe = app.onCdpEvent("Fetch.requestPaused", (raw) => {
    const event = raw as {
      requestId: string;
      request: { method: string; url: string };
    };
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
        responseCode: 200,
        responseHeaders: [{ name: "content-type", value: "application/json" }],
        body: Buffer.from(JSON.stringify(body)).toString("base64"),
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
