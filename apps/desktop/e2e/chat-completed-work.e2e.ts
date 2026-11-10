import fs from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, expect, it } from "vitest";
import { chatBookmarkUrl } from "../src/shared/bookmark-target.js";
import { type AppHandle, focusWindow, launchApp } from "./harness.js";

let app: AppHandle;
const api = "window.catamorphicDesktop";
const chat = "section[data-chat-tab]:not([inert], [inert] *)";
const log = `${chat} [role="log"]`;
const artifacts = process.env.CATAMORPHIC_E2E_ARTIFACTS_DIR ?? "/tmp";

beforeAll(async () => {
  app = await launchApp();
  const target = await app.eval<{
    projectId: string;
    sessionId: string;
  }>(`(async()=>{
    const api=window.catamorphicDesktop;
    const project=await api.createProject({name:'Completed activity',rootPath:${JSON.stringify(path.join(artifacts, "completed-activity-project"))}});
    const agent=await api.agentsCreate({name:'Activity helper',harness:'ai-sdk'});
    const {url}=await api.getServerState();
    const response=await fetch(url+'/api/projects/'+project.id+'/agent/sessions',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({agentId:agent.id,title:'Verify the changes'})});
    if(!response.ok) throw new Error(await response.text());
    const session=await response.json();
    await api.setPrefs({chatWorkSettled:'collapse'});
    return {projectId:project.id,sessionId:session.id};
  })()`);
  await app.eval(
    `${api}.workspaceNavigate(${JSON.stringify({ projectId: target.projectId, surface: { url: chatBookmarkUrl(target), title: "Verify the changes", mode: "tab", nonce: crypto.randomUUID() } })})`,
  );
  await focusWindow(app);
  await app.waitFor(
    `!!document.querySelector('${chat} [data-composer-input]')`,
  );
}, 180_000);
afterAll(async () => app?.stop());

it("folds a finished command and its wakeup answer together, retaining the full history on demand", async () => {
  const gate = path.join(app.userDataDir, "complete-activity");
  const command = `background: while [ ! -f '${gate.replaceAll("'", "'\\''")}' ]; do sleep 0.05; done; echo activity-verified`;
  await app.eval(
    `document.querySelector('${chat} [data-composer-input]').focus()`,
  );
  await app.insertText(command);
  await app.press("Enter");
  try {
    await app.waitFor(
      `!!document.querySelector('${log} [data-step-kind="background"][data-running]')`,
      { label: "running command stays outside folded history" },
    );
    const row = `${log} [data-step-kind="background"][data-running] button`;
    const resting = await app.eval<{
      x: number;
      y: number;
      background: string;
      offset: number;
    }>(`(() => {
      const row = document.querySelector('${row}');
      const box = row.getBoundingClientRect();
      const step = document.querySelector('${log} [data-testid="chat-turn-steps-toggle"] svg');
      return { x: box.left + box.width / 2, y: box.top + box.height / 2, background: getComputedStyle(row).backgroundColor, offset: row.querySelector('svg').getBoundingClientRect().left - step.getBoundingClientRect().left };
    })()`);
    expect(Math.abs(resting.offset)).toBeLessThan(0.5);
    expect(
      await app.eval(
        `document.querySelector('${row}').textContent.includes('Running in background·Run it in the background')`,
      ),
    ).toBe(true);
    await app.cdp("Input.dispatchMouseEvent", {
      type: "mouseMoved",
      x: resting.x,
      y: resting.y,
    });
    await app.waitFor(
      `(() => { const row = document.querySelector('${row}'); const color = getComputedStyle(row).backgroundColor; return row.matches(':hover') && row.getAnimations().every((a) => a.playState !== 'running') && color === ${JSON.stringify(resting.background)}; })()`,
      { label: "background row keeps its quiet hover" },
    );
    await app.screenshot(path.join(artifacts, "background-row-hover.png"));
    await app.waitFor(
      `document.querySelector('${log}')?.textContent.includes('Started it in the background') && !document.querySelector('${chat} [data-testid="chat-stop"]')`,
    );
  } finally {
    fs.writeFileSync(gate, "ready");
  }
  await app.waitFor(
    `document.querySelector('${log}')?.textContent.includes('Read it: Run it in the background finished') && !document.querySelector('${chat} [data-testid="chat-stop"]')`,
    { timeoutMs: 30_000, label: "completion wakes the assistant and is read" },
  );
  await app.waitFor(
    `document.querySelectorAll('${log} article').length===2 && !document.querySelector('${log} [data-testid="chat-step"]') && !document.querySelector('${log} .cat-fold-away')`,
    { label: "person message, one collapsed work section, final answer" },
  );
  expect(
    await app.eval(
      `document.querySelectorAll('${log} [data-testid="chat-turn-steps-toggle"]').length`,
    ),
  ).toBe(1);
  expect(
    await app.eval(
      `!!document.querySelector('${log} [data-testid="chat-task-notification"]')`,
    ),
  ).toBe(false);
  await app.screenshot(path.join(artifacts, "completed-work-folded.png"));
  await app.eval(
    `document.querySelector('${log} [data-testid="chat-turn-steps-toggle"]').focus()`,
  );
  await app.press("Enter");
  await app.waitFor(
    `document.querySelectorAll('${log} [data-testid="chat-step"]').length===3`,
  );
  expect(
    await app.eval(
      `Array.from(document.querySelectorAll('${log} [data-testid="chat-step"]')).map(step=>step.dataset.stepKind)`,
    ),
  ).toEqual(["background", "note", "notification"]);
  const update = `${log} [data-step-kind="notification"]`;
  await app.eval(`document.querySelector('${update} button').focus()`);
  await app.press("Enter");
  await app.waitFor(
    `document.querySelector('${update}')?.textContent.includes('activity-verified')`,
  );
  await app.screenshot(path.join(artifacts, "completed-work-expanded.png"));
  await app.eval(`${api}.setPrefs({chatWorkSettled:'keep'})`);
  await app.waitFor(
    `!!document.querySelector('${log} [data-testid="chat-task-notification"]') && document.querySelectorAll('${log} article').length===3`,
  );
  await app.screenshot(path.join(artifacts, "completed-work-kept.png"));
  await app.eval(`${api}.setPrefs({chatWorkSettled:'collapse'})`);
  await app.waitFor(
    `document.querySelectorAll('${log} article').length===2 && !document.querySelector('${log} .cat-fold-away')`,
  );
  expect(app.getRendererErrors()).toEqual([]);
});
