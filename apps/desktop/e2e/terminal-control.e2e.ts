import fs from "node:fs/promises";
import path from "node:path";
import { nativeGit } from "@catamorphic/git";
import { afterAll, beforeAll, expect, it } from "vitest";
import { type AppHandle, focusWindow, launchApp } from "./harness.js";

let app: AppHandle;
let projectId: string;
let sessionId: string;
let checkout: string;
let lastTerminalId: string | undefined;
const composer = "[data-chat-local-id]:not([inert]) [data-composer-input]";
const pane =
  '[data-workspace-visible="true"] [data-surface-key^="terminal:"][data-workspace-slot]';

async function click(selector: string) {
  const point = await app.waitFor<{ x: number; y: number }>(`(() => {
    const button=document.querySelector(${JSON.stringify(selector)});
    if(!button)return false;
    const r=button.getBoundingClientRect();
    return r.width && r.height && button.contains(document.elementFromPoint(r.x+r.width/2,r.y+r.height/2))
      ? {x:r.x+r.width/2,y:r.y+r.height/2}:false;
  })()`);
  await app.clickPointer(point);
}

/** Real terminal typing: Ghostty encodes keydown, not Input.insertText. */
async function typeInTerminal(text: string) {
  for (const char of text) {
    const key = {
      key: char,
      ...(/[a-z]/i.test(char)
        ? {
            code: `Key${char.toUpperCase()}`,
            windowsVirtualKeyCode: char.toUpperCase().charCodeAt(0),
          }
        : {}),
    };
    await app.cdp("Input.dispatchKeyEvent", {
      type: "keyDown",
      ...key,
      text: char,
    });
    await app.cdp("Input.dispatchKeyEvent", { type: "keyUp", ...key });
  }
  await app.press("Enter");
}

async function showChat() {
  await app.eval(
    `window.catamorphicDesktop.workspaceNavigate(${JSON.stringify({
      projectId,
      surface: {
        url: `session:${sessionId}`,
        title: "Terminal control",
        mode: "tab",
        nonce: crypto.randomUUID(),
      },
    })})`,
  );
  await app.waitFor(`!!document.querySelector(${JSON.stringify(composer)})`);
}

async function startTerminal(command: string) {
  await showChat();
  await click(composer);
  await app.insertText(`start: ${command}`);
  await app.press("Enter");
  const terminalId = await app.waitFor<string>(
    `(() => {
      const ids=[...document.body.textContent.matchAll(/terminalId\\W+([0-9a-f-]{36})/g)];
      const id=ids.at(-1)?.[1];
      return id && id!==${JSON.stringify(lastTerminalId ?? null)}?id:false;
    })()`,
    { timeoutMs: 30_000, label: "new command's terminal id" },
  );
  lastTerminalId = terminalId;
  await click('[data-testid="chip"][data-kind="terminal"] [data-chip-main]');
  await app.waitFor(
    `!!document.querySelector(${JSON.stringify(`${pane} canvas`)})`,
    { label: "agent terminal mounted" },
  );
  return terminalId;
}

beforeAll(async () => {
  app = await launchApp();
  const root = path.join(app.userDataDir, "terminal-control");
  await fs.mkdir(root, { recursive: true });
  await nativeGit(root, ["init", "-b", "main"]);
  await fs.writeFile(
    path.join(root, "README.md"),
    "Terminal control fixture\n",
  );
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
  const created = await app.eval<{
    projectId: string;
    agentId: string;
  }>(`(async () => {
    const api=window.catamorphicDesktop;
    const project=await api.createProject({name:'Terminal control',rootPath:${JSON.stringify(root)},importExisting:true});
    const agent=await api.agentsCreate({name:'Terminal helper',harness:'ai-sdk',model:'fake-model-a'});
    await api.agentsSetDefault(agent.id);
    return {projectId:project.id,agentId:agent.id};
  })()`);
  projectId = created.projectId;
  await app.reload();
  await app.waitFor("!!document.querySelector('[data-workspace-ready]')");
  await focusWindow(app);
  sessionId = await app.eval<string>(`(async () => {
    const api=window.catamorphicDesktop;
    const {url}=await api.getServerState();
    const response=await fetch(url+'/api/projects/'+${JSON.stringify(projectId)}+'/agent/sessions', {
      method:'POST',headers:{'content-type':'application/json'},
      body:JSON.stringify({title:'Terminal control',source:'desktop',agentId:${JSON.stringify(created.agentId)}})
    });
    if(response.status!==201)throw new Error('Create chat: '+response.status+' '+await response.text());
    return (await response.json()).id;
  })()`);
  await app.eval(
    `window.catamorphicDesktop.sessionUseOwnWorktree(${JSON.stringify({ projectId, sessionId })})`,
  );
  await showChat();
  await click(composer);
  await app.insertText("Hello terminal control");
  await app.press("Enter");
  await app.waitFor(
    "document.body.textContent.includes('You said: Hello terminal control') && !document.querySelector('[data-testid=chat-stop]')",
    { timeoutMs: 30_000, label: "chat's assigned checkout ready" },
  );
  const assignment = await app.eval<{ path: string }>(
    `window.catamorphicDesktop.sessionCheckout(${JSON.stringify({ projectId, sessionId })})`,
  );
  checkout = await fs.realpath(assignment.path);
  expect(checkout).not.toBe(await fs.realpath(root));
  await app.eval(`
    window.__terminalControlOutput=[];
    window.__stopTerminalControlOutput=window.catamorphicDesktop.onTerminalData(data=>window.__terminalControlOutput.push(data));
    true;
  `);
});

