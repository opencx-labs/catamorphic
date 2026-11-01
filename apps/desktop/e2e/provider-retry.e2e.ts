import fs from "node:fs";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, expect, it } from "vitest";
import {
  type AppHandle,
  focusWindow,
  launchApp,
  setReactValueJs,
} from "./harness.js";
import { CHATS_SECTION, writeSidebarSections } from "./sidebar-config.js";

let app: AppHandle;
let base: string;
let agentId: string;
let origin: string;
const page = createServer((_request, response) =>
  response.end(
    "<!doctype html><title>Local fixture</title><h1>Browser fixture</h1>",
  ),
);
const directory = fs.mkdtempSync(path.join(os.tmpdir(), "provider-retry-"));
const gate = path.join(directory, "phase");
const front = "section[data-chat-local-id]:not([inert], [inert] *)";
const retry = `${front} [data-testid="chat-provider-retry"]`;
const error = `${front} [data-testid="chat-error-card"]`;
const artifacts = process.env.CATAMORPHIC_E2E_ARTIFACTS_DIR ?? "/tmp";

beforeAll(async () => {
  await new Promise<void>((resolve) => page.listen(0, "127.0.0.1", resolve));
  const address = page.address();
  if (!address || typeof address === "string")
    throw new Error("No fixture address");
  origin = `http://127.0.0.1:${address.port}`;
  fs.writeFileSync(gate, "start");
  app = await launchApp({ env: { CATAMORPHIC_E2E_RETRY_GATE: gate } });
  await writeSidebarSections(app, [CHATS_SECTION]);
  ({ base, agentId } = await app.eval<{
    base: string;
    agentId: string;
  }>(`(async()=>{
    const api=window.catamorphicDesktop;
    const project=await api.createProject({name:'Retry and retained chats',rootPath:${JSON.stringify(path.join(directory, "project"))}});
    const agent=await api.agentsCreate({name:'Fixture helper',harness:'ai-sdk'});
    await api.agentsSetDefault(agent.id);
    const {url}=await api.getServerState();
    return {base:url+'/api/projects/'+project.id+'/agent/sessions',agentId:agent.id};
  })()`));
  await focusWindow(app);
}, 180_000);

afterAll(async () => {
  await app?.stop();
  await new Promise<void>((resolve, reject) =>
    page.close((error) => (error ? reject(error) : resolve())),
  );
  fs.rmSync(directory, { recursive: true, force: true });
});

async function createChat(title: string, text: string) {
  const id = await app.eval<string>(`(async()=>{
    const created=await fetch(${JSON.stringify(base)},{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({agentId:${JSON.stringify(agentId)},title:${JSON.stringify(title)},source:'desktop'})});
    if(!created.ok)throw new Error(await created.text());
    const {id}=await created.json();
    const sent=await fetch(${JSON.stringify(base)}+'/'+id+'/commands',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({type:'send',commandId:crypto.randomUUID(),text:${JSON.stringify(text)}})});
    if(!sent.ok)throw new Error(await sent.text());
    return id;
  })()`);
  const row = `aside [data-session-id="${id}"] [data-tree-primary]`;
  await app.waitFor(`!!document.querySelector(${JSON.stringify(row)})`);
  await app.eval(`document.querySelector(${JSON.stringify(row)}).click()`);
  await app.waitFor(`!!document.querySelector(${JSON.stringify(front)})`);
  return id;
}

/** Seek a real height transition in one task, preserving its natural progress. */
const probe = `
  const motions=node.getAnimations().filter(a=>a instanceof CSSTransition);
  const height=motions.find(a=>a.transitionProperty==='grid-template-rows');
  if(!height)throw new Error('No grid transition for status');
  const duration=height.effect.getComputedTiming().duration;
  const saved=motions.map(a=>[a,a.currentTime]);
  const samples=[];
  for(const fraction of [0,0.2,0.5,0.8,0.9995]){
    for(const a of motions)a.currentTime=duration*fraction;
    samples.push({height:node.getBoundingClientRect().height,opacity:Number(getComputedStyle(node).opacity),margin:Number.parseFloat(getComputedStyle(node).marginTop)});
  }
  for(const [a,time]of saved)a.currentTime=time;
`;

