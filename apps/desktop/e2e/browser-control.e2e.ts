import http from "node:http";
import path from "node:path";
import { afterAll, beforeAll, expect, it } from "vitest";
import {
  type AppHandle,
  type FrameHandle,
  launchApp,
  setReactValueJs,
} from "./harness.js";

let app: AppHandle;
let guest: FrameHandle;
let server: http.Server;
let base: string;
let key: string;
let counter = 0;
const helpers = `${setReactValueJs}
const composer=()=>[...document.querySelectorAll('section[aria-label]')].find(el=>!el.closest('[inert]') && el.querySelector('[data-composer-input]'))?.querySelector('[data-composer-input]');
const logs=()=>[...document.querySelectorAll('[role="log"]')].map(el=>el.textContent).join('\\n');`;
async function tool(
  name: string,
  input: Record<string, unknown>,
): Promise<unknown> {
  counter++;
  const prefix = `E2E result ${counter}: `;
  const prompt = `E2E workspace tool ${JSON.stringify({ name, input, serial: counter })}`;
  await app.eval(
    `(()=>{${helpers};setReactValue(composer(),${JSON.stringify(prompt)});composer().closest('form').requestSubmit();})()`,
  );
  const result = await app.waitFor<string>(
    `(()=>{${helpers};const text=logs();const start=text.lastIndexOf(${JSON.stringify(prefix)});return start<0?false:text.slice(start+${prefix.length}).split('E2E end')[0];})()`,
  );
  const parsed = JSON.parse(result);
  if (parsed.error) console.info(name, parsed.error);
  return parsed;
}
const snapshot = async () =>
  (await tool("browser_snapshot", { key })) as {
    elements: Array<{ uid: string; label: string; tag: string }>;
  };