afterAll(async () => {
  await app?.stop();
});

it("hands a live terminal's keys to the person, then marks its actual end", async () => {
  const terminalId = await startTerminal(
    `bash -c 'printf "TAKE_READY\\n"; IFS= read -r value; printf "TAKE_READ=%s\\n" "$value"; IFS= read -r finish'`,
  );
  await app.waitFor(
    `window.catamorphicDesktop.terminalBuffer(${JSON.stringify(terminalId)}).then(buffer=>buffer?.running && buffer.buffer.includes(${JSON.stringify("TAKE_READY\r\n")}))`,
    { label: "interactive command waiting for actual input" },
  );
  await click(`${pane} [data-agent-control-pill] button:last-child`);
  await app.waitFor(
    `!document.querySelector(${JSON.stringify(`${pane} [data-agent-control-pill]`)}) && !!document.activeElement?.closest(${JSON.stringify(pane)})`,
    { label: "terminal focused after the control pill leaves" },
  );
  await typeInTerminal("humaninput");
  await app.waitFor(
    `window.catamorphicDesktop.terminalBuffer(${JSON.stringify(terminalId)}).then(buffer=>buffer?.running && buffer.buffer.includes('TAKE_READ=humaninput'))`,
    { label: "trusted keyboard input reached the same live PTY" },
  );
  await typeInTerminal("finish");
  await app.waitFor(
    `window.catamorphicDesktop.terminalBuffer(${JSON.stringify(terminalId)}).then(buffer=>!buffer?.running)`,
    { label: "original command and terminal ended" },
  );
  await app.waitFor(
    `document.querySelector(${JSON.stringify(`${pane} [data-agent-control-pill]`)})?.textContent.includes('Command finished') && document.querySelector(${JSON.stringify(`${pane} [data-agent-control-pill] button:last-child`)})?.textContent==='Open new shell'`,
    { label: "ended status replaces the live takeover action" },
  );
  expect(
    await app.eval(
      `!!document.querySelector(${JSON.stringify(`${pane} [data-agent-control-pill] .animate-pulse`)})`,
    ),
  ).toBe(false);
  await app.press("w", process.platform === "darwin" ? 4 : 2);
  await app.waitFor(`!document.querySelector(${JSON.stringify(pane)})`);
  expect(app.getRendererErrors()).toEqual([]);
});

it("opens a fresh user shell after a finished command, preserving its history and chat folder", async () => {
  const gate = path.join(checkout, "terminal-control-gate");
  await fs.writeFile(gate, "hold the command until its tab is open\n");
  const oldId = await startTerminal(
    `bash -c 'printf "original\\n" >> takeover-runs.txt; printf "HISTORY_READY\\n"; while [ -f terminal-control-gate ]; do sleep 0.05; done'`,
  );
  await app.waitFor(
    `window.catamorphicDesktop.terminalBuffer(${JSON.stringify(oldId)}).then(buffer=>buffer?.running && buffer.buffer.includes(${JSON.stringify("HISTORY_READY\r\n")}))`,
    { label: "original command's history is present while agent-controlled" },
  );
  await fs.unlink(gate);
  await app.waitFor(
    `window.catamorphicDesktop.terminalBuffer(${JSON.stringify(oldId)}).then(buffer=>!buffer?.running && document.querySelector(${JSON.stringify(`${pane} [data-agent-control-pill]`)})?.textContent.includes('Command finished'))`,
    { label: "agent's command ended before opening a new shell" },
  );
  expect(
    await app.eval(
      `window.catamorphicDesktop.terminalRestoreBuffer(${JSON.stringify(oldId)}).then(history=>history?.buffer.includes('HISTORY_READY'))`,
    ),
  ).toBe(true);
  await app.eval("window.__terminalControlOutput=[];true");
  await click(`${pane} [data-agent-control-pill] button:last-child`);
  const newId = await app.waitFor<string>(
    `(async () => {
    const data=window.__terminalControlOutput.find(item=>item.sessionId!==${JSON.stringify(oldId)});
    if(!data)return false;
    const buffer=await window.catamorphicDesktop.terminalBuffer(data.sessionId);
    return buffer?.running?data.sessionId:false;
  })()`,
    { label: "fresh user PTY opened" },
  );
  expect(newId).not.toBe(oldId);
  await app.waitFor(
    `!document.querySelector(${JSON.stringify(`${pane} [data-agent-control-pill]`)}) && !!document.activeElement?.closest(${JSON.stringify(pane)}) && document.querySelectorAll(${JSON.stringify(`${pane} canvas`)}).length===1`,
    { label: "new shell focused in the retained terminal pane" },
  );
  await typeInTerminal('printf "NEW_PATH=%s\\n" "$(pwd -P)"');
  await app.waitFor(
    `window.catamorphicDesktop.terminalBuffer(${JSON.stringify(newId)}).then(buffer=>buffer?.running && buffer.buffer.includes(${JSON.stringify(`NEW_PATH=${checkout}`)}))`,
    { label: "new shell accepts real typing in the owning chat's checkout" },
  );
  expect(
    await fs.readFile(path.join(checkout, "takeover-runs.txt"), "utf8"),
  ).toBe("original\n");
  expect(
    await app.eval(
      `window.catamorphicDesktop.terminalBuffer(${JSON.stringify(oldId)}).then(buffer=>buffer?.running)`,
    ),
  ).toBe(false);
  expect(app.getRendererErrors()).toEqual([]);
});
