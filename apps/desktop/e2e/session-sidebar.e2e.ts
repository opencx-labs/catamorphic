import fs from "node:fs/promises";
import path from "node:path";
import { nativeGit } from "@catamorphic/git";
import { afterAll, beforeAll, expect, it } from "vitest";
import { DEFAULT_WORKSPACE_CONFIG } from "../src/main/workspace-config.js";
import type { WorkspaceConfig } from "../src/shared/workspace-config.js";
import {
  type AppHandle,
  createProjectWorkspace,
  launchApp,
} from "./harness.js";
import { CHATS_SECTION } from "./sidebar-config.js";

/**
 * A tab of `when: { session: true }` sections (ADR 0226, 0234) exists only
 * while a chat is in front. Here it shows `work:session`: where the chat
 * works and the pull requests its agent recorded in the session's metadata
 * with set_session_metadata. The fake agent calls the real tool through
 * discovery, as a model would.
 */
const LAYOUT: WorkspaceConfig = {
  sidebars: {
    left: [
      {
        ...DEFAULT_WORKSPACE_CONFIG.sidebars.left[0],
        id: "project",
        title: "Project",
        sections: [
          ...(DEFAULT_WORKSPACE_CONFIG.sidebars.left[0]?.sections ?? []),
          CHATS_SECTION,
        ],
      },
    ],
    right: [
      {
        id: "this-session",
        title: "This session",
        icon: "MessageSquareText",
        sections: [
          { id: "session", source: "work:session", when: { session: true } },
        ],
      },
      {
        id: "companion",
        title: "Activity",
        icon: "Activity",
        sections: [{ id: "activity", source: "work:activity" }],
      },
    ],
  },
};

let app: AppHandle;
let projectId: string;
let sessionId: string;
let base: string;
const visible = '[data-workspace-visible="true"]';
const right = `${visible} [data-sidebar="right"]`;
const thisSessionTab = `${right} [role="tab"][aria-label="This session"]`;
const details = `${right} [data-sidebar-widget="session"]`;
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
const chatRow = () =>
  `document.querySelector('${visible} [data-sidebar="left"] [data-sidebar-item-id="${sessionId}"] [data-tree-primary]')`;
const newTabButton = `document.querySelector('${visible} [aria-label="New tab"]')`;
/** The tab in front, by its key's kind: "chat", "browser", "palette". */
const frontTab = () =>
  app.eval<string | null>(
    `document.querySelector('${visible} [data-tab-active]')?.dataset.pointKey?.split(':')[0] ?? null`,
  );
const frontIs = (kind: string) =>
  `!!document.querySelector('${visible} [data-tab-active][data-point-key^="${kind}:"]')`;
/**
 * Clicks the chat's row and waits for the chat itself to be in front. This
 * session beside it is no sign of that: it also stays beside a page the
 * chat opened, so a wait on it alone returns while the chat is still on
 * its way and the next click races it.
 */
