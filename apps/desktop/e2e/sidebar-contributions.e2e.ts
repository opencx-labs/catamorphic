import { execFileSync } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { buildAppGuestDocument } from "@catamorphic/app";
import { afterAll, beforeAll, expect, it } from "vitest";
import { type AppHandle, launchApp } from "./harness.js";

let app: AppHandle;
let base: string;
let parentId: string;
let childId: string;
let file: string;
let guestServer: http.Server;
let guestUrl: string;
beforeAll(async () => {
  app = await launchApp();
  const bundle = path.join(app.userDataDir, "agent-widget.js");
  execFileSync(
    "bun",
    [
      "build",
      path.join(import.meta.dirname, "fixtures/agent-sidebar-widget-entry.tsx"),
      "--target",
      "browser",
      "--format",
      "iife",
      "--outfile",
      bundle,
    ],
    { cwd: path.join(import.meta.dirname, "../../..") },
  );
  const code = fs.readFileSync(bundle, "utf8");
  guestServer = http.createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    response.setHeader("Content-Type", "text/html");
    response.end(
      buildAppGuestDocument({
        code,
        css: "",
        theme: JSON.parse(url.searchParams.get("theme") ?? "null") ?? undefined,
      }),
    );
  });
  await new Promise<void>((resolve) =>
    guestServer.listen(0, "127.0.0.1", resolve),
  );
  const address = guestServer.address();
  if (!address || typeof address === "string")
    throw new Error("Guest fixture did not listen");
  guestUrl = `http://127.0.0.1:${address.port}/agent-monitor`;
  // Only the built-app lookup is a fixture. The actual sandbox, display bridge,
  // source adapter, session reads and action execution run in the desktop.
  await app.cdp("Page.addScriptToEvaluateOnNewDocument", {
    source: `(() => {
    const original = window.fetch;
    window.fetch = (input, init) => {
      const url = typeof input === 'string' ? input : input.url ?? String(input);
      if (url.includes('/apps/agent-monitor/view-state')) return Promise.resolve(new Response(JSON.stringify({state:'ready', appId:'a1b2c3d4-e5f6-4890-abcd-ef1234567890', versionId:'b2c3d4e5-f6a7-4890-bcde-a12345678901', guestUrl:${JSON.stringify(guestUrl)}}), {headers:{'Content-Type':'application/json'}}));
      return original(input, init);
    };
  })()`,
  });
  await app.waitFor(`!!document.querySelector('[data-sidebar="left"]')`);
  const project = await app.eval<{ id: string }>(
    `window.catamorphicDesktop.createProject({name:'Sidebar primitives',rootPath:${JSON.stringify(path.join(app.userDataDir, "sidebar-primitives"))}})`,
  );
  file = await app.eval<string>(
    "window.catamorphicDesktop.sidebarConfigFile()",
  );
  fs.copyFileSync(
    path.join(import.meta.dirname, "fixtures/agent-sidebar.cjs"),
    file,
  );
  const server = await app.eval<{ url: string }>(
    "window.catamorphicDesktop.getServerState()",
  );
  base = `${server.url}/api/projects/${project.id}/agent/sessions`;
  const response = await fetch(base, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ title: "Parent planning", source: "desktop" }),
  });
  expect(response.status).toBe(201);
  const parent = await response.json();
  if (
    !parent ||
    typeof parent !== "object" ||
    !("id" in parent) ||
    typeof parent.id !== "string"
  )
    throw new Error("Parent did not return an id");
  parentId = parent.id;
  await app.eval("location.reload()");
  try {
    await app.waitFor(
      `!!document.querySelector('[data-sidebar-item-id="${parentId}"]')`,
    );
  } catch (error) {
    await app.screenshot("/tmp/catamorphic-sidebar-failure.png");
    throw new Error(
      `${String(error)} ERRORS=${JSON.stringify(app.getRendererErrors())} ${await app.eval("document.body.innerText")} API=${JSON.stringify(await fetch(`${base}?rootsOnly=true`).then((response) => response.json()))}`,
    );
  }
});
afterAll(async () => {
  await app?.stop();
  await new Promise<void>((resolve) => guestServer?.close(() => resolve()));
});

