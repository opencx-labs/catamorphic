import http from "node:http";
import { afterAll, beforeAll, expect, it } from "vitest";
import { type AppHandle, launchApp, setReactValueJs } from "./harness.js";

let app: AppHandle;
let fixture: http.Server;
let fixtureUrl: string;
beforeAll(async () => {
  fixture = http.createServer((_req, res) => {
    res.writeHead(200, { "Content-Type": "text/html" });
    res.end(
      "<title>Idle browser</title><h1>Fixture</h1><script>window.framesRun=0;function frame(){window.framesRun++;requestAnimationFrame(frame)}requestAnimationFrame(frame)</script>",
    );
  });
  await new Promise<void>((resolve) => fixture.listen(0, "127.0.0.1", resolve));
  const address = fixture.address();
  if (!address || typeof address === "string")
    throw new Error("Missing fixture port");
  fixtureUrl = `http://127.0.0.1:${address.port}`;
  app = await launchApp();
  await app.waitFor(
    `!![...document.querySelectorAll('button')].find(b=>b.textContent.trim()==='New project')`,
  );
  await app.eval(
    `[...document.querySelectorAll('button')].find(b=>b.textContent.trim()==='New project').click()`,
  );
  await app.waitFor(
    `!!document.querySelector('[data-testid="project-name-input"]')`,
  );
  await app.eval(
    `(()=>{${setReactValueJs};setReactValue(document.querySelector('[data-testid="project-name-input"]'),'Idle fixture')})()`,
  );
  await app.waitFor(
    `(()=>{const b=document.querySelector('[data-testid="project-submit"]');if(b&&!b.disabled){b.click();return true}return false})()`,
  );
  await app.waitFor(
    `!![...document.querySelectorAll('button')].find(b=>b.textContent.includes('New Tab'))`,
  );
});
afterAll(async () => {
  await app?.stop();
  await new Promise<void>((resolve, reject) =>
    fixture.close((error) => (error ? reject(error) : resolve())),
  );
});

it("leaves settled chat icons without hidden animation loops or backdrop filters", async () => {
  await app.eval(
    `window.dispatchEvent(new KeyboardEvent('keydown',{key:'n',metaKey:/Mac/.test(navigator.platform),ctrlKey:!/Mac/.test(navigator.platform),bubbles:true}))`,
  );
  await app.waitFor(
    `!!document.querySelector('[data-chat-local-id]:not([inert]) [data-composer-input]')`,
  );
  const state = await app.eval<{ loops: string[]; backdrop: string[] }>(`({
    loops: document.getAnimations().filter(a=>a.playState==='running'&&a.effect?.getTiming().iterations===Infinity).map(a=>a.effect?.target?.outerHTML),
    backdrop: [...document.querySelectorAll('[data-chat-local-id]')].map(e=>getComputedStyle(e).backdropFilter)
  })`);
  expect(state.loops).toEqual([]);
  expect(state.backdrop.every((value) => value === "none")).toBe(true);
  expect(app.getRendererErrors()).toEqual([]);
});

