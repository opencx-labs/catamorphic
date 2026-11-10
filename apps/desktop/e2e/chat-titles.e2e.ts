import { expect, it } from "vitest";
import { chatBookmarkUrl } from "../src/shared/bookmark-target.js";
import { createProjectWorkspace, launchApp } from "./harness.js";

it("keeps an older chat's name outside the recent page, across reload and rename", async () => {
  const app = await launchApp();
  try {
    const project = await createProjectWorkspace({
      app,
      name: "Chat names",
      rootPath: `${app.userDataDir}/chat-names`,
    });
    const server = await app.eval<{ url: string }>(
      "window.catamorphicDesktop.getServerState()",
    );
    const base = `${server.url}/api/projects/${project.id}/agent/sessions`;
    const headers = { "Content-Type": "application/json" };
    const create = async (title: string) => {
      const response = await fetch(base, {
        method: "POST",
        headers,
        body: JSON.stringify({ title, source: "desktop" }),
      });
      expect(response.status).toBe(201);
      return (await response.json()) as { id: string };
    };
    const older = await create("Older project notes");
    for (let batch = 0; batch < 10; batch += 1)
      await Promise.all(
        Array.from({ length: 10 }, (_, index) =>
          create(`Newer chat ${batch * 10 + index}`),
        ),
      );
    const recent = (await (await fetch(`${base}?limit=100`)).json()) as {
      items: { id: string }[];
    };
    expect(recent.items).toHaveLength(100);
    expect(recent.items.some((session) => session.id === older.id)).toBe(false);
    await app.eval(
      `window.catamorphicDesktop.workspaceNavigate(${JSON.stringify({
        projectId: project.id,
        surface: {
          url: chatBookmarkUrl({ projectId: project.id, sessionId: older.id }),
          title: "Chat",
          mode: "tab",
          nonce: crypto.randomUUID(),
        },
      })})`,
    );
    const named = (title: string) =>
      `[...document.querySelectorAll('[data-workspace-visible="true"] [data-point-key^="chat:"] .workspace-tab-title')].some(node => node.textContent.trim() === ${JSON.stringify(title)})`;
    await app.waitFor(named("Older project notes"), {
      label: "older chat's actual title in its tab",
    });
    await app.waitFor(
      `(async () => JSON.stringify(await window.catamorphicDesktop.workspaceStateGet(${JSON.stringify(project.id)})).includes(${JSON.stringify(older.id)}))()`,
      { label: "chat persisted before reload" },
    );
    await app.reload();
    await app.waitFor(named("Older project notes"), {
      label: "older title restored with its tab",
    });
    // A change from outside this reader must reach the same canonical fields.
    const renamed = await fetch(`${base}/${older.id}/title`, {
      method: "PATCH",
      headers,
      body: JSON.stringify({ title: "Retained project notes" }),
    });
    expect(renamed.status).toBe(200);
    await app.waitFor(named("Retained project notes"), {
      label: "older chat's live rename in its tab",
    });
    const stillRecent = (await (await fetch(`${base}?limit=100`)).json()) as {
      items: { id: string }[];
    };
    expect(stillRecent.items.some((session) => session.id === older.id)).toBe(
      false,
    );
    expect(app.getRendererErrors()).toEqual([]);
  } finally {
    await app.stop();
  }
}, 180_000);