it("loads the real Codex-authored tree and independent right-click menu", async () => {
  expect(
    await app.eval(
      `!!document.querySelector('[role="tab"][aria-label="Focused chat"]')`,
    ),
  ).toBe(false);
  await app.eval(
    `document.querySelector('[role="tab"][aria-label="Docs"]').click()`,
  );
  await app.waitFor(
    `!!document.querySelector('[data-sidebar-item-id="docs-mdn"]')`,
  );
  expect(
    await app.eval(
      `!!document.querySelector('[data-sidebar-item-id="docs-mdn"] [aria-haspopup="menu"]')`,
    ),
  ).toBe(false);
  await app.eval(
    `document.querySelector('[data-sidebar-item-id="docs-mdn"]').dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,cancelable:true,clientX:160,clientY:180}))`,
  );
  await app.waitFor(`!!document.querySelector('[data-sidebar-menu]')`);
  expect(
    await app.eval(
      `[...document.querySelectorAll('[data-sidebar-menu] [role="menuitem"]')].map(node=>node.textContent.trim())`,
    ),
  ).toEqual(["Copy URL"]);
  await app.waitFor(
    `document.querySelector("[data-sidebar-menu]")?.getAnimations({subtree:true}).every(animation => animation.playState === "finished")`,
  );
  await app.screenshot("/tmp/catamorphic-sidebar-custom-menu.png");
  await app.press("Escape");
  await app.waitFor(`!document.querySelector('[data-sidebar-menu]')`);
  await app.eval(
    `document.querySelector('[role="tab"][aria-label="Project"]').click()`,
  );
});

it("discovers children lazily and updates a hidden contextual section", async () => {
  await app.eval(
    `document.querySelector('[data-sidebar-item-id="${parentId}"] [data-tree-primary]').click()`,
  );
  await app.waitFor(
    `!!document.querySelector('[role="tab"][aria-label="Focused chat"]')`,
  );
  await app.eval(
    `document.querySelector('[aria-label="Expand right sidebar"]')?.click(); document.querySelector('[role="tab"][aria-label="Focused chat"]').click()`,
  );
  await app.waitFor(
    `document.querySelector('[data-sidebar-widget="subsessions"]')?.hidden === true`,
  );
  const response = await fetch(base, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      title: "Research child",
      parentSessionId: parentId,
      source: "desktop",
    }),
  });
  expect(response.status).toBe(201);
  const child = await response.json();
  if (
    !child ||
    typeof child !== "object" ||
    !("id" in child) ||
    typeof child.id !== "string"
  )
    throw new Error("Child did not return an id");
  childId = child.id;
  await app.waitFor(
    `document.querySelector('[data-sidebar-widget="subsessions"]')?.hidden === false && !!document.querySelector('[data-sidebar-widget="subsessions"] [data-sidebar-item-id="${childId}"]')`,
  );
  expect(
    await app.eval(
      `!!document.querySelector('[data-sidebar-widget="subsessions"] [aria-label="Open beside chat"]:not(:disabled)')`,
    ),
  ).toBe(true);
  await app.eval(
    `document.querySelector('[data-sidebar-widget="subsessions"] [data-sidebar-item-id="${childId}"]').dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,cancelable:true,clientX:1100,clientY:170}))`,
  );
  await app.waitFor(`!!document.querySelector('[data-sidebar-menu]')`);
  expect(
    await app.eval(
      `[...document.querySelectorAll('[data-sidebar-menu] [role="menuitem"]')].map(node=>({label:node.textContent.trim(),disabled:node.disabled}))`,
    ),
  ).toEqual([
    { label: "Open floating", disabled: false },
    { label: "Archive", disabled: false },
  ]);
  await app.waitFor(
    `document.querySelector("[data-sidebar-menu]")?.getAnimations({subtree:true}).every(animation => animation.playState === "finished")`,
  );
  await app.screenshot("/tmp/catamorphic-sidebar-contextual.png");
  await app.press("Escape");
  await app.waitFor(`!document.querySelector('[data-sidebar-menu]')`);
  await app.eval(
    `document.querySelector('[data-sidebar-widget="subsessions"] [aria-label="More actions for Research child"]').click()`,
  );
  await app.waitFor(`!!document.querySelector('[data-sidebar-menu]')`);
  expect(
    await app.eval(
      `[...document.querySelectorAll('[data-sidebar-menu] [role="menuitem"]')].map(node=>node.textContent.trim())`,
    ),
  ).toEqual(["Open in new tab"]);
  await app.press("Escape");
  await app.waitFor(`!document.querySelector('[data-sidebar-menu]')`);
  expect(app.getRendererErrors()).toEqual([]);
});