for (const reduced of [false, true])
  it(`reveals provider retries and terminal errors, then closes them smoothly (reduced motion ${reduced})`, async () => {
    await app.cdp("Emulation.setEmulatedMedia", {
      features: [
        {
          name: "prefers-reduced-motion",
          value: reduced ? "reduce" : "no-preference",
        },
      ],
    });
    fs.writeFileSync(gate, "start");
    const id = await createChat(
      `Provider lifecycle ${reduced}`,
      `Provider retry lifecycle ${reduced}`,
    );
    await app.waitFor(
      `document.querySelector(${JSON.stringify(front)})?.textContent.includes('Checking the request.')`,
    );
    // Observe before the server event, capturing entry and exit even on a slow renderer.
    await app.eval(`(()=>{
    window.__retryMotion=[];
    window.__retryResize=null;
    window.__expectRetryResize=false;
    const observer=new MutationObserver(()=>{
      const card=document.querySelector(${JSON.stringify(retry)});
      const node=card?.closest('.cat-reveal');
      if(!node)return;
      if(!${reduced} && window.__expectRetryResize && card.textContent.includes("fixture-request-42") && !window.__retryResize){
        const grow=card.closest('.cat-grow');
        const motion=grow?.getAnimations().find(a=>a instanceof CSSTransition && a.transitionProperty==='height');
        if(motion){
          const duration=motion.effect.getComputedTiming().duration,at=motion.currentTime;
          const heights=[];
          for(const fraction of [0,0.5,0.9995]){motion.currentTime=duration*fraction;heights.push(grow.getBoundingClientRect().height);}
          motion.currentTime=at;
          if(heights[2]>heights[0]+1)window.__retryResize=heights;
        }
      }
      const phase=node.hasAttribute('data-closed')?'exit':'entry';
      if(window.__retryMotion.some(p=>p.phase===phase))return;
      const record={phase,text:card.textContent,inert:node.inert,samples:[],error:null};
      if(!${reduced}){
        try {${probe}record.samples=samples;}catch(error){record.error=String(error);}
      }
      window.__retryMotion.push(record);
    });
    observer.observe(document.querySelector(${JSON.stringify(front)}),{childList:true,subtree:true,attributes:true,attributeFilter:['data-closed','data-entering','style']});
    window.__retryObserver=observer;
  })()`);
    fs.writeFileSync(gate, "retry");
    await app.waitFor(
      `document.querySelector(${JSON.stringify(retry)})?.textContent.includes('HTTP 503')`,
    );
    expect(
      await app.eval(
        `!!document.querySelector(${JSON.stringify(`${front} [data-testid="chat-activity"]:not([inert] *)`)})`,
      ),
    ).toBe(false);
    await app.waitFor(
      `!document.querySelector(${JSON.stringify(retry)})?.closest(".cat-reveal").hasAttribute("data-moving")`,
    );
    await app.screenshot(path.join(artifacts, `provider-retry-${reduced}.png`));
    await app.eval("window.__retryResize=null;window.__expectRetryResize=true");
    fs.writeFileSync(gate, "detail");
    await app.waitFor(
      `document.querySelector(${JSON.stringify(retry)})?.textContent.includes('fixture-request-42')`,
    );
    expect(
      await app.eval(
        `document.querySelector(${JSON.stringify(retry)}).textContent`,
      ),
    ).not.toContain("Cannot reach");
    if (!reduced) {
      const heights = await app.waitFor<number[]>("window.__retryResize");
      expect(heights[1]).toBeGreaterThan(heights[0] ?? 0);
      expect(heights[2]).toBeGreaterThan(heights[1] ?? 0);
    }
    // Persisting and reloading a provider wait must retain the original detail.
    expect(
      await app.eval(
        `fetch(${JSON.stringify(`${base}/${id}`)}).then(r=>r.json()).then(d=>d.snapshot.turns[0].providerRetry.error.message)`,
      ),
    ).toContain("fixture-request-42");
    fs.writeFileSync(gate, "recover");
    await app.waitFor(`!document.querySelector(${JSON.stringify(retry)})`);
    const motion = await app.eval<
      Array<{
        phase: string;
        text: string;
        inert: boolean;
        error: string | null;
        samples: Array<{ height: number; opacity: number; margin: number }>;
      }>
    >("window.__retryMotion");
    expect(motion.map((p) => p.phase)).toEqual(["entry", "exit"]);
    expect(motion[1]?.inert).toBe(true);
    expect(motion[1]?.text).toContain("fixture-request-42");
    if (!reduced) {
      for (const phase of motion) expect(phase.error).toBeNull();
      const entry = motion[0]?.samples ?? [];
      const exit = motion[1]?.samples ?? [];
      expect(entry[0]?.height).toBeLessThan(1);
      expect(entry[2]?.height).toBeGreaterThan(1);
      expect(exit[0]?.height).toBeGreaterThan(1);
      expect(exit[4]?.height).toBeLessThan(1);
      expect(exit[4]?.margin).toBeCloseTo(-12, 0);
    }
    fs.writeFileSync(gate, "fail");
    await app.waitFor(
      `document.querySelector(${JSON.stringify(error)})?.textContent.includes('Provider E99')`,
    );
    await app.screenshot(path.join(artifacts, `provider-error-${reduced}.png`));
    await app.eval(
      `document.querySelector(${JSON.stringify(`${error} [data-testid="chat-retry"]`)}).click()`,
    );
    await app.waitFor(
      `document.querySelector(${JSON.stringify(front)})?.textContent.includes('Manual retry completed.') && !document.querySelector(${JSON.stringify(error)})`,
    );
    await app.eval("window.__retryObserver.disconnect()");
    expect(app.getRendererErrors()).toEqual([]);
  });

