// End-to-end validation + footage capture for the Catamorphic playground.
//
// Drives the real UI at localhost:5173 against the real stack (Postgres,
// Cloudflare sandbox bridge, Flue coding agent with a live model), recording
// a continuous video plus timestamped phase markers used by cut.mjs to slice
// chapter clips for the Revideo composition.
//
// A fake cursor overlay is injected into the page (Playwright's recording
// doesn't capture the OS cursor) and all interactions glide the mouse to the
// target so the cursor is visible and natural in the footage.
//
// Usage: node capture.mjs

import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { chromium } from "playwright";

const OUT_DIR = path.resolve(import.meta.dirname, "out");
const BASE_URL = "http://localhost:5173";
const PROJECT_NAME = `order-alerts-${Date.now().toString(36).slice(-4)}`;

const AGENT_PROMPT =
  "Build a workflow named orderAlert that watches for large orders. " +
  "It takes an orderId (text) and amount (number). It should look up the " +
  "order details, then if the amount is over 100 send a Slack alert to the " +
  "sales channel, otherwise just record it in the activity log. Use stub " +
  "step implementations that return realistic sample data.";

// Fake cursor rendered inside the page so it shows up in the recording.
// Follows synthetic mousemove events; pulses a ring on mousedown.
const CURSOR_OVERLAY = `
  (() => {
    if (window.__demoCursorInstalled) return;
    window.__demoCursorInstalled = true;
    const install = () => {
      const cursor = document.createElement('div');
      cursor.id = '__demo-cursor';
      cursor.style.cssText =
        'position:fixed;top:0;left:0;width:26px;height:26px;' +
        'pointer-events:none;z-index:2147483647;transform:translate(-4px,-3px);';
      cursor.innerHTML =
        '<svg width="26" height="26" viewBox="0 0 24 24">' +
        '<path d="M5.5 3.2 L5.5 17.5 L9 14.4 L11.2 19.8 L13.7 18.7 L11.5 13.4 L16.2 13 Z"' +
        ' fill="#fff" stroke="#000" stroke-width="1.3" stroke-linejoin="round"/></svg>';
      document.body.appendChild(cursor);

      let x = -100; let y = -100;
      const move = (e) => {
        x = e.clientX; y = e.clientY;
        cursor.style.transform =
          'translate(' + (x - 4) + 'px,' + (y - 3) + 'px)';
      };
      document.addEventListener('mousemove', move, true);
      document.addEventListener('mousedown', (e) => {
        const ring = document.createElement('div');
        ring.style.cssText =
          'position:fixed;pointer-events:none;z-index:2147483646;' +
          'width:34px;height:34px;border-radius:50%;border:2.5px solid #f95225;' +
          'left:' + (e.clientX - 17) + 'px;top:' + (e.clientY - 17) + 'px;' +
          'opacity:0.9;transform:scale(0.4);' +
          'transition:transform 0.45s ease-out,opacity 0.45s ease-out;';
        document.body.appendChild(ring);
        requestAnimationFrame(() => {
          ring.style.transform = 'scale(1.25)';
          ring.style.opacity = '0';
        });
        setTimeout(() => ring.remove(), 600);
      }, true);
    };
    if (document.body) install();
    else document.addEventListener('DOMContentLoaded', install);
  })();
`;

mkdirSync(OUT_DIR, { recursive: true });

/** Phase markers (ms since recording start) for the video composition. */
const markers = [];
let t0;
const mark = (name) => {
  const at = Date.now() - t0;
  markers.push({ name, at });
  console.log(`[${(at / 1000).toFixed(1)}s] ${name}`);
};

