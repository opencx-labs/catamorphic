import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { afterAll, beforeAll, expect, it } from "vitest";
import { type AppHandle, launchApp, setReactValueJs } from "./harness.js";

let app: AppHandle;
let projectId: string;
let chatId: string;
let serial = 0;
let origin: string;
const server = http.createServer((_request, response) => {
  response.setHeader("Content-Type", "text/html");
  response.end("<title>Group reference</title><p>A local reference</p>");
});
const helpers = `${setReactValueJs}
  const $ = s => document.querySelector(s);
  const chat = () => $('[data-chat-local-id="' + window.__provenanceChat + '"]');
  const composer = () => chat()?.querySelector('[data-composer-input]');
`;
const run = <T = unknown>(body: string) =>
  app.eval<T>(`(() => { ${helpers}\n${body} })()`);
const wait = (body: string, label: string) =>
  app.waitFor(`(() => { ${helpers}\nreturn ${body}; })()`, { label });

async function tool(name: string, input: Record<string, unknown>) {
  serial++;
  const prefix = `E2E result ${serial}: `;
  await run(
    `setReactValue(composer(), ${JSON.stringify(`E2E workspace tool ${JSON.stringify({ name, input, serial })}`)}); composer().closest('form').requestSubmit()`,
  );
  const result = await app.waitFor<string>(
    `(() => {
    const text = document.body.textContent;
    const start = text.lastIndexOf(${JSON.stringify(prefix)});
    return start < 0 ? false : text.slice(start + ${prefix.length}).split('E2E end')[0];
  })()`,
    { label: `${name} result`, timeoutMs: 30_000 },
  );
  return JSON.parse(result) as { key?: string };
}
async function asTab() {
  await run(
    "chat()?.querySelector('button[aria-label=\"Open as tab\"]')?.click()",
  );
  await wait("chat()?.hasAttribute('data-chat-tab')", "chat in tab strip");
}
async function selectChat() {
  await run(
    `$('[data-point-key="chat:${chatId}"] .workspace-tab-label').click()`,
  );
  await wait("!chat()?.hasAttribute('inert')", "chat active");
}
async function grouped(key: string) {
  await app.waitFor(
    `!!document.querySelector('[data-point-key=${JSON.stringify(key)}] [data-tab-group-eyebrow]')`,
    { label: `${key} in chat group` },
  );
  expect(
    await app.eval(
      `!!document.querySelector('[data-point-key="chat:${chatId}"] [data-tab-group-eyebrow]')`,
    ),
  ).toBe(true);
}
async function navigate(url: string, open?: "browser") {
  await app.eval(
    `window.catamorphicDesktop.workspaceNavigate(${JSON.stringify({ projectId, surface: { url, title: "Reference", mode: "tab", nonce: crypto.randomUUID(), ...(open ? { open } : {}) } })})`,
  );
}

beforeAll(async () => {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("No fixture port");
  origin = `http://127.0.0.1:${address.port}`;
  app = await launchApp();
  const root = path.join(app.userDataDir, "tab-provenance");
  const project = await app.eval<{ id: string }>(
    `window.catamorphicDesktop.createProject(${JSON.stringify({ name: "Chat tab groups", rootPath: root })})`,
  );
  projectId = project.id;
  fs.mkdirSync(root, { recursive: true });
  fs.writeFileSync(path.join(root, "existing.txt"), "An existing file.\n");
  fs.writeFileSync(path.join(root, "agent.txt"), "Opened by the agent.\n");
  await app.reload();
  await app.waitFor("!!document.querySelector('[data-workspace-ready]')");
  await navigate(origin, "browser");
  await app.waitFor(
    "!!document.querySelector('[data-point-key^=\"browser:\"]')",
  );
  await app.eval(
    "document.querySelector('[data-dock-rail] button[aria-label=\"New chat\"]').click()",
  );
  await app.waitFor(
    "!!document.querySelector('[data-floating-chat]:not([inert]) [data-composer-input]')",
  );
  chatId = await app.eval<string>(
    "document.querySelector('[data-floating-chat]:not([inert])').dataset.chatLocalId",
  );
  await app.eval(`window.__provenanceChat = ${JSON.stringify(chatId)}`);
  await tool("set_session_metadata", {
    key: "chips",
    value: [{ id: "reference", label: "Reference page", url: origin }],
  });
}, 180_000);
afterAll(async () => {
  await app?.stop();
  server.close();
});

it("an attached URL chip associates the already-open page, without duplicating it", async () => {
  await wait(
    "!!chat()?.querySelector('[data-chip-id=reference] [data-chip-main]')",
    "reference chip",
  );
  await run(
    "chat().querySelector('[data-chip-id=reference] [data-chip-main]').click()",
  );
  await asTab();
  const browsers = await app.eval<string[]>(
    "[...document.querySelectorAll('[data-point-key^=\"browser:\"]')].map(el => el.dataset.pointKey)",
  );
  expect(browsers).toHaveLength(1);
  await grouped(browsers[0]!);
});

it("a file chip associates the reused editor with the chat", async () => {
  await navigate("file:existing.txt");
  await app.waitFor(
    "!!document.querySelector('[data-point-key^=\"editor:\"]')",
  );
  const editor = await app.eval<string>(
    "document.querySelector('[data-point-key^=\"editor:\"]').dataset.pointKey",
  );
  await selectChat();
  await tool("set_session_metadata", {
    key: "chips",
    value: [{ id: "file", label: "Existing file", url: "file:existing.txt" }],
  });
  await wait(
    "!!chat()?.querySelector('[data-chip-id=file] [data-chip-main]')",
    "file chip",
  );
  await run(
    "chat().querySelector('[data-chip-id=file] [data-chip-main]').click()",
  );
  await grouped(editor);
  expect(
    await app.eval(
      "document.querySelectorAll('[data-point-key^=\"editor:\"]').length",
    ),
  ).toBe(1);
});

it("agent-created and existing-key surfaces keep their chat group across floating presentation", async () => {
  await selectChat();
  const created = await tool("open_surface", { target: "file:agent.txt" });
  expect(created.key).toMatch(/^editor:/);
  await asTab();
  await grouped(created.key!);
  await navigate(`${origin}/agent`, "browser");
  await app.waitFor(
    "document.querySelectorAll('[data-point-key^=\"browser:\"]').length === 2",
  );
  const browser = await app.eval<string>(
    "[...document.querySelectorAll('[data-point-key^=\"browser:\"]')].at(-1).dataset.pointKey",
  );
  await selectChat();
  await tool("open_surface", { target: browser });
  await asTab();
  await grouped(browser);
  expect(app.getRendererErrors()).toEqual([]);
});