it("restores guest visibility and destroys closed browser guests across repeated tab use", async () => {
  await app.press("Escape");
  let stage = "open";
  try {
    for (let index = 0; index < 3; index += 1) {
      await app.eval(
        `window.dispatchEvent(new KeyboardEvent('keydown',{key:'t',metaKey:/Mac/.test(navigator.platform),ctrlKey:!/Mac/.test(navigator.platform),altKey:true,bubbles:true}))`,
      );
      await app.waitFor(
        `!!document.querySelector('input[aria-label="Address and search bar"]')`,
      );
      await app.eval(
        `(()=>{${setReactValueJs};const input=document.querySelector('input[aria-label="Address and search bar"]');setReactValue(input,${JSON.stringify(fixtureUrl)});input.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true}))})()`,
      );
      await app.waitFor(
        `!![...document.querySelectorAll('button')].find(b=>b.textContent.includes('Idle browser'))`,
      );
      stage = "guest execution";
      const page = await app.eval(
        `document.querySelector('webview').executeJavaScript('({url:location.href})')`,
      );
      expect(page).toMatchObject({ url: `${fixtureUrl}/` });
      // Hide through the real tab UI. The guest stays alive but its native
      // animation scheduler must stop, independent of the page cooperating.
      const before = await app.eval<number>(
        `document.querySelector('webview').executeJavaScript('window.framesRun')`,
      );
      await app.eval(
        `window.dispatchEvent(new KeyboardEvent('keydown',{key:'t',metaKey:/Mac/.test(navigator.platform),ctrlKey:!/Mac/.test(navigator.platform),altKey:true,bubbles:true}))`,
      );
      await app.waitFor(
        `getComputedStyle(document.querySelector('webview')).display==='none'`,
      );
      await app.eval(`new Promise(resolve=>setTimeout(resolve,500))`);
      expect(
        await app.eval(
          `document.querySelector('webview').executeJavaScript('document.querySelector("h1").textContent')`,
        ),
      ).toBe("Fixture");
      await app.eval(
        `[...document.querySelectorAll('button')].find(b=>b.textContent.includes('Idle browser')).click()`,
      );
      await app.waitFor(
        `getComputedStyle(document.querySelector('webview')).display!=='none'`,
      );
      const after = await app.eval<number>(
        `document.querySelector('webview').executeJavaScript('window.framesRun')`,
      );
      expect(after - before).toBeLessThan(15);
      if (index === 0) {
        stage = "bounded guest recovery";
        for (let recovery = 0; recovery < 2; recovery += 1) {
          await app.eval(
            `(()=>{window.__recoveringView=document.querySelector('webview');window.__recoveringView.dispatchEvent(new Event('render-process-gone'))})()`,
          );
          await app.waitFor(
            `document.querySelector('webview')!==window.__recoveringView`,
          );
          await app.eval(
            `document.querySelector('webview').executeJavaScript('location.href')`,
          );
        }
        await app.eval(
          `(()=>{window.__recoveringView=document.querySelector('webview');window.__recoveringView.dispatchEvent(new Event('render-process-gone'))})()`,
        );
        await app.waitFor(
          `document.body.textContent.includes('This page repeatedly stopped responding')`,
        );
        await app.eval(`new Promise(resolve=>setTimeout(resolve,1700))`);
        expect(
          await app.eval(
            `document.querySelector('webview')===window.__recoveringView`,
          ),
        ).toBe(true);
        await app.eval(
          `[...document.querySelectorAll('button')].find(b=>b.textContent.trim()==='Try again').click()`,
        );
        await app.waitFor(
          `document.querySelector('webview')!==window.__recoveringView`,
        );
        await app.eval(
          `document.querySelector('webview').executeJavaScript('location.href')`,
        );
      }
      stage = "close browser tab";
      await app.eval(
        `window.dispatchEvent(new KeyboardEvent('keydown',{key:'w',metaKey:/Mac/.test(navigator.platform),ctrlKey:!/Mac/.test(navigator.platform),bubbles:true}))`,
      );
      await app.waitFor(`document.querySelectorAll('webview').length===0`);
      expect(await app.cdp("Target.getTargets")).not.toEqual(
        expect.objectContaining({
          targetInfos: expect.arrayContaining([
            expect.objectContaining({ url: `${fixtureUrl}/` }),
          ]),
        }),
      );
      await app.eval(
        `window.dispatchEvent(new KeyboardEvent('keydown',{key:'w',metaKey:/Mac/.test(navigator.platform),ctrlKey:!/Mac/.test(navigator.platform),bubbles:true}))`,
      );
    }
  } catch (error) {
    throw new Error(
      `${stage}: ${String(error)}\n${app.getOutput().slice(-5000)}`,
    );
  }
  expect(app.getRendererErrors()).toEqual([]);
});
