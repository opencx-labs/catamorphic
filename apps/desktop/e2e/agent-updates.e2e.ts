import type { SessionSnapshot } from "@catamorphic/agent-protocol";
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
const snapshotExpression = () => `(async () => {
    const api=window.catamorphicDesktop;
    const dock=await api.dockSnapshot();
    const entry=dock.chats.find(c=>c.entry.localId===${JSON.stringify(localId)}).entry;
    const {url}=await api.getServerState();
    const response=await fetch(url+'/api/projects/'+${JSON.stringify(projectId)}+'/agent/sessions/'+entry.sessionId);
    return (await response.json()).snapshot;
  })()`;
const snapshot = () => app.eval<SessionSnapshot>(snapshotExpression());

const contextReports = (state: SessionSnapshot) =>
  state.items
    .filter((item) => item.kind === "inbound_message")
    .filter((item) => item.text.startsWith("Context report "));

const positions = (state: SessionSnapshot) =>
  JSON.stringify({
    turns: state.turns.map(({ id, status }) => ({ id, status })),
    items: state.items.map(({ id, kind, position, turnId, status }) => ({
      id,
      kind,
      position,
      turnId,
      status,
    })),
  });

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

it("reloads interleaved context-only peer reports as one loose activity block", async () => {
  // This case exercises delivery and projection, independently of a native
  // harness's sign-in refresh while the fixture deliberately stays running.
  await app.eval(`(async () => {
    const api=window.catamorphicDesktop;
    const agent=await api.agentsCreate({name:'Context fixture',harness:'ai-sdk',model:'fake-model-a'});
    await api.agentsSetDefault(agent.id);
  })()`);
  const previousDisplay = await app.eval<string>(
    "window.catamorphicDesktop.getPrefs().then(prefs=>prefs.chatWorkLive)",
  );
  await app.eval("window.catamorphicDesktop.setPrefs({chatWorkLive:'notes'})");
  try {
    await fresh();
    await send("Context reports main");
    const scope = `section[data-chat-local-id="${localId}"]`;
    await app.waitFor(
      `!!document.querySelector(${JSON.stringify(`${scope} [data-testid=chat-stop]`)}) && document.querySelector(${JSON.stringify(scope)})?.textContent.includes('Waiting for independent context reports.')`,
      { timeoutMs: 30_000, label: "main chat working before peer delivery" },
    );
    // An independent session retains message_only. A direct child's reports
    // deliberately steer the working parent, which the first case covers.
    const peer = await app.eval<{
      id: string;
      parentSessionId: string | null;
    }>(`(async () => {
      const api=window.catamorphicDesktop;
      const dock=await api.dockSnapshot();
      const mainId=dock.chats.find(c=>c.entry.localId===${JSON.stringify(localId)}).entry.sessionId;
      const {url}=await api.getServerState();
      const base=url+'/api/projects/'+${JSON.stringify(projectId)}+'/agent/sessions';
      const main=await fetch(base+'/'+mainId).then(r=>r.json());
      const created=await fetch(base, {
        method:'POST',headers:{'content-type':'application/json'},
        body:JSON.stringify({agentId:main.agentId,title:'Independent context reporter',source:'desktop'})
      });
      if(created.status!==201)throw new Error('Create peer: '+created.status+' '+await created.text());
      const peer=await created.json();
      const sent=await fetch(base+'/'+peer.id+'/commands', {
        method:'POST',headers:{'content-type':'application/json'},
        body:JSON.stringify({type:'send',commandId:crypto.randomUUID(),text:'Context reports peer '+mainId})
      });
      if(!sent.ok)throw new Error('Start peer: '+sent.status+' '+await sent.text());
      return {id:peer.id,parentSessionId:peer.parentSessionId};
    })()`);
    expect(peer.parentSessionId).toBeNull();
    const delivered = await app.waitFor<SessionSnapshot>(
      `(async () => {
        const state=await ${snapshotExpression()};
        return state.items.filter(item=>item.kind==='inbound_message'&&item.text.startsWith('Context report ')).length===9?state:false;
      })()`,
      { timeoutMs: 30_000, label: "nine independent context-only reports" },
    );
    const reports = contextReports(delivered);
    const mainTurn = delivered.turns[0];
    expect(delivered.turns, positions(delivered)).toHaveLength(1);
    expect(mainTurn?.status, positions(delivered)).toBe("running");
    expect(
      reports.map(({ turnId, status, dispatch, attention, from }) => ({
        turnId,
        status,
        dispatch,
        attention,
        from,
      })),
      positions(delivered),
    ).toEqual(
      reports.map(() => ({
        turnId: null,
        status: "in_progress",
        dispatch: "message_only",
        attention: null,
        from: {
          kind: "agent",
          sessionId: peer.id,
          agentId: expect.any(String),
        },
      })),
    );
    // The regression requires actual turn-owned work between reports, not
    // just separate text chunks that the harness might join into one item.
    expect(
      reports
        .slice(1)
        .map((report, index) =>
          delivered.items.some(
            (item) =>
              item.turnId === mainTurn?.id &&
              item.kind === "tool_call" &&
              item.position > (reports[index]?.position ?? 0) &&
              item.position < report.position,
          ),
        ),
      positions(delivered),
    ).toEqual(Array.from({ length: 8 }, () => true));
    const users = delivered.items.filter(
      (item) => item.kind === "user_message",
    );
    expect(users.map((item) => item.text)).toEqual(["Context reports main"]);

    await app.reload();
    await app.waitFor(
      `!!document.querySelector(${JSON.stringify(`${scope} [data-composer-input]`)}) && !!document.querySelector(${JSON.stringify(`${scope} [data-step-kind=agent]`)})`,
      { timeoutMs: 30_000, label: "working chat restored with peer activity" },
    );
    const restored = await snapshot();
    expect(contextReports(restored), positions(restored)).toEqual(reports);
    expect(
      restored.items.filter((item) => item.kind === "user_message"),
    ).toEqual(users);
    expect(restored.turns.map(({ id, status }) => ({ id, status }))).toEqual([
      { id: mainTurn?.id, status: "running" },
    ]);
    const rows = await app.eval<{
      workBlocks: number;
      agentBlocks: number;
      agentRows: number;
      inbound: number;
      userRows: number;
      working: boolean;
      counts: string[];
    }>(`(() => {
      const chat=document.querySelector(${JSON.stringify(scope)});
      const work=[...chat.querySelectorAll('article[data-live-work]')];
      return {
        workBlocks:work.length,
        agentBlocks:work.filter(e=>e.querySelector('[data-step-kind=agent]')).length,
        agentRows:chat.querySelectorAll('[data-step-kind=agent]').length,
        inbound:chat.querySelectorAll('[data-testid=chat-inbound-message]').length,
        userRows:chat.querySelectorAll('[data-testid=chat-user-message]').length,
        working:!!chat.querySelector('[data-testid=chat-stop]'),
        counts:work.map(e=>e.querySelector('[data-testid=chat-turn-steps-toggle]')?.textContent.trim())
      };
    })()`);
    expect(
      rows,
      `Rows: ${JSON.stringify(rows)}; ${positions(restored)}`,
    ).toMatchObject({
      workBlocks: 2,
      agentBlocks: 1,
      agentRows: 1,
      inbound: 0,
      userRows: 1,
      working: true,
    });
    await click(
      `${scope} article[data-live-work]:has([data-step-kind=agent]) [data-testid=chat-turn-steps-toggle]`,
    );
    await app.waitFor(
      `(() => {
        const button=document.querySelector(${JSON.stringify(`${scope} [data-step-kind=agent] button`)});
        if(!button)return false;
        const r=button.getBoundingClientRect();
        return !!r.width && !!r.height && button.contains(document.elementFromPoint(r.x+r.width/2,r.y+r.height/2));
      })()`,
      { label: "expanded peer activity row accepting pointer input" },
    );
    await click(`${scope} [data-step-kind=agent] button`);
    await app.waitFor(
      `(() => {
        const row=document.querySelector(${JSON.stringify(`${scope} [data-step-kind=agent]`)});
        const detail=row?.querySelector('[data-testid=chat-step-detail]');
        return row?.textContent.includes('9 updates') && !!row.querySelector('[data-testid=chat-step-source]') && ${JSON.stringify(reports.map((report) => report.text))}.every(text=>detail?.textContent.includes(text));
      })()`,
      { label: "all nine full reports and their source inside one disclosure" },
    );
    expect(contextReports(await snapshot())).toEqual(reports);
    await send("Continue after context reports");
    await app.waitFor(
      `document.querySelector(${JSON.stringify(scope)})?.textContent.includes('Continued after the context reports.') && !document.querySelector(${JSON.stringify(`${scope} [data-testid=chat-stop]`)})`,
      { timeoutMs: 30_000, label: "same main turn continuing after reload" },
    );
    const finished = await snapshot();
    expect(finished.turns).toHaveLength(1);
    expect(contextReports(finished)).toEqual(reports);
    expect(app.getRendererErrors()).toEqual([]);
  } finally {
    await app.eval(
      `window.catamorphicDesktop.setPrefs({chatWorkLive:${JSON.stringify(previousDisplay)}})`,
    );
  }
});