const uid = async (label: string) => {
  const result = await snapshot();
  const element = result.elements.find(
    (el) => el.label === label && el.tag !== "label",
  );
  if (!element) throw Error(`Missing ${label}`);
  return element.uid;
};
beforeAll(async () => {
  server = http.createServer((_req, res) => {
    res.setHeader("content-type", "text/html");
    res.end(
      `<!doctype html><html><head><title>Browser control fixture</title><style>body{font:16px system-ui;padding:40px;background:#f5f5f7;color:#202024}main{max-width:540px;margin:auto}label{display:block;margin:20px 0 7px}input,select,button,[contenteditable]{font:inherit;padding:10px;border:1px solid #bbc;border-radius:8px;background:white}button{background:#594ad4;color:white;margin:20px 0}#editable{min-height:40px}h1{font-size:26px}output{display:block;margin:20px 0}footer{margin-top:1000px}</style></head><body><main><h1>Plan a trip</h1><form id="form"><label for="name">Destination</label><input id="name" aria-label="Destination" autocomplete="off"><label for="choice">Travel mode</label><select id="choice" aria-label="Travel mode"><option value="train">Train</option><option value="car">Car</option></select><label>Notes</label><div id="editable" contenteditable="true" aria-label="Notes"></div><input type="password" value="never-snapshot-this" aria-label="Password"><button id="save">Save itinerary</button><button disabled>Unavailable</button></form><output id="result">Ready</output><button id="replace" onclick="this.outerHTML='<button>Replacement</button>'">Replace me</button><div id="shadow"></div><canvas width="120" height="60" aria-label="Drawing"></canvas><footer>Page end</footer></main><script>window.events=[];for(const event of ['click','input','keydown'])document.addEventListener(event,e=>events.push({type:event,id:e.target.id,key:e.key,trusted:e.isTrusted}));form.addEventListener('submit',e=>{e.preventDefault();result.textContent='Saved '+document.querySelector('#name').value+' by '+choice.value});const root=shadow.attachShadow({mode:'open'});root.innerHTML='<button>Shadow button</button>';</script></body></html>`,
    );
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw Error("No port");
  base = `http://127.0.0.1:${address.port}`;
  app = await launchApp();
  await app.waitFor(`!!document.querySelector('[data-sidebar="left"]')`);
  await app.eval(
    `window.catamorphicDesktop.createProject({name:'Browser testing',rootPath:${JSON.stringify(path.join(app.userDataDir, "browser-project"))}})`,
  );
  await app.eval("location.reload()");
  await app.waitFor(`document.body?.innerText.includes('Browser testing')`);
  await app.eval(`window.catamorphicDesktop.devWindow('setSize',1200,850)`);
  await app.eval(
    `window.dispatchEvent(new KeyboardEvent('keydown',{key:'n',metaKey:/Mac/.test(navigator.platform),ctrlKey:!/Mac/.test(navigator.platform),bubbles:true}))`,
  );
  await app.waitFor(`(()=>{${helpers};return !!composer();})()`);
  const result = (await tool("open_browser", { url: base })) as { key: string };
  key = result.key;
  guest = await app.connectToFrame(base);
  console.info(
    "initial viewport",
    await guest.eval("({w:innerWidth,h:innerHeight})"),
  );
});
afterAll(async () => {
  guest?.close();
  await app?.stop();
  await new Promise<void>((resolve) => server?.close(() => resolve()));
});
it("drives native clicks, editing, selects and keyboard defaults without leaking passwords", async () => {
  expect(JSON.stringify(await snapshot())).not.toContain("never-snapshot-this");
  expect(
    await tool("browser_act", {
      key,
      action: "fill",
      uid: await uid("Destination"),
      text: "Kyoto",
    }),
  ).toEqual({ ok: true });
  await tool("browser_act", { key, action: "press", press_key: "ArrowLeft" });
  await tool("browser_act", { key, action: "press", press_key: "Backspace" });
  expect(await guest.eval('document.querySelector("#name").value')).toBe(
    "Kyoo",
  );
  await tool("browser_act", {
    key,
    action: "fill",
    uid: await uid("Destination"),
    text: "Kyoto",
  });
  await tool("browser_act", { key, action: "press", press_key: "Tab" });
  expect(await guest.eval("document.activeElement.id")).toBe("choice");
  await tool("browser_act", {
    key,
    action: "select",
    uid: await uid("Travel mode"),
    text: "car",
  });
  await tool("browser_act", {
    key,
    action: "fill",
    uid: await uid("Notes"),
    text: "A quiet weekend",
  });
  expect(
    await guest.eval('document.querySelector("#editable").textContent'),
  ).toBe("A quiet weekend");
  await tool("browser_act", {
    key,
    action: "click",
    uid: await uid("Save itinerary"),
  });
  expect(
    await guest.eval('document.querySelector("#result").textContent'),
  ).toContain("by car");
  expect(
    await guest.eval(
      `events.some(e=>e.type==='click'&&e.id==='save'&&e.trusted)`,
    ),
  ).toBe(true);
  expect(
    await guest.eval(
      `events.some(e=>e.type==='input'&&e.id==='editable'&&e.trusted)`,
    ),
  ).toBe(true);
});
it("uses CSS image coordinates for native clicks and rejects covered elements", async () => {
  const target = await uid("Save itinerary");
  await tool("browser_act", { key, action: "hover", uid: target });
  const point = await guest.eval<{ x: number; y: number }>(
    `(()=>{const rect=document.querySelector('#save').getBoundingClientRect();return {x:rect.x+rect.width/2,y:rect.y+rect.height/2};})()`,
  );
  await guest.eval(`document.querySelector('#result').textContent='Ready';`);
  expect(await tool("browser_act", { key, action: "click", ...point })).toEqual(
    { ok: true },
  );
  expect(
    await guest.eval(`document.querySelector('#result').textContent`),
  ).toBe("Saved Kyoto by car");
  await guest.eval(
    `(()=>{const overlay=document.createElement('div');overlay.id='cover';overlay.style.cssText='position:fixed;inset:0;z-index:100;background:white';document.body.append(overlay);})()`,
  );
  expect(
    await tool("browser_act", { key, action: "click", uid: target }),
  ).toHaveProperty("error", expect.stringContaining("covered"));
  await guest.eval(`document.querySelector('#cover').remove()`);
});
it("rejects stale, disabled, covered and out-of-bounds targets and supports shadow roots", async () => {
  const old = await uid("Replace me");
  await tool("browser_act", { key, action: "click", uid: old });
  expect(
    await tool("browser_act", { key, action: "click", uid: old }),
  ).toHaveProperty("error", expect.stringContaining("Stale"));
  expect(
    await tool("browser_act", {
      key,
      action: "click",
      uid: await uid("Unavailable"),
    }),
  ).toHaveProperty("error", expect.stringContaining("disabled"));
  expect(
    await tool("browser_act", { key, action: "click", x: 999999, y: 1 }),
  ).toHaveProperty("error", expect.stringContaining("outside"));
  expect(
    await tool("browser_act", {
      key,
      action: "click",
      uid: await uid("Shadow button"),
    }),
  ).toEqual({ ok: true });
  const target = await uid("Destination");
  await snapshot();
  expect(
    await tool("browser_act", {
      key,
      action: "fill",
      uid: target,
      text: "old",
    }),
  ).toHaveProperty("error", expect.stringContaining("Stale"));
});
it("captures model images and points inside a page, follows scrolling and clears on interaction", async () => {
  const image = (await tool("browser_snapshot", { key, format: "image" })) as {
    content: Array<{ type: string; mimeType?: string; bytes?: number }>;
  };
  expect(image.content).toContainEqual(
    expect.objectContaining({ type: "image", mimeType: "image/png" }),
  );
  await tool("open_surface", { target: key });
  await tool("point_at", {
    target: key,
    uid: await uid("Save itinerary"),
    note: "Your itinerary is ready",
  });
  expect(
    await guest.eval(
      `document.querySelectorAll('[data-catamorphic-pointer]').length`,
    ),
  ).toBe(1);
  await app.eval(
    `document.querySelector('button[aria-label="Minimize chat to bubble"]').click()`,
  );
  await app.waitFor(
    `(()=>{${helpers};const panel=document.querySelector("section[data-chat-local-id]");return !composer() && panel && getComputedStyle(panel).opacity === "0" && panel.getAnimations().every(a=>a.playState === "finished");})()`,
  );
  await app.screenshot("/tmp/browser-control-point.png");
  await app.eval(
    `[...document.querySelectorAll('button')].find(el=>el.textContent==='Go to chat').click()`,
  );
  await app.waitFor(`(()=>{${helpers};return !!composer();})()`);
  await guest.eval("window.scrollBy(0,80)");
  await guest.waitFor(
    `Math.abs(document.querySelector('[data-catamorphic-pointer]').getBoundingClientRect().top-(document.querySelector('#save').getBoundingClientRect().top-3))<1`,
  );
  await tool("browser_act", {
    key,
    action: "click",
    uid: await uid("Save itinerary"),
  });
  await guest.waitFor(`!document.querySelector('[data-catamorphic-pointer]')`);
  await tool("point_at", {
    target: key,
    uid: await uid("Destination"),
    note: "Edit destination",
  });
  await tool("point_at", { target: null });
  expect(
    await guest.eval(`!!document.querySelector('[data-catamorphic-pointer]')`),
  ).toBe(false);
});
it("stops input after release and validates navigation and waits", async () => {
  await tool("surface_control", { key, action: "release" });
  expect(
    await tool("browser_act", { key, action: "press", press_key: "Enter" }),
  ).toHaveProperty("error", expect.stringContaining("control"));
  await tool("surface_control", { key, action: "reclaim" });
  expect(
    await tool("browser_act", {
      key,
      action: "navigate",
      url: "javascript:alert(1)",
    }),
  ).toHaveProperty("error");
  expect(
    await tool("browser_act", {
      key,
      action: "wait_for",
      text: "does not exist",
      timeoutMs: 30,
    }),
  ).toEqual({ found: false });
  expect(app.getRendererErrors()).toEqual([]);
});