it("returns a large retained chat from a browser tab without a history load or entrance replay", async () => {
  await app.cdp("Emulation.setEmulatedMedia", {
    features: [{ name: "prefers-reduced-motion", value: "no-preference" }],
  });
  const id = await createChat(
    "Large retained review",
    "Large retained transcript",
  );
  await app.waitFor(
    `(async()=>{const d=await fetch(${JSON.stringify(`${base}/${id}`)}).then(r=>r.json());return d.snapshot.turns[0]?.status==='completed'})()`,
  );
  await app.waitFor(
    `document.querySelector(${JSON.stringify(front)})?.textContent.includes('Paragraph 60:')`,
  );
  let snapshotLoads = 0;
  await app.cdp("Network.enable");
  const unsubscribe = app.onCdpEvent("Network.requestWillBeSent", (event) => {
    if (!event || typeof event !== "object" || !("request" in event)) return;
    const request = event.request;
    if (
      request &&
      typeof request === "object" &&
      "url" in request &&
      request.url === `${base}/${id}`
    )
      snapshotLoads++;
  });
  await app.eval(`(()=>{${setReactValueJs}
    const dock=document.querySelector(${JSON.stringify(front)});
    window.__retained={dock,log:dock.querySelector('[role="log"]'),input:dock.querySelector('[data-composer-input]')};
    setReactValue(window.__retained.input,'Draft survives the tab switch');
  })()`);
  await app.eval(
    `document.querySelector('button[aria-label="New tab"]').click()`,
  );
  await app.waitFor(
    `document.activeElement?.getAttribute("aria-label")==="Search commands, pages, and more"`,
  );
  await app.eval(
    `(()=>{${setReactValueJs};setReactValue(document.activeElement,${JSON.stringify(origin)})})()`,
  );
  await app.press("Enter");
  await app.waitFor(`document.querySelector(${JSON.stringify(front)})===null`);
  const hidden = await app.eval<{
    visibility: string;
    contentVisibility: string;
    height: number;
  }>(
    `(()=>{const d=window.__retained.dock;return {visibility:getComputedStyle(d).visibility,contentVisibility:getComputedStyle(d).contentVisibility,height:window.__retained.log.getBoundingClientRect().height}})()`,
  );
  expect(hidden.visibility).toBe("hidden");
  expect(hidden.contentVisibility).toBe("visible");
  expect(hidden.height).toBeGreaterThan(0);
  await app.eval(`(()=>{
    const row=[...document.querySelectorAll('button')].find(b=>b.textContent.trim()==='Large retained review');
    if(!row)throw new Error('No retained chat tab');
    const kept=window.__retained;
    window.__returnFrames=[];
    const began=performance.now();
    const sample=()=>{
      const d=kept.dock,style=getComputedStyle(d),rect=kept.input.getBoundingClientRect();
      window.__returnFrames.push({shown:style.visibility==='visible',opacity:Number(style.opacity),transform:style.transform,y:rect.y,height:rect.height,scroll:kept.log.firstElementChild.scrollTop});
      if(performance.now()-began<500)requestAnimationFrame(sample);
    };
    requestAnimationFrame(sample);
    row.click();
  })()`);
  await app.waitFor(`!!document.querySelector(${JSON.stringify(front)})`);
  const returned = await app.eval(
    `(()=>{const kept=window.__retained;const d=document.querySelector(${JSON.stringify(front)});return {same:d===kept.dock&&d.querySelector('[role="log"]')===kept.log&&d.querySelector('[data-composer-input]')===kept.input,draft:kept.input.innerText,opacity:getComputedStyle(d).opacity,animations:d.getAnimations().filter(a=>a.playState==='running').map(a=>a.animationName)}})()`,
  );
  expect(returned).toMatchObject({
    same: true,
    draft: "Draft survives the tab switch",
    opacity: "1",
    animations: [],
  });
  const frames = await app.waitFor<
    Array<{
      shown: boolean;
      opacity: number;
      transform: string;
      y: number;
      height: number;
      scroll: number;
    }>
  >(
    `window.__returnFrames?.length>3 && window.__returnFrames.filter(f=>f.shown).length>2 && window.__returnFrames`,
  );
  const shown = frames.filter((frame) => frame.shown);
  expect(shown.every((frame) => frame.opacity === 1)).toBe(true);
  expect(
    Math.max(...shown.map((frame) => frame.y)) -
      Math.min(...shown.map((frame) => frame.y)),
  ).toBeLessThan(1);
  expect(
    Math.max(...shown.map((frame) => frame.scroll)) -
      Math.min(...shown.map((frame) => frame.scroll)),
  ).toBeLessThan(1);
  expect(snapshotLoads).toBe(0);
  unsubscribe();
  await app.screenshot(path.join(artifacts, "retained-chat-return.png"));
});
