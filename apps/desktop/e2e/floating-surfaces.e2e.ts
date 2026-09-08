import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type AppHandle, launchApp, setReactValueJs } from "./harness.js";

let app: AppHandle;
let origin: string;
const server = http.createServer((request, response) => {
  response.setHeader("Content-Type", "text/html");
  response.end(
    `<title>${request.url === "/anchor" ? "Anchor page" : "Preview page"}</title><a id="preview" href="/preview">Preview this link</a><a id="popup" href="/popup" target="_blank">Open another page</a><input id="draft" aria-label="Page draft"><script>window.pageIdentity=crypto.randomUUID()</script>`,
  );
});
const run = <T>(body: string) =>
  app.eval<T>(
    `(() => { ${setReactValueJs}\n const $=s=>document.querySelector(s); ${body} })()`,
  );
const key = (value: string, mods: Record<string, boolean> = {}) =>
  app.eval(
    `window.dispatchEvent(new KeyboardEvent('keydown',{key:${JSON.stringify(value)},bubbles:true,...${JSON.stringify(mods)}}))`,
  );
const click = (label: string) =>
  run(`$('button[aria-label=${JSON.stringify(label)}]').click()`);
const prefs = (patch: Record<string, unknown>) =>
  app.eval(
    `new Promise((resolve,reject)=>{const api=window.catamorphicDesktop;const stop=api.onPrefsChanged(value=>{stop();requestAnimationFrame(()=>resolve(value))});api.setPrefs(${JSON.stringify(patch)}).catch(reject)})`,
  );
const bindings = (patch: Record<string, string>) =>
  app.eval(
    `new Promise((resolve,reject)=>{const api=window.catamorphicDesktop;const stop=api.onKeybindingsChanged(value=>{stop();requestAnimationFrame(()=>resolve(value))});api.getKeybindings().then(current=>api.setKeybindings({...current,...${JSON.stringify(patch)}})).catch(reject)})`,
  );
const floating = "document.querySelector('[data-floating-surface]')";
const paneGuest = () =>
  run<number>("return $('[data-floating-surface] webview').getWebContentsId()");

beforeAll(async () => {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("No fixture port");
  origin = `http://127.0.0.1:${address.port}`;
  app = await launchApp();
  await app.waitFor(
    "[...document.querySelectorAll('button')].some(b=>b.textContent.trim()==='New project')",
  );
  await run(
    "[...document.querySelectorAll('button')].find(b=>b.textContent.trim()==='New project').click()",
  );
  await app.waitFor(
    "!!document.querySelector('[data-testid=project-name-input]')",
  );
  await run(
    "setReactValue($('[data-testid=project-name-input]'),'Floating workspace')",
  );
  await app.waitFor(
    "!document.querySelector('[data-testid=project-submit]').disabled",
  );
  await run("$('[data-testid=project-submit]').click()");
  await app.waitFor(
    "!!document.querySelector('textarea[placeholder*=\"Search or ask\"]')",
  );
  await app.eval(
    "window.catamorphicDesktop.setPrefs({tabPlacement:'sidebar',headerPlacement:'sidebar'})",
  );
  await run(
    `setReactValue($('textarea[placeholder*="Search or ask"]'),${JSON.stringify(`${origin}/anchor`)})`,
  );
  await app.press("Enter");
  await app.waitFor(
    "[...document.querySelectorAll('webview')].some(v=>{try{return v.getTitle()==='Anchor page'}catch{return false}})",
  );
  await app.eval(
    "window.__terminalIds=[];window.catamorphicDesktop.onTerminalData(({sessionId})=>{if(!window.__terminalIds.includes(sessionId))window.__terminalIds.push(sessionId)})",
  );
});
afterAll(async () => {
  await app?.stop();
  server.close();
});

