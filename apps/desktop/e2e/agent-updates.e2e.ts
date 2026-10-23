import { afterAll, beforeAll, expect, it } from "vitest";
import { type AppHandle, focusWindow, launchApp } from "./harness.js";

let app: AppHandle;
let projectId: string;
let localId: string;
const chat = "section[data-chat-local-id]:not([inert], [inert] *)";

beforeAll(async () => {
  app = await launchApp();
  projectId = await app.eval<string>(`(async () => {
    const api = window.catamorphicDesktop;
    const project = await api.createProject({name:'Agent updates',rootPath:${JSON.stringify(`${app.userDataDir}/agent-updates`)}});
    const agent = await api.agentsCreate({name:'Review helper',harness:'codex',model:'fake-model-a',effort:'high'});
    await api.agentsSetDefault(agent.id);
    return project.id;
  })()`);
  await app.reload();
  await app.waitFor("!!document.querySelector('[data-workspace-ready]')");
  await focusWindow(app);
});
afterAll(async () => {
  await app?.stop();
});

async function click(selector: string) {
  const point = await app.waitFor<{ x: number; y: number }>(
    `(() => {const e=document.querySelector(${JSON.stringify(selector)});if(!e)return false;const r=e.getBoundingClientRect();return r.width&&r.height?{x:r.x+r.width/2,y:r.y+r.height/2}:false})()`,
  );
  await app.clickPointer(point);
}
async function send(text: string) {
  await click(`[data-chat-local-id="${localId}"] [data-composer-input]`);
  await app.insertText(text);
  await app.press("Enter");
}
async function fresh() {
  const previous = await app.eval<string[]>(
    `[...document.querySelectorAll('section[data-chat-local-id]')].map(e=>e.dataset.chatLocalId)`,
  );
  await app.press("n", process.platform === "darwin" ? 4 : 2);
  localId = await app.waitFor<string>(
    `[...document.querySelectorAll(${JSON.stringify(chat)})].find(e=>!${JSON.stringify(previous)}.includes(e.dataset.chatLocalId)&&e.querySelector('[data-composer-input]'))?.dataset.chatLocalId`,
  );
}
const snapshot = () =>
  app.eval<{
    turns: { id: string }[];
    items: { kind: string; status: string; text?: string; turnId: string }[];
  }>(`(async () => {
    const api=window.catamorphicDesktop;
    const dock=await api.dockSnapshot();
    const entry=dock.chats.find(c=>c.entry.localId===${JSON.stringify(localId)}).entry;
    const {url}=await api.getServerState();
    const response=await fetch(url+'/api/projects/'+${JSON.stringify(projectId)}+'/agent/sessions/'+entry.sessionId);
    return (await response.json()).snapshot;
  })()`);

it("receives child reports during the turn and folds them into one expandable status", async () => {
  await fresh();
  await send("Agent activity parent");
  await app.waitFor(
    "[...document.querySelectorAll('[data-step-kind=agent]')].some(e=>e.textContent.includes('6 updates'))",
    { timeoutMs: 30_000, label: "five reports and the child's result" },
  );
  expect(
    await app.eval(`({
      rows:document.querySelectorAll('[data-step-kind=agent]').length,
      inbound:document.querySelectorAll('[data-testid=chat-inbound-message]').length,
      working:!!document.querySelector('[data-testid=chat-stop]'),
      icon:!!document.querySelector('[data-step-kind=agent] [data-harness-icon=openai]'),
      waiting:document.body.textContent.includes('For the next turn')
    })`),
  ).toEqual({ rows: 1, inbound: 0, working: true, icon: true, waiting: false });
  await click('[data-step-kind="agent"] button');
  await app.waitFor(
    "[...document.querySelectorAll('[data-step-kind=agent] [data-testid=chat-step-detail]')].some(e=>e.textContent.includes('Progress report 1')&&e.textContent.includes('Progress report 5')&&e.textContent.includes('Subagent checks passed.'))",
  );
  expect(
    await app.eval(
      "!!document.querySelector('[data-step-kind=agent] [data-testid=chat-step-source]')",
    ),
  ).toBe(true);
  await send("Continue after the updates");
  await app.waitFor(
    "document.body.textContent.includes('All five updates reached this turn. Continued with your message.') && !document.querySelector('[data-testid=chat-stop]')",
    {
      timeoutMs: 30_000,
      label: "the original turn continuing with your message",
    },
  );
  const state = await snapshot();
  expect(state.turns).toHaveLength(1);
  const reports = state.items.filter(
    (item) =>
      item.kind === "inbound_message" &&
      item.text?.startsWith("Progress report"),
  );
  expect(reports).toHaveLength(5);
  expect(reports.every((item) => item.status === "completed")).toBe(true);
  expect(new Set(reports.map((item) => item.turnId))).toEqual(
    new Set([state.turns[0]?.id]),
  );
  expect(app.getRendererErrors()).toEqual([]);
});

it("keeps a failed child result visible in the conversation", async () => {
  await fresh();
  await send("Agent activity blocker parent");
  await app.waitFor(
    "!!document.querySelector('[data-testid=chat-task-notification][data-task-status=failed]')",
    { timeoutMs: 30_000, label: "the failed review outside folded activity" },
  );
  expect(
    await app.eval(
      "!document.querySelector('[data-testid=chat-task-notification][data-task-status=failed]').closest('[data-testid=chat-turn-steps]')",
    ),
  ).toBe(true);
  expect(app.getRendererErrors()).toEqual([]);
});
