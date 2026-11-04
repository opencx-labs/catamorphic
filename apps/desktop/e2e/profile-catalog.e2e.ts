import fs from "node:fs/promises";
import path from "node:path";
import { afterAll, expect, it } from "vitest";
import type { WindowSession } from "../src/main/window-state.js";
import { type AppHandle, type FrameHandle, launchApp } from "./harness.js";

let app: AppHandle | undefined;
let second: FrameHandle | undefined;
afterAll(async () => {
  second?.close();
  await app?.stop();
});

it("keeps older profile projects and refreshes other windows when projects arrive", async () => {
  app = await launchApp();
  const handle = app;
  const create = (frame: Pick<FrameHandle, "eval">, name: string) =>
    frame.eval<{ id: string }>(
      `window.catamorphicDesktop.createProject(${JSON.stringify({ name, rootPath: path.join(handle.userDataDir, name.replaceAll(" ", "-")) })})`,
    );
  await handle.waitFor(
    "document.body.innerText.includes('Make yourself at home')",
  );
  // A profile ownership broadcast arrives before its catalog refresh. Hold
  // that request so cached emptiness cannot masquerade as onboarding.
  const paused: string[] = [];
  const unsubscribe = handle.onCdpEvent("Fetch.requestPaused", (event) => {
    if (
      event &&
      typeof event === "object" &&
      "requestId" in event &&
      typeof event.requestId === "string"
    )
      paused.push(event.requestId);
  });
  await handle.cdp("Fetch.enable", {
    patterns: [{ urlPattern: "*/api/projects?*", requestStage: "Request" }],
  });
  const original = await create(handle, "Older profile project");
  try {
    await expect.poll(() => paused.length).toBeGreaterThan(0);
    await handle.waitFor(
      "document.querySelector('[aria-label=\"Switch project\"]')?.textContent.includes('Loading projects')",
    );
    expect(
      await handle.eval(
        "document.body.innerText.includes('Make yourself at home') || document.body.innerText.includes('Add your first project')",
      ),
    ).toBe(false);
    for (const requestId of paused)
      await handle.cdp("Fetch.continueRequest", { requestId });
  } finally {
    await handle.cdp("Fetch.disable");
    unsubscribe();
  }
  await handle.eval(
    `window.catamorphicDesktop.workspaceNavigate({projectId:${JSON.stringify(original.id)}})`,
  );
  const active = `document.querySelector('[data-workspace-visible="true"]')?.dataset.projectRuntime === ${JSON.stringify(original.id)}`;
  await handle.waitFor(active);
  await handle.waitFor("!!document.querySelector('[data-workspace-ready]')");
  const separate = await create(handle, "Another window");
  await handle.eval(
    `window.catamorphicDesktop.workspaceNavigate({projectId:${JSON.stringify(separate.id)},newWindow:true})`,
  );
  let windowId: string | undefined;
  await expect
    .poll(async () => {
      const saved: WindowSession = JSON.parse(
        await fs.readFile(
          path.join(handle.userDataDir, "window-state.json"),
          "utf8",
        ),
      );
      windowId = saved.windows.find(
        (window) => window.activeProjectId === separate.id,
      )?.id;
      return windowId;
    })
    .toBeTruthy();
  second = await handle.connectToFrame(`window=${windowId}`);
  await second.waitFor(
    `document.querySelector('[data-workspace-visible="true"]')?.dataset.projectRuntime === ${JSON.stringify(separate.id)}`,
  );

  // A command in one window appears in both; dismissing either closes both.
  await handle.eval("window.catamorphicDesktop.updateCheck()");
  const banner = '[data-testid="desktop-update-banner"][data-state="open"]';
  await handle.waitFor(`!!document.querySelector('${banner}')`);
  await second.waitFor(`!!document.querySelector('${banner}')`);
  await second.eval(
    "document.querySelector('[aria-label=\"Dismiss update message\"]').click()",
  );
  await handle.waitFor(
    "!document.querySelector('[data-testid=\"desktop-update-banner\"]')",
  );
  await second.waitFor(
    "!document.querySelector('[data-testid=\"desktop-update-banner\"]')",
  );

  // More than the API's default 20: another window's create must refresh
  // this window too, without a focus refetch or a reload.
  for (let index = 0; index < 21; index += 1)
    await create(second, `New project ${index}`);
  await handle.eval(
    "document.querySelector('[aria-label=\"Switch project\"]').click()",
  );
  await handle.waitFor(
    "Array.from(document.querySelectorAll('[role=\"option\"]')).some(row => row.textContent.includes('New project 20'))",
  );
  expect(await handle.eval(active)).toBe(true);
  await handle.eval(
    "document.querySelector('[aria-label=\"Switch project\"]').click()",
  );
  // A cold catalog read must retain the main process's older project claim.
  await handle.reload();
  await handle.waitFor(active);
  await handle.waitFor(
    "document.querySelector('[aria-label=\"Switch project\"]')?.textContent.includes('Older profile project')",
  );
  expect(
    await handle.eval(
      "document.body.innerText.includes('Make yourself at home') || document.body.innerText.includes('No projects')",
    ),
  ).toBe(false);
  if (process.env.CATAMORPHIC_E2E_ARTIFACTS_DIR)
    await handle.screenshot(
      path.join(
        process.env.CATAMORPHIC_E2E_ARTIFACTS_DIR,
        "profile-catalog-restored.png",
      ),
    );
  expect(handle.getRendererErrors()).toEqual([]);
  expect(second.getRendererErrors()).toEqual([]);
}, 180_000);
