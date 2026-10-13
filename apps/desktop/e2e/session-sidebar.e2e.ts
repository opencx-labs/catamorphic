import fs from "node:fs/promises";
import path from "node:path";
import { nativeGit } from "@catamorphic/git";
import { afterAll, beforeAll, expect, it } from "vitest";
import { DEFAULT_WORKSPACE_CONFIG } from "../src/main/workspace-config.js";
import { type AppHandle, launchApp } from "./harness.js";

/**
 * "This session" (ADR 0225): a right-sidebar tab that exists only while a
 * chat is in front, showing where the chat works and the pull requests its
 * agent recorded in the session's metadata with set_session_metadata. The
 * fake agent calls the real tool through discovery, as a model would.
 */

let app: AppHandle;
let projectId: string;
let sessionId: string;
let base: string;
const visible = '[data-workspace-visible="true"]';
const right = `${visible} [data-sidebar="right"]`;
const thisSessionTab = `${right} [role="tab"][aria-label="This session"]`;
const details = `${right} [data-sidebar-widget="session"] [data-session-details]`;
const pullRequest = "https://git.invalid/acme/web/pull/42";
const selectedRightTab = () =>
  app.eval<string | null>(
    `document.querySelector('${right} [role="tab"][aria-selected="true"]')?.getAttribute('aria-label') ?? null`,
  );

const send = async (text: string) => {
  const response = await fetch(`${base}/${sessionId}/commands`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      type: "send",
      commandId: crypto.randomUUID(),
      text,
    }),
  });
  expect(response.status).toBe(200);
};
const openChat = () =>
  app.eval(
    `document.querySelector('${visible} [data-sidebar="left"] [data-sidebar-item-id="${sessionId}"] [data-tree-primary]').click()`,
  );

beforeAll(async () => {
  app = await launchApp();
  await app.waitFor(`!!document.querySelector('[data-sidebar="left"]')`);
  // A repository with a commit, so the chat can have its own worktree.
  const root = path.join(app.userDataDir, "session-sidebar");
  await fs.mkdir(root, { recursive: true });
  await nativeGit(root, ["init", "-b", "main"]);
  await fs.writeFile(path.join(root, "README.md"), "Session sidebar\n");
  await nativeGit(root, ["add", "."]);
  await nativeGit(root, [
    "-c",
    "user.name=Test",
    "-c",
    "user.email=test@example.invalid",
    "commit",
    "-m",
    "Initial",
  ]);
  const project = await app.eval<{ id: string }>(
    // The folder already holds the repository: open it as it is.
    `window.catamorphicDesktop.createProject({name:'Session sidebar',rootPath:${JSON.stringify(root)},importExisting:true})`,
  );
  projectId = project.id;
  const server = await app.eval<{ url: string }>(
    "window.catamorphicDesktop.getServerState()",
  );
  base = `${server.url}/api/projects/${projectId}/agent/sessions`;
  const response = await fetch(base, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ title: "Ship the sidebar", source: "desktop" }),
  });
  expect(response.status).toBe(201);
  const session: unknown = await response.json();
  if (
    !session ||
    typeof session !== "object" ||
    !("id" in session) ||
    typeof session.id !== "string"
  )
    throw new Error("The session has no id");
  sessionId = session.id;
  // Chosen before its first message: that turn checks the worktree out.
  await app.eval(
    `window.catamorphicDesktop.sessionUseOwnWorktree(${JSON.stringify({ projectId, sessionId })})`,
  );
  await app.reload();
  await app.waitFor(
    `!!document.querySelector('${visible} [data-sidebar-item-id="${sessionId}"]')`,
    { timeoutMs: 60_000, label: "the chat listed" },
  );
  await app.eval(
    `document.querySelector('${visible} [aria-label="Expand right sidebar"]')?.click()`,
  );
  await app.waitFor(
    `document.querySelector('${right}')?.getAttribute('aria-hidden') === 'false'`,
    { label: "right sidebar open" },
  );
});

afterAll(async () => {
  await app?.stop();
});

it("offers This session only beside a chat, without taking the panel", async () => {
  expect(await app.eval(`!!document.querySelector('${thisSessionTab}')`)).toBe(
    false,
  );
  const before = await selectedRightTab();
  await openChat();
  await app.waitFor(`!!document.querySelector('${thisSessionTab}')`, {
    label: "This session arrives with the chat",
  });
  // Arriving never changes the tab the person was looking at.
  expect(await selectedRightTab()).toBe(before);
  // It leads the strip.
  expect(
    await app.eval(
      `document.querySelector('${right} [role="tab"]')?.getAttribute('aria-label')`,
    ),
  ).toBe("This session");
  // With no choice of the person's on offer while a chat is in front (the
  // tab they chose is gone from the file), the panel still opens on a tab
  // that stays, not on This session at the head of the strip.
  const file = await app.eval<string>(
    "window.catamorphicDesktop.workspaceConfigFile()",
  );
  const config = structuredClone(DEFAULT_WORKSPACE_CONFIG);
  const activity = config.sidebars.right.find((tab) => tab.id === "companion");
  if (!activity) throw new Error("The default right sidebar has no Activity");
  activity.id = "companion-renamed";
  await fs.writeFile(file, `module.exports = ${JSON.stringify(config)};\n`);
  await app.waitFor(
    `!document.querySelector('${right} [data-sidebar-widget="activity"]')?.closest('[role="tabpanel"]')?.hidden`,
    { label: "the renamed Activity tab shown" },
  );
  expect(await selectedRightTab()).toBe("Activity");
  await fs.writeFile(
    file,
    `module.exports = ${JSON.stringify(DEFAULT_WORKSPACE_CONFIG)};\n`,
  );
  await app.waitFor(
    `!!document.querySelector('${right} [aria-controls$="-panel-companion"]')`,
    { label: "the default layout back" },
  );
});

