import fs from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, expect, it } from "vitest";
import { z } from "zod";
import { type AppHandle, launchApp } from "./harness.js";

let app: AppHandle;
let projectId: string;
let agentId: string;
beforeAll(async () => {
  app = await launchApp();
  await app.waitFor(`!!document.querySelector('[data-sidebar="left"]')`);
  const project = await app.eval<{ id: string }>(
    `window.catamorphicDesktop.createProject({name:'Local agent capabilities',rootPath:${JSON.stringify(`${app.userDataDir}/local-agent`)}})`,
  );
  projectId = project.id;
  const agent = await app.eval<{ id: string; mode: string; accepts: string[] }>(
    `window.catamorphicDesktop.agentsCreate({harness:'codex',auth:'local',name:'Codex audit'})`,
  );
  agentId = agent.id;
  expect(agent.mode).toBe("full-access");
  expect(agent.accepts).toEqual(["image", "document"]);
  await app.eval(
    `window.catamorphicDesktop.agentsSetProjectDefault(${JSON.stringify(projectId)},${JSON.stringify(agentId)})`,
  );
  await app.reload();
});
afterAll(async () => {
  await app?.stop();
});

it("accepts a screenshot into the Codex composer as native image media", async () => {
  await app.waitFor(
    `!!document.querySelector('textarea[placeholder*="Search or ask"]')`,
  );
  // A reloaded page can render before global shortcut bindings settle.
  // Open through the rendered control; this test covers media, not shortcuts.
  await app.waitFor(
    `!!document.querySelector('button[aria-label="New chat"]')`,
  );
  await app.eval(
    `document.querySelector('button[aria-label="New chat"]').click()`,
  );
  await app.waitFor(`!!document.querySelector('[data-composer-input]')`);
  expect(
    await app.eval(
      `document.querySelector('[data-composer-input]')?.getAttribute('data-placeholder') ?? ''`,
    ),
  ).not.toContain("text only");
  const image = path.join(app.userDataDir, "screenshot.png");
  fs.writeFileSync(
    image,
    Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aN1sAAAAASUVORK5CYII=",
      "base64",
    ),
  );
  const { root } = z
    .object({ root: z.object({ nodeId: z.number() }) })
    .parse(await app.cdp("DOM.getDocument"));
  const { nodeId } = z.object({ nodeId: z.number() }).parse(
    await app.cdp("DOM.querySelector", {
      nodeId: root.nodeId,
      selector: 'input[type="file"]',
    }),
  );
  await app.cdp("DOM.setFileInputFiles", { nodeId, files: [image] });
  await app.waitFor(
    `!!document.querySelector('[data-composer-input] [data-pill-id]')`,
  );
  expect(
    await app.eval(`document.querySelector('[data-composer-input]').innerText`),
  ).toContain("screenshot.png");
  // Media retains its bytes instead of falling back to a file-reference pill.
  await app.waitFor(
    `(async()=>{const id=document.querySelector('[data-chat-local-id]').dataset.chatLocalId;const draft=await window.catamorphicDesktop.dockDraftGet(id);return draft?.attachments?.[0]?.kind==='image'})()`,
  );
  expect(app.getRendererErrors()).toEqual([]);
});
it("keeps an explicitly selected restricted mode", async () => {
  const updated = await app.eval<{ mode: string }>(
    `window.catamorphicDesktop.agentsUpdate(${JSON.stringify(agentId)},{mode:'edit'})`,
  );
  expect(updated.mode).toBe("edit");
  await app.reload();
  const agents = await app.eval<{
    agents: Array<{ id: string; mode: string }>;
  }>(`window.catamorphicDesktop.agentsList()`);
  expect(agents.agents.find((agent) => agent.id === agentId)?.mode).toBe(
    "edit",
  );
});