it("suspends expanded child IO when the whole section is collapsed", async () => {
  const response = await fetch(base, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      title: "Nested research",
      parentSessionId: childId,
      source: "desktop",
    }),
  });
  expect(response.status).toBe(201);
  await app.eval(
    "performance.setResourceTimingBufferSize(5000); performance.clearResourceTimings()",
  );
  const branchReads = `performance.getEntriesByType('resource').filter(entry => new URL(entry.name).searchParams.get('parentSessionId') === ${JSON.stringify(childId)}).length`;
  await app.waitFor(
    `!!document.querySelector('[data-sidebar-widget="subsessions"] [aria-label="Expand Research child"]')`,
  );
  await app.eval(
    `document.querySelector('[data-sidebar-widget="subsessions"] [aria-label="Expand Research child"]').click()`,
  );
  await app.waitFor(
    `document.querySelector('[data-sidebar-widget="subsessions"]').textContent.includes('Nested research') && ${branchReads} > 0`,
  );
  await app.eval(
    `document.querySelector('[data-sidebar-widget="subsessions"] .sidebar-section > div > button').click()`,
  );
  const before = await app.eval<number>(branchReads);
  await app.eval("new Promise(resolve => setTimeout(resolve, 2200))");
  expect(await app.eval<number>(branchReads)).toBe(before);
  await app.eval(
    `document.querySelector('[data-sidebar-widget="subsessions"] .sidebar-section > div > button').click()`,
  );
  await app.waitFor(
    `${branchReads} > ${before} && document.querySelector('[data-sidebar-widget="subsessions"]').textContent.includes('Nested research')`,
  );
  expect(app.getRendererErrors()).toEqual([]);
});

it("mounts the real Codex-authored live widget through the sandboxed app bridge", async () => {
  const source = fs.readFileSync(file, "utf8");
  fs.writeFileSync(
    file,
    `${source}\nmodule.exports.right.find(tab => tab.id === "focused-chat").sections = module.exports.right.find(tab => tab.id === "focused-chat").sections.filter(section => section.id !== "agent-monitor"); module.exports.right.find(tab => tab.id === "focused-chat").sections.push({id:"agent-monitor",type:"app",app:"agent-monitor",title:"Agent monitor",height:320,hideEmpty:true,collections:["subsessions"]});\n`,
  );
  try {
    await app.waitFor(
      `!!document.querySelector('[data-sidebar-widget="agent-monitor"] iframe')`,
    );
  } catch (cause) {
    throw new Error(
      `${String(cause)} ERRORS=${JSON.stringify(app.getRendererErrors())} BODY=${await app.eval("document.body.innerText")}`,
    );
  }
  const frame = await app.connectToFrame("/agent-monitor");
  try {
    await frame.waitFor(`document.body.innerText.includes('Research child')`);
    expect(
      await frame.eval(
        `!!document.querySelector('[aria-label="Open to the side"]') || !!document.querySelector('button svg')`,
      ),
    ).toBe(true);
    await frame.eval(
      `document.querySelector('[data-collection-item] .cat-collection-label').focus(); document.querySelector('[data-collection-item] .cat-collection-label').click()`,
    );
    await frame.waitFor(
      `!!document.querySelector('[aria-label="Session inspector"]')`,
    );
    await app.screenshot("/tmp/catamorphic-sidebar-agent-widget.png");
    expect(
      await app.eval(
        `document.querySelector('[data-sidebar-widget="agent-monitor"] iframe').getAttribute('sandbox')`,
      ),
    ).not.toContain("allow-same-origin");
    expect(app.getRendererErrors()).toEqual([]);
  } finally {
    frame.close();
  }
});