describe("floating surfaces", () => {
  it("keeps the same shell and runs the configured Git command only once through hide, expand and tile", async () => {
    const marker = path.join(app.userDataDir, "git-launch-count");
    const command = `printf 'launch\\n' >> '${marker.replaceAll("'", "'\\''")}'`;
    await prefs({ gitTerminalCommand: command });
    await bindings({ "toggle-floating-git": "Ctrl+Alt+G" });
    await app.waitFor(
      "window.catamorphicDesktop.getKeybindings().then(b=>b['toggle-floating-git']==='Ctrl+Alt+G')",
    );
    await key("g", { ctrlKey: true, altKey: true });
    await app.waitFor(`!!${floating} && window.__terminalIds.length===1`);
    await app.waitFor(
      "window.catamorphicDesktop.terminalBuffer(window.__terminalIds[0]).then(b=>b?.buffer.includes('printf'))",
    );
    const session = await app.eval<string>("window.__terminalIds[0]");
    // Window managers can issue a second resize immediately after the
    // first has rendered. The last width must win, even inside 50ms.
    expect(
      await app.eval(`(async () => {
        const host = document.querySelector('[data-floating-surface] [data-terminal-appearance]').firstElementChild;
        const canvas = host.querySelector('canvas');
        host.style.width = '1100px';
        const deadline = performance.now() + 2000;
        while (canvas.getBoundingClientRect().width < 1000 && performance.now() < deadline)
          await new Promise(requestAnimationFrame);
        const expanded = canvas.getBoundingClientRect().width >= 1000;
        host.style.width = '420px';
        return expanded;
      })()`),
    ).toBe(true);
    await app.waitFor(
      `(() => {
      const canvas = document.querySelector('[data-floating-surface] canvas');
      return canvas.getBoundingClientRect().width <= 420 && canvas.getBoundingClientRect().width > 360;
    })()`,
      { label: "terminal canvas fits the final rapid resize" },
    );
    await run(
      "$('[data-floating-surface] [data-terminal-appearance]').firstElementChild.style.width = ''",
    );
    expect(await run("return $('aside input').value")).toContain("/anchor");
    await click("Open as full tab");
    await app.waitFor(`!${floating}`);
    await key("g", { ctrlKey: true, altKey: true });
    await app.waitFor(`!!${floating}`);
    await click("Tile beside current tab");
    await app.waitFor("!!document.querySelector('[data-split-divider]')");
    await key("g", { ctrlKey: true, altKey: true });
    await app.waitFor(`!!${floating}`);
    await key("g", { ctrlKey: true, altKey: true });
    await app.waitFor(`!${floating}`);
    expect(await app.eval("window.__terminalIds")).toEqual([session]);
    await expect
      .poll(() => fs.existsSync(marker), { timeout: 20_000 })
      .toBe(true);
    expect(fs.readFileSync(marker, "utf8")).toBe("launch\n");
    expect(
      await app.eval(
        `window.catamorphicDesktop.terminalBuffer(${JSON.stringify(session)}).then(b=>b.running)`,
      ),
    ).toBe(true);
  });

  it("previews an Option-click link without navigating its anchor and preserves the guest when expanded", async () => {
    await run("$('aside [data-point-key^=\"browser:\"] button').click()");
    const guest = await app.connectToFrame(`${origin}/anchor`);
    const anchorIdentity = await guest.eval<string>("window.pageIdentity");
    const point = await guest.eval<{ x: number; y: number }>(
      "(()=>{const r=document.querySelector('#preview').getBoundingClientRect();return {x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)}})()",
    );
    await run(
      `const view=[...document.querySelectorAll('webview')].find(v=>v.getTitle()==='Anchor page');view.focus();return (async()=>{for(const type of ['mouseDown','mouseUp'])await view.sendInputEvent({type,button:'left',clickCount:1,modifiers:['alt'],...${JSON.stringify(point)}})})()`,
    );

    await app.waitFor(`!!${floating}?.querySelector('webview')`);
    await app.waitFor(
      "(()=>{try{return document.querySelector('[data-floating-surface] webview').getTitle()==='Preview page'}catch{return false}})()",
    );
    const id = await paneGuest();
    expect(await run("return $('aside input').value")).toContain("/anchor");
    expect(
      await run("return $('[data-floating-surface] input').value"),
    ).toContain("/preview");
    const preview = await app.connectToFrame(`${origin}/preview`);
    const identity = await preview.eval<string>("window.pageIdentity");
    await preview.eval(
      "document.querySelector('#draft').value='Keep this draft'",
    );
    await click("Open as full tab");
    await app.waitFor(`!${floating}`);
    expect(
      await run(
        `return [...document.querySelectorAll('webview')].some(v=>v.getWebContentsId()===${id})`,
      ),
    ).toBe(true);
    expect(
      await preview.eval(
        "({identity:window.pageIdentity,draft:document.querySelector('#draft').value})",
      ),
    ).toEqual({ identity, draft: "Keep this draft" });
    expect(
      await guest.eval("({url:location.href,identity:window.pageIdentity})"),
    ).toEqual({ url: `${origin}/anchor`, identity: anchorIdentity });
    preview.close();
    guest.close();
  });

  it("uses the configured popup mode and opens Settings as a scrollable floating panel", async () => {
    await prefs({ linkOpenMode: "floating" });
    const guest = await app.connectToFrame(`${origin}/preview`);
    await guest.eval("document.querySelector('#popup').click()");
    await app.waitFor(`!!${floating}?.querySelector('webview')`);
    await app.waitFor(
      "(()=>{try{return document.querySelector('[data-floating-surface] webview').getURL().endsWith('/popup')}catch{return false}})()",
    );
    await click("Close floating tab");
    await app.waitFor(`!${floating}`);
    await bindings({ "open-floating-settings": "Ctrl+Alt+S" });
    await app.waitFor(
      "window.catamorphicDesktop.getKeybindings().then(b=>b['open-floating-settings']==='Ctrl+Alt+S')",
    );
    await key("s", { ctrlKey: true, altKey: true });
    await app.waitFor(
      `!!${floating}?.querySelector('select[name=linkOpenMode]')`,
    );
    expect(
      await run(
        "return $('[data-floating-surface] select[name=linkOpenMode]').value",
      ),
    ).toBe("floating");
    await run(
      "$('[data-floating-surface] select[name=linkOpenMode]').closest('section').scrollIntoView()",
    );
    expect(
      await run(
        "const p=$('[data-floating-surface]');const r=p.getBoundingClientRect();return r.top>=0 && r.bottom<=innerHeight && p.querySelector('h1').parentElement.parentElement.scrollHeight>p.clientHeight",
      ),
    ).toBe(true);
    await click("Open as full tab");
    await app.waitFor(`!${floating}`);
    expect(await run("return !!$('select[name=linkOpenMode]')")).toBe(true);
    await run(
      "const heading=[...document.querySelectorAll('h1')].find(e=>e.textContent==='Settings');heading.parentElement.parentElement.scrollTop=0;heading.tabIndex=-1;heading.focus()",
    );
    await app.press("PageDown");
    await app.waitFor(
      "[...document.querySelectorAll('h1')].find(e=>e.textContent==='Settings').parentElement.parentElement.scrollTop>0",
    );

    guest.close();
  });
  it("honors remapped and disabled shortcuts inside a browser guest", async () => {
    await run(
      "[...document.querySelectorAll('aside [data-point-key^=\"browser:\"]')].find(e=>e.textContent.includes('Anchor page')).querySelector('button').click()",
    );
    await bindings({ "toggle-floating-terminal": "Ctrl+Alt+J" });
    await app.eval(
      "window.__guestKeys=[];window.catamorphicDesktop.onBrowserGuestKey(key=>window.__guestKeys.push(key))",
    );
    const send = () =>
      run(
        "const view=[...document.querySelectorAll('webview')].find(v=>v.getTitle()==='Anchor page');view.focus();return view.sendInputEvent({type:'keyDown',keyCode:'J',modifiers:['control','alt']})",
      );
    await send();
    await app.waitFor(`!!${floating} && window.__guestKeys.length>0`);
    await click("Hide floating panel");
    await app.waitFor(`!${floating}`);
    const count = await app.eval<number>("window.__guestKeys.length");
    await bindings({ "toggle-floating-terminal": "" });
    const guest = await app.connectToFrame(`${origin}/anchor`);
    await guest.eval(
      "window.__pageKeys=0;window.addEventListener('keydown',()=>window.__pageKeys++)",
    );
    await send();
    await guest.waitFor("window.__pageKeys>0");
    expect(await app.eval("window.__guestKeys.length")).toBe(count);
    expect(await app.eval(`!!${floating}`)).toBe(false);
    guest.close();
  });
  it("floats the current browser with its shortcut and preserves the page when expanded", async () => {
    await run(
      "[...document.querySelectorAll('aside [data-point-key^=\"browser:\"]')].find(e=>e.textContent.includes('Anchor page')).querySelector('button').click()",
    );
    const guest = await app.connectToFrame(`${origin}/anchor`);
    const identity = await guest.eval<string>("window.pageIdentity");
    await key("f", { metaKey: true, altKey: true });
    await app.waitFor(`!!${floating}?.querySelector('webview')`);
    expect(
      await run("return $('[data-floating-surface] webview').getTitle()"),
    ).toBe("Anchor page");
    await click("Open as full tab");
    await app.waitFor(`!${floating}`);
    expect(await guest.eval("window.pageIdentity")).toBe(identity);
    guest.close();
  });
  it("opens regular palette entries as floating with the remapped shortcut, without duplicate commands", async () => {
    await bindings({ "float-current-tab": "Alt+Enter" });
    const choose = async (query: string, item: string) => {
      await key("p", { metaKey: true });
      await app.waitFor(
        "!!document.querySelector('textarea[placeholder*=\"Search or ask\"]:not([inert])')",
      );
      await run(
        `setReactValue($('textarea[placeholder*="Search or ask"]'),${JSON.stringify(query)});$('textarea[placeholder*="Search or ask"]').focus()`,
      );
      await app.waitFor(
        `document.querySelector('[data-item-id="${item}"]')?.getAttribute('aria-selected')==='true'`,
      );
    };
    await choose("Settings", "tab:settings");
    expect(
      await run(
        "return !!$('[data-item-id=\"action:open-floating-settings\"]')",
      ),
    ).toBe(false);
    await app.press("Enter", 1);
    await app.waitFor(
      `!!${floating}?.querySelector('select[name=terminalAppearance]')`,
    );
    await click("Close floating tab");
    await choose("New terminal", "action:new-terminal-tab");
    expect(
      await run(
        "return !!$('[data-item-id=\"action:toggle-floating-terminal\"]')",
      ),
    ).toBe(false);
    await app.press("Enter", 1);
    await app.waitFor(`!!${floating}?.querySelector('canvas')`);
    await click("Close floating tab");
    await choose(`${origin}/palette-preview`, "web");
    await app.press("Enter", 1);
    await app.waitFor(`!!${floating}?.querySelector('webview')`);
    await app.waitFor(
      "(()=>{try{return document.querySelector('[data-floating-surface] webview').getURL().endsWith('/palette-preview')}catch{return false}})()",
    );
    await click("Close floating tab");
    await choose("Settings", "tab:settings");
    await app.press("Enter");
    await app.waitFor(
      "!!document.querySelector('select[name=terminalAppearance]')",
    );
    expect(await app.eval(`!!${floating}`)).toBe(false);
  });
});
