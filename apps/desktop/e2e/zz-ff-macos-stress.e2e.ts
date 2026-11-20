import { execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { it } from "vitest";
import type { WindowSession } from "../src/main/window-state.js";
import {
  type AppHandle,
  createProjectWorkspace,
  type FrameHandle,
  launchApp,
  setReactValueJs,
} from "./harness.js";

// TEMPORARY evidence gathering on the macOS runner. Never merged: it only
// logs (PROFILE-STRESS, PALETTE-STRESS lines) and never fails.
const mac = process.platform === "darwin";
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function frontmostApplication(): string {
  try {
    const front = execFileSync("lsappinfo", ["front"], {
      encoding: "utf8",
      timeout: 5_000,
    }).trim();
    return execFileSync("lsappinfo", ["info", "-only", "name", front], {
      encoding: "utf8",
      timeout: 5_000,
    }).trim();
  } catch (error) {
    return `unknown (${String(error)})`;
  }
}

const windowState = (frame: Pick<FrameHandle, "eval">) =>
  frame
    .eval(
      "window.catamorphicDesktop.devWindow('get').then(({ visible, focused }) => ({ visible, focused, page: document.hasFocus() }))",
    )
    .catch(() => null);

async function profileRound(round: number, waitShown: boolean) {
  const app = await launchApp();
  let source: FrameHandle | undefined;
  try {
    const project = await app.eval<{ id: string }>(
      `window.catamorphicDesktop.createProject(${JSON.stringify({ name: "Personal work", rootPath: path.join(app.userDataDir, "personal") })})`,
    );
    await app.eval(
      `window.catamorphicDesktop.workspaceNavigate({projectId:${JSON.stringify(project.id)}})`,
    );
    await app.waitFor(
      `!!document.querySelector('[data-project-runtime="${project.id}"][data-workspace-visible="true"] [data-workspace-ready]')`,
    );
    await app.eval(`window.dispatchEvent(new KeyboardEvent('keydown', {
      key:'t', altKey:true, metaKey:true, bubbles:true
    }))`);
    await app.waitFor(
      '!!document.querySelector(\'[data-workspace-visible="true"] input[aria-label="Address and search bar"]\')',
    );
    await app.eval(`(() => { ${setReactValueJs};
      const input = document.querySelector('[data-workspace-visible="true"] input[aria-label="Address and search bar"]');
      setReactValue(input, 'data:text/html,<title>Personal page</title><p>Retained personal work</p>');
      input.dispatchEvent(new KeyboardEvent('keydown', { key:'Enter', bubbles:true, cancelable:true }));
    })()`);
    await app.waitFor(
      "!!document.querySelector('[data-workspace-visible=\"true\"] webview')",
    );
    const other = await app.eval<{ id: string }>(
      "window.catamorphicDesktop.profilesCreate('Empty source')",
    );
    await app.eval(
      `window.catamorphicDesktop.openProfileWindow(${JSON.stringify(other.id)})`,
    );
    let sourceId: string | undefined;
    for (let attempt = 0; attempt < 75 && !sourceId; attempt += 1) {
      const saved: WindowSession = JSON.parse(
        await fs.readFile(
          path.join(app.userDataDir, "window-state.json"),
          "utf8",
        ),
      );
      sourceId = saved.windows.find(
        (window) => window.profileId === other.id,
      )?.id;
      if (!sourceId) await sleep(200);
    }
    if (!sourceId) throw new Error("no source window saved");
    source = await app.connectToFrame(`window=${sourceId}`);
    const frame = source;
    await frame.waitFor(
      "!!document.querySelector('[aria-label=\"Switch profile: Empty source\"]')",
    );
    const atSwitcher = await windowState(frame);
    if (waitShown)
      await frame.waitFor(
        "window.catamorphicDesktop.devWindow('get').then(state => state.visible)",
        { label: "the empty window is shown" },
      );
    await app.eval(`window.dispatchEvent(new KeyboardEvent('keydown', {
      key:'p', metaKey:true, bubbles:true
    }))`);
    await app.waitFor(`(() => {
      const input = document.querySelector('[data-workspace-visible="true"] [data-palette="overlay"] textarea[aria-label="Search commands, pages, and more"]');
      return !!input && document.activeElement === input && !input.closest('[inert]');
    })()`);
    await app.eval(`(() => { ${setReactValueJs};
      setReactValue(document.activeElement, '>close current work window');
    })()`);
    await app.waitFor(
      "Array.from(document.activeElement.closest('[role=\"dialog\"]').querySelectorAll('[role=\"option\"]')).some(row => row.textContent.includes('Close current Work window'))",
    );
    await app.eval(
      "Array.from(document.activeElement.closest('[role=\"dialog\"]').querySelectorAll('[role=\"option\"]')).find(row => row.textContent.includes('Close current Work window')).dispatchEvent(new MouseEvent('mousedown', { bubbles:true, cancelable:true }))",
    );
    await app.waitFor(
      "window.catamorphicDesktop.devWindow('get').then(state => !state.visible)",
    );
    await frame.eval(
      "document.querySelector('[aria-label=\"Switch profile: Empty source\"]').click()",
    );
    await frame.waitFor(
      '!!document.querySelector(\'[role="dialog"][aria-label="Profiles"]:not([inert])\')',
    );
    const atPick = {
      personal: await windowState(app),
      empty: await windowState(frame),
      front: frontmostApplication(),
    };
    await frame.eval(
      "Array.from(document.querySelectorAll('[role=\"dialog\"][aria-label=\"Profiles\"] button')).find(button => button.textContent.includes('Default Profile')).click()",
    );
    let ok = true;
    await app
      .waitFor(
        "window.catamorphicDesktop.devWindow('get').then(state => state.visible && state.focused)",
        { timeoutMs: 6_000 },
      )
      .catch(() => {
        ok = false;
      });
    const after = {
      personal: await windowState(app),
      empty: await windowState(frame),
      front: frontmostApplication(),
    };
    const events = app
      .getOutput()
      .split("\n")
      .filter((line) => line.startsWith("[desktop] Window "))
      .map((line) => {
        const [id, event] = line.slice("[desktop] Window ".length).split(" ");
        return `${id === "app" ? "Work" : id === sourceId ? "empty" : "personal"} ${event}`;
      });
    console.log(
      `PROFILE-STRESS ${JSON.stringify({ round, waitShown, ok, atSwitcher, atPick, after, events })}`,
    );
  } catch (error) {
    console.log(`PROFILE-STRESS-ERROR ${round} ${String(error).slice(0, 600)}`);
  } finally {
    source?.close();
    await app.stop().catch((error: unknown) => {
      console.log(
        `PROFILE-STRESS-STOP ${round} ${String(error).slice(0, 300)}`,
      );
    });
  }
}

it.skipIf(!mac)(
  "stress: a profile picked from an empty window (logs only)",
  async () => {
    // The flow as it was (no wait for the empty window to be shown), then
    // with that wait: the events say what differs when it fails.
    for (let round = 0; round < 14; round += 1)
      await profileRound(round, round >= 10);
  },
  900_000,
);

it.skipIf(!mac)(
  "stress: a page focused just before Cmd+P (logs only)",
  async () => {
    let app: AppHandle | undefined;
    const server = http.createServer((request, response) => {
      response.setHeader("Content-Type", "text/html");
      response.end(`<title>Gamma handbook</title><p>${request.url}</p>`);
    });
    try {
      app = await launchApp();
      const handle = app;
      await handle.waitFor(`!!document.querySelector('[data-sidebar="left"]')`);
      await createProjectWorkspace({
        app: handle,
        name: "Palette focus",
        rootPath: path.join(handle.userDataDir, "palette-focus"),
      });
      await new Promise<void>((resolve) =>
        server.listen(0, "127.0.0.1", resolve),
      );
      const address = server.address();
      if (!address || typeof address === "string")
        throw new Error("no address");
      const helpers = `
${setReactValueJs}
const input=()=>[...document.querySelectorAll('[data-workspace-visible="true"] [aria-label="Search commands, pages, and more"]')].find(el=>!el.closest('[inert]') && el.getBoundingClientRect().width>0);
const key=(key, mods={})=>input().dispatchEvent(new KeyboardEvent('keydown',{key,bubbles:true,cancelable:true,...mods}));
const rows=()=>[...input().closest('[role="dialog"]').querySelectorAll('[role="option"]')];
`;
      const run = <T>(code: string) =>
        handle.eval<T>(`(()=>{${helpers};${code}})()`);
      const wait = (code: string, label?: string) =>
        handle.waitFor(`(()=>{${helpers};${code}})()`, label ? { label } : {});
      const cmdP = `window.dispatchEvent(new KeyboardEvent('keydown',{key:'p',metaKey:true,bubbles:true}))`;
      await wait(`return !!input()`);
      await run(
        `setReactValue(input(),${JSON.stringify(`http://127.0.0.1:${address.port}/gamma`)})`,
      );
      await wait(`return rows()[0]?.dataset.itemId==='web'`);
      await run(`key('Enter')`);
      await wait(`return !input()`);
      await wait(
        `return document.activeElement?.tagName === 'WEBVIEW'`,
        "the page took focus",
      );
      // A page taking focus while the overlay is open is the race itself.
      await run(`window.__pageTook = 0;
        document.addEventListener('focusin', (event) => {
          if (event.target?.tagName === 'WEBVIEW' && document.querySelector('[data-palette="overlay"]:not([inert], [inert] *)')) window.__pageTook += 1;
        }, true);
        return true`);
      const results: unknown[] = [];
      const delays = [0, 0, 2, 5, 10, 20, 50];
      for (let round = 0; round < 35; round += 1) {
        const delay = delays[round % delays.length];
        await run(
          `document.activeElement?.blur?.(); window.__pageTook = 0; return true`,
        );
        await sleep(150);
        await handle.eval(`new Promise((resolve) => requestAnimationFrame(() => {
          document.querySelector('[data-workspace-visible="true"] webview').focus();
          setTimeout(() => { ${cmdP}; resolve(true); }, ${delay});
        }))`);
        await sleep(700);
        results.push(
          await run<object>(
            `const a=document.activeElement; return {delay:${delay}, open: !!input(), focused: a===input(), tag: a?.tagName, pageTook: window.__pageTook}`,
          ),
        );
        await run(
          `window.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true})); return true`,
        );
        await wait(`return !input()`, "palette closed");
        await sleep(300);
      }
      console.log(`PALETTE-STRESS ${JSON.stringify(results)}`);
    } catch (error) {
      console.log(`PALETTE-STRESS-ERROR ${String(error).slice(0, 800)}`);
    } finally {
      await app?.stop().catch(() => {});
      server.close();
    }
  },
  300_000,
);