it("shows the chat's worktree and a pull request its agent records, live", async () => {
  await app.eval(`document.querySelector('${thisSessionTab}').click()`);
  await app.waitFor(
    `document.querySelector('${thisSessionTab}')?.getAttribute('aria-selected') === 'true'`,
  );
  await send("record pr: 42 open");
  await app.waitFor(
    `!!document.querySelector('${details} [data-sidebar-item-id="${pullRequest}"]')`,
    { timeoutMs: 60_000, label: "the recorded pull request" },
  );
  expect(
    await app.eval(
      `document.querySelector('${details} [data-sidebar-item-id="${pullRequest}"]').textContent`,
    ),
  ).toContain("Show this session beside the chat");
  // The first turn checked out the chat's own worktree on its branch.
  await app.waitFor(
    `document.querySelector('${details} [data-sidebar-item-id="folder"]')?.textContent.includes('work/')`,
    { timeoutMs: 60_000, label: "the chat's own worktree" },
  );
  // The agent updates the state; the row follows without a reload.
  await send("record pr: 42 merged");
  await app.waitFor(
    `document.querySelector('${details} [data-sidebar-item-id="${pullRequest}"]')?.textContent.includes('Merged')`,
    { timeoutMs: 60_000, label: "the merged state" },
  );
  const metadata = await fetch(`${base}/${sessionId}`).then(
    (response) =>
      response.json() as Promise<{
        snapshot: { session: { metadata: Record<string, unknown> } };
      }>,
  );
  expect(metadata.snapshot.session.metadata).toEqual({
    pull_requests: [
      {
        url: pullRequest,
        number: 42,
        title: "Show this session beside the chat",
        state: "merged",
      },
    ],
  });
});

it("stays while the person looks at a pull request the chat opened", async () => {
  const browserTabs = () =>
    app.eval<number>(
      `document.querySelectorAll('${visible} [data-point-key^="browser:"]').length`,
    );
  const before = await browserTabs();
  await app.eval(
    `document.querySelector('${details} [data-sidebar-item-id="${pullRequest}"] [data-tree-primary]').click()`,
  );
  // The page opens in a tab of the chat's: the chat's session stays beside
  // it, so This session and the row the person clicked stay where they were.
  await app.waitFor(
    `document.querySelectorAll('${visible} [data-point-key^="browser:"]').length > ${before}`,
    { label: "the pull request's page opened", timeoutMs: 30_000 },
  );
  expect(
    await app.eval(
      `document.querySelector('${thisSessionTab}')?.getAttribute('aria-selected')`,
    ),
  ).toBe("true");
  expect(
    await app.eval(
      `!!document.querySelector('${details} [data-sidebar-item-id="${pullRequest}"]') && !document.querySelector('${right} [data-sidebar-tab-leaving]')`,
    ),
  ).toBe(true);
  await openChat();
  await app.waitFor(
    `document.querySelector('${thisSessionTab}')?.getAttribute('aria-selected') === 'true'`,
  );
});

it("leaves with the chat, and comes back to the person's choice", async () => {
  await app.eval(
    `document.querySelector('${visible} [aria-label="New tab"]').click()`,
  );
  await app.waitFor(`!document.querySelector('${thisSessionTab}')`, {
    label: "This session leaves when the chat is not in front",
  });
  // The panel falls back to a tab that stays.
  await app.waitFor(
    `!!document.querySelector('${right} [role="tab"][aria-selected="true"]')`,
  );
  expect(await selectedRightTab()).not.toBe("This session");
  await app.waitFor(
    `!document.querySelector('${right} [data-sidebar-tab-leaving]')`,
    { label: "the leaving tab is gone" },
  );
  await openChat();
  await app.waitFor(
    `document.querySelector('${thisSessionTab}')?.getAttribute('aria-selected') === 'true'`,
    { label: "This session is back, still chosen" },
  );
  await app.waitFor(
    `!!document.querySelector('${details} [data-sidebar-item-id="${pullRequest}"]')`,
  );
});

it("turns back from a quick change on the same tab", async () => {
  // Away and straight back, inside one motion: the tab that was leaving
  // returns as the same element, and nothing is left leaving.
  await app.eval(`(() => {
    window.__thisSessionTab = document.querySelector('${thisSessionTab}');
    document.querySelector('${visible} [aria-label="New tab"]').click();
  })()`);
  await app.waitFor(
    `!!document.querySelector('${right} [data-sidebar-tab-leaving]')`,
    { label: "This session leaving" },
  );
  await openChat();
  await app.waitFor(
    `document.querySelector('${thisSessionTab}') === window.__thisSessionTab && !document.querySelector('${right} [data-sidebar-tab-leaving]') && !document.querySelector('${right} .sidebar-tab-slot-leaving, ${right} .sidebar-strip-folding')`,
    { label: "the same tab back, settled" },
  );
  expect(app.getRendererErrors()).toEqual([]);
});