const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function run() {
  const browser = await chromium.launch();
  const context = await browser.newContext({
    viewport: { width: 1600, height: 900 },
    recordVideo: { dir: OUT_DIR, size: { width: 1600, height: 900 } },
  });
  await context.addInitScript(CURSOR_OVERLAY);
  const page = await context.newPage();
  page.setDefaultTimeout(30_000);

  const consoleErrors = [];
  page.on("console", (msg) => {
    if (msg.type() === "error") consoleErrors.push(msg.text());
  });
  page.on("pageerror", (err) => consoleErrors.push(String(err)));

  /** Glide the cursor to the element, hover briefly, then click. */
  const humanClick = async (locator, { settle = 250 } = {}) => {
    await locator.waitFor({ state: "visible" });
    const box = await locator.boundingBox();
    if (!box) throw new Error("No bounding box for locator");
    const cx = box.x + box.width / 2;
    const cy = box.y + box.height / 2;
    await page.mouse.move(cx, cy, { steps: 28 });
    await pause(settle);
    await page.mouse.down();
    await pause(70);
    await page.mouse.up();
  };

  t0 = Date.now();
  await page.goto(BASE_URL);
  await page.waitForSelector(".pg-sidebar");
  await page.mouse.move(800, 450, { steps: 5 });
  mark("app-loaded");
  await pause(1500);

  // --- 1. Create a blank project -----------------------------------------
  const nameInput = page.locator('input[placeholder="Project name"]');
  await humanClick(nameInput);
  await nameInput.pressSequentially(PROJECT_NAME, { delay: 60 });
  await page.locator(".pg-sidebar select").selectOption("");
  await pause(500);
  mark("create-project-click");
  await humanClick(page.locator('.pg-sidebar button:has-text("Create")'));

  // Project becomes active; chat panel appears.
  await page.waitForSelector(".pg-chat");
  await page.waitForSelector(`.pg-item:has-text("${PROJECT_NAME}")`);
  mark("project-created");
  await page.screenshot({ path: path.join(OUT_DIR, "01-project-created.png") });
  await pause(1200);

  // --- 2. Ask the agent to build the workflow ----------------------------
  const chatBox = page.locator(".pg-chat-composer textarea");
  mark("chat-typing-start");
  await humanClick(chatBox);
  await chatBox.pressSequentially(AGENT_PROMPT, { delay: 8 });
  await pause(600);
  mark("agent-prompt-sent");
  await humanClick(page.locator('.pg-chat button:has-text("Send")'));

  // The Flue harness spins up a Cloudflare dev sandbox and writes code —
  // give it plenty of time.
  await page.waitForSelector(".pg-chat-message.assistant", {
    timeout: 420_000,
  });
  mark("agent-replied");
  await page.screenshot({ path: path.join(OUT_DIR, "02-agent-replied.png") });
  await pause(1200);

  // --- 3. Open the workflow the agent created ----------------------------
  const workflowItem = page.locator(
    '.pg-sidebar .pg-item:has-text("orderAlert")',
  );
  await workflowItem.waitFor({ timeout: 30_000 });
  mark("open-workflow");
  await humanClick(workflowItem);

  await page.waitForSelector(".catamorphic-toolbar");
  await page.waitForSelector(".react-flow__node", { timeout: 30_000 });
  await pause(2600); // let the graph settle/layout
  await page.screenshot({ path: path.join(OUT_DIR, "03-graph.png") });
  mark("graph-rendered");

  // --- 4. Run the workflow (test run in a real CF sandbox) ---------------
  mark("run-click");
  await humanClick(
    page.locator('.catamorphic-toolbar button:has-text("▶ Run")'),
  );
  await page.waitForSelector(".catamorphic-run-dialog");
  mark("run-dialog-open");
  await pause(600);

  // Fill whatever text/number fields the agent's trigger declared.
  const textInputs = page.locator(
    '.catamorphic-run-dialog input.catamorphic-run-input[type="text"]',
  );
  for (let i = 0; i < (await textInputs.count()); i++) {
    await humanClick(textInputs.nth(i));
    await textInputs.nth(i).pressSequentially("ORD-1042", { delay: 40 });
  }
  const numberInputs = page.locator(
    '.catamorphic-run-dialog input.catamorphic-run-input[type="number"]',
  );
  for (let i = 0; i < (await numberInputs.count()); i++) {
    await numberInputs.nth(i).fill("");
    await humanClick(numberInputs.nth(i));
    await numberInputs.nth(i).pressSequentially("250", { delay: 60 });
  }
  await pause(600);
  await page.screenshot({ path: path.join(OUT_DIR, "04-run-dialog.png") });
  mark("run-submitted");
  await humanClick(
    page.locator('.catamorphic-run-dialog button:has-text("▶ Run")'),
  );

  // History sidebar opens with the running entry; wait for the toolbar to
  // leave the "Running..." state (sandbox execution can take a while).
  await page.waitForSelector(".catamorphic-history-sidebar, .pg-error", {
    timeout: 10_000,
  });
  await page.waitForFunction(
    () => {
      const btn = [
        ...document.querySelectorAll(".catamorphic-toolbar button"),
      ].find((b) => b.textContent?.includes("Run"));
      return btn && !btn.textContent.includes("Running");
    },
    { timeout: 420_000 },
  );
  mark("run-completed");
  await pause(1500);
  await page.screenshot({ path: path.join(OUT_DIR, "05-run-completed.png") });

  // --- 5. Deploy ----------------------------------------------------------
  await pause(500);
  mark("deploy-click");
  await humanClick(
    page.locator('.catamorphic-toolbar .pg-btn:has-text("Deploy")'),
  );
  await page.waitForSelector('.pg-btn:has-text("Deployed ✓")', {
    timeout: 120_000,
  });
  mark("deployed");
  await pause(1800);
  await page.screenshot({ path: path.join(OUT_DIR, "06-deployed.png") });

  // --- 6. Show the code behind the graph ---------------------------------
  mark("code-tab");
  await humanClick(
    page.locator('.catamorphic-detail-tab:has-text("Code")'),
  );
  await page.waitForSelector(".catamorphic-detail-code-panel");
  await pause(1400);
  // Drift down the source so the workflow body is on screen.
  const codePanel = page.locator(".catamorphic-detail-code-panel");
  const codeBox = await codePanel.boundingBox();
  if (codeBox) {
    await page.mouse.move(
      codeBox.x + codeBox.width / 2,
      codeBox.y + codeBox.height / 2,
      { steps: 20 },
    );
    await page.mouse.wheel(0, 260);
    await pause(1200);
    await page.mouse.wheel(0, 260);
  }
  await pause(1800);
  await page.screenshot({ path: path.join(OUT_DIR, "07-code-view.png") });
  mark("end");

  // Persist artifacts.
  const video = page.video();
  await context.close();
  const videoPath = await video.path();
  writeFileSync(
    path.join(OUT_DIR, "markers.json"),
    JSON.stringify(
      { videoPath, markers, consoleErrors, projectName: PROJECT_NAME },
      null,
      2,
    ),
  );
  await browser.close();

  console.log(`\nVideo: ${videoPath}`);
  console.log(`Console errors: ${consoleErrors.length}`);
  for (const err of consoleErrors) console.log(`  - ${err}`);
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