const openChat = async () => {
  await app.eval(`${chatRow()}.click()`);
  await app.waitFor(frontIs("chat"), { label: "the chat in front" });
};

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
  const project = await createProjectWorkspace({
    app,
    name: "Session sidebar",
    rootPath: root,
    importExisting: true,
  });
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
  await fs.writeFile(
    await app.eval<string>("window.catamorphicDesktop.workspaceConfigFile()"),
    `module.exports = ${JSON.stringify(LAYOUT)};\n`,
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
  const config = structuredClone(LAYOUT);
  const activity = config.sidebars.right.find((tab) => tab.id === "companion");
  if (!activity) throw new Error("The layout has no Activity");
  activity.id = "companion-renamed";
  await fs.writeFile(file, `module.exports = ${JSON.stringify(config)};\n`);
  await app.waitFor(
    `!document.querySelector('${right} [data-sidebar-widget="activity"]')?.closest('[role="tabpanel"]')?.hidden`,
    { label: "the renamed Activity tab shown" },
  );
  expect(await selectedRightTab()).toBe("Activity");
  await fs.writeFile(file, `module.exports = ${JSON.stringify(LAYOUT)};\n`);
  await app.waitFor(
    `!!document.querySelector('${right} [aria-controls$="-panel-companion"]')`,
    { label: "the layout back" },
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
    `!!document.querySelector('${details} [data-sidebar-item-id="${pullRequest}"]')?.querySelector('svg.lucide-git-merge')`,
    { timeoutMs: 60_000, label: "the merged state icon" },
  );
  // The number stays whole; the title gives way when the row is narrow.
  expect(
    await app.eval(`(() => {
      const row = document.querySelector('${details} [data-sidebar-item-id="${pullRequest}"]');
      const number = [...row.querySelectorAll('span')].find((span) => span.textContent === '#42');
      return !!number && number.scrollWidth <= number.clientWidth;
    })()`),
  ).toBe(true);
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
  await app.eval(`${newTabButton}.click()`);
  await app
    .waitFor(`!document.querySelector('${thisSessionTab}')`, {
      label: "This session leaves when the chat is not in front",
    })
    .catch(async (error: unknown) => {
      throw new Error(
        `${error instanceof Error ? error.message : String(error)}; in front: ${await frontTab()}`,
      );
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

it("keeps a New Tab opened right after the chat's row was clicked", async () => {
  // The person's latest action wins. The chat is in a workspace this
  // window holds, so its row's click brings it forward within the click,
  // without a read of the saved workspace from the main process first.
  // When it waited for that read, the chat arrived after whatever came
  // next: a New Tab opened then was closed as an untouched one, with the
  // chat in front. The two clicks here leave no time between them, so a
  // row that waits for anything is always overtaken.
  await app.eval(`(() => {
    ${chatRow()}.click();
    ${newTabButton}.click();
  })()`);
  // Time for a row that still waited on the main process to land: a read
  // asked for after its own, answered, and two frames drawn.
  await app.eval(`(async () => {
    await window.catamorphicDesktop.workspaceStateGet(${JSON.stringify(projectId)});
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  })()`);
  expect(await frontTab()).toBe("palette");
  await app.waitFor(`!document.querySelector('${thisSessionTab}')`, {
    label: "This session leaves with the chat behind the New Tab",
  });
  await app.waitFor(
    `!document.querySelector('${right} [data-sidebar-tab-leaving]')`,
    { label: "the leaving tab is gone" },
  );
  await openChat();
  await app.waitFor(
    `document.querySelector('${thisSessionTab}')?.getAttribute('aria-selected') === 'true' && !document.querySelector('${right} .sidebar-tab-slot-leaving, ${right} .sidebar-strip-folding, ${right} .sidebar-tab-slot-arriving')`,
    { label: "This session back, settled" },
  );
});

it("turns back from a quick change on the same tab", async () => {
  // Away and straight back, inside one motion: the tab that was leaving
  // returns as the same element, and nothing is left leaving. The way back
  // is clicked in the page the moment the tab starts leaving. Its chat
  // took longer than the 200 ms leave to come forward on a slow runner
  // (macOS CI, twice): the tab then finishes leaving and arrives again as
  // a new one, which is right too, but not this test's case. The row's
  // click waited on a read from the main process then; it no longer does
  // (the test above), but a slow runner has not been shown to draw the
  // chat within the leave every time. So such a round is still noted and
  // the change made again, up to three times; the reversal itself is also
  // covered on the component ("reverses a quick change back on the same
  // elements").
  let reversed = false;
  for (let round = 0; round < 3 && !reversed; round += 1) {
    await app.eval(`(async () => {
      const tab = document.querySelector('${thisSessionTab}');
      window.__quickChange = { tab, left: false };
      const leaving = () => document.querySelector('${right} [data-sidebar-tab-leaving]');
      const gone = new MutationObserver(() => {
        if (!tab.isConnected) { window.__quickChange.left = true; gone.disconnect(); }
      });
      gone.observe(document.body, { subtree: true, childList: true });
      const started = new Promise((resolve, reject) => {
        const observer = new MutationObserver(() => {
          if (leaving()) { observer.disconnect(); resolve(); }
        });
        observer.observe(document.body, { subtree: true, childList: true, attributes: true });
        setTimeout(() => { observer.disconnect(); reject(new Error("This session never started leaving")); }, 5000);
      });
      document.querySelector('${visible} [aria-label="New tab"]').click();
      await started;
      document.querySelector('${visible} [data-sidebar="left"] [data-sidebar-item-id="${sessionId}"] [data-tree-primary]').click();
    })()`);
    // Back and settled, whichever way it came back.
    await app.waitFor(
      `!!document.querySelector('${thisSessionTab}') && !document.querySelector('${right} [data-sidebar-tab-leaving]') && !document.querySelector('${right} .sidebar-tab-slot-leaving, ${right} .sidebar-strip-folding, ${right} .sidebar-tab-slot-arriving')`,
      { label: "This session back, settled" },
    );
    const back = await app.eval<{ left: boolean; same: boolean }>(
      `({ left: window.__quickChange.left, same: document.querySelector('${thisSessionTab}') === window.__quickChange.tab })`,
    );
    // Back while it was still leaving: it must be the same tab, reversed.
    if (!back.left) {
      expect(back.same, "the tab back is the one that was leaving").toBe(true);
      reversed = true;
    }
  }
  expect(app.getRendererErrors()).toEqual([]);
});
