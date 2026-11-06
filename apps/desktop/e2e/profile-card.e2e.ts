import path from "node:path";
import { afterAll, beforeAll, expect, it } from "vitest";
import { type AppHandle, launchApp } from "./harness.js";

let app: AppHandle;
beforeAll(async () => {
  app = await launchApp();
  await app.waitFor(
    `!!document.querySelector('[aria-label^="Switch profile"]')`,
  );
});
afterAll(async () => {
  await app?.stop();
});

/** A registry icon arrives as an https or data url (MCP `icons`). */
const icon = `data:image/svg+xml,${encodeURIComponent(
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16"><rect width="16" height="16" rx="3" fill="#5e6ad2"/></svg>',
)}`;
const card = `document.querySelector('[data-resource-inspector][data-open="true"] [data-testid="profile-inspector"]')`;

it("previews the active profile with its connections and their icons", async () => {
  await app.eval(
    `window.catamorphicDesktop.connectionsCreate(${JSON.stringify({ name: "Linear", transport: "http", url: "https://mcp.linear.example/sse", iconUrl: icon })})`,
  );
  await app.eval(
    `window.catamorphicDesktop.connectionsCreate(${JSON.stringify({ name: "Team docs", transport: "http", url: "http://docs.internal.example/mcp" })})`,
  );
  await app.eval(
    `document.querySelector('[aria-label^="Switch profile"]').dispatchEvent(new PointerEvent('pointerover', { bubbles: true, relatedTarget: document.body }))`,
  );
  await app.waitFor(`${card}?.querySelectorAll('li').length === 2`);
  expect(
    await app.eval(
      `[...${card}.querySelectorAll('li')].map(row => row.textContent)`,
    ),
  ).toEqual(["Linear", "Team docs"]);
  // The registry icon; an http address has no favicon the page may load.
  expect(
    await app.eval(`${card}.querySelector('li img')?.getAttribute('src')`),
  ).toBe(icon);
  expect(
    await app.eval(
      `!!${card}.querySelectorAll('li')[1].querySelector('[aria-label="Team docs"]')`,
    ),
  ).toBe(true);
  // Who the profile is, and nothing it holds.
  const text = await app.eval<string>(`${card}.textContent`);
  expect(text).toContain("Default");
  expect(text).not.toContain("Projects");
  expect(text).not.toContain("Agent");
  if (process.env.CATAMORPHIC_E2E_ARTIFACTS_DIR)
    await app.screenshot(
      path.join(process.env.CATAMORPHIC_E2E_ARTIFACTS_DIR, "profile-card.png"),
    );
  expect(app.getRendererErrors()).toEqual([]);
});
