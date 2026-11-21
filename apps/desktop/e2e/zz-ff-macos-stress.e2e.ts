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
// logs (PROFILE-LOOP, PALETTE-LOOP lines) and never fails.
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
    .eval<{ visible: boolean; focused: boolean; page: boolean } | null>(
      "window.catamorphicDesktop.devWindow('get').then(({ visible, focused }) => ({ visible, focused, page: document.hasFocus() }))",
    )
    .catch(() => null);

/** One app; a profile picked from the empty window again and again. */
async function profileLoop(variant: string, rounds: number) {
  const summary = {
    variant,
    rounds: 0,
    kept: 0,
    lost: 0,
    never: 0,
    emptyNotKey: 0,
    error: "",
    details: [] as unknown[],
  };
  let app: AppHandle | undefined;
  let source: FrameHandle | undefined;
  try {
    app = await launchApp({ env: { FF_ACTIVATE: variant } });
    const handle = app;
    const project = await handle.eval<{ id: string }>(
      `window.catamorphicDesktop.createProject(${JSON.stringify({ name: "Personal work", rootPath: path.join(handle.userDataDir, "personal") })})`,
    );
    await handle.eval(
      `window.catamorphicDesktop.workspaceNavigate({projectId:${JSON.stringify(project.id)}})`,
    );
    await handle.waitFor(
      `!!document.querySelector('[data-project-runtime="${project.id}"][data-workspace-visible="true"] [data-workspace-ready]')`,
    );
    await handle.eval(`window.dispatchEvent(new KeyboardEvent('keydown', {
      key:'t', altKey:true, metaKey:true, bubbles:true
    }))`);
    await handle.waitFor(
      '!!document.querySelector(\'[data-workspace-visible="true"] input[aria-label="Address and search bar"]\')',
    );
    await handle.eval(`(() => { ${setReactValueJs};
      const input = document.querySelector('[data-workspace-visible="true"] input[aria-label="Address and search bar"]');
      setReactValue(input, 'data:text/html,<title>Personal page</title><p>Retained personal work</p>');
      input.dispatchEvent(new KeyboardEvent('keydown', { key:'Enter', bubbles:true, cancelable:true }));
    })()`);
    await handle.waitFor(
      "!!document.querySelector('[data-workspace-visible=\"true\"] webview')",
    );
    const other = await handle.eval<{ id: string }>(
      "window.catamorphicDesktop.profilesCreate('Empty source')",
    );
    await handle.eval(
      `window.catamorphicDesktop.openProfileWindow(${JSON.stringify(other.id)})`,
    );
    let sourceId: string | undefined;
    for (let attempt = 0; attempt < 75 && !sourceId; attempt += 1) {
      const saved: WindowSession = JSON.parse(
        await fs.readFile(
          path.join(handle.userDataDir, "window-state.json"),
          "utf8",
        ),
      );
      sourceId = saved.windows.find(
        (window) => window.profileId === other.id,
      )?.id;
      if (!sourceId) await sleep(200);
    }
    if (!sourceId) throw new Error("no source window saved");
    const emptyId = sourceId;
    source = await handle.connectToFrame(`window=${emptyId}`);
    const frame = source;
    await frame.waitFor(
      "!!document.querySelector('[aria-label=\"Switch profile: Empty source\"]')",
    );
    await frame.waitFor(
      "window.catamorphicDesktop.devWindow('get').then(state => state.visible)",
    );
    for (let round = 0; round < rounds; round += 1) {
      const mark = handle.getOutput().length;
      await handle.eval("window.close()");
      await handle.waitFor(
        "window.catamorphicDesktop.devWindow('get').then(state => !state.visible)",
        { timeoutMs: 5_000 },
      );
      const emptyKey = await frame
        .waitFor(
          "window.catamorphicDesktop.devWindow('get').then(state => state.focused)",
          { timeoutMs: 2_000 },
        )
        .then(
          () => true,
          () => false,
        );
      await frame.eval(
        "document.querySelector('[aria-label=\"Switch profile: Empty source\"]').click()",
      );
      await frame.waitFor(
        '!!document.querySelector(\'[role="dialog"][aria-label="Profiles"]:not([inert])\')',
        { timeoutMs: 5_000 },
      );
      await frame.eval(
        "Array.from(document.querySelectorAll('[role=\"dialog\"][aria-label=\"Profiles\"] button')).find(button => button.textContent.includes('Default Profile')).click()",
      );
      const came = await handle
        .waitFor(
          "window.catamorphicDesktop.devWindow('get').then(state => state.visible && state.focused)",
          { timeoutMs: 3_000 },
        )
        .then(
          () => true,
          () => false,
        );
      // The keys were seen taken back right after the workspace had them.
      await sleep(600);
      const after = {
        personal: await windowState(handle),
        empty: await windowState(frame),
      };
      const kept = after.personal?.focused === true;
      summary.rounds += 1;
      if (!emptyKey) summary.emptyNotKey += 1;
      if (kept) summary.kept += 1;
      else if (came) summary.lost += 1;
      else summary.never += 1;
      if (!kept || round < 2)
        summary.details.push({
          round,
          emptyKey,
          came,
          after,
          front: kept ? undefined : frontmostApplication(),
          log: handle
            .getOutput()
            .slice(mark)
            .split("\n")
            .filter((line) => /^\[desktop\] (Window|App|FF) /.test(line))
            .map((line) =>
              line
                .slice("[desktop] ".length)
                .replaceAll(emptyId, "empty")
                .replace(/[0-9a-f]{8}-[0-9a-f-]{27}/g, "personal"),
            ),
        });
      await frame
        .waitFor(
          "!document.querySelector('.animate-profile-veil-in, .animate-profile-veil-out') && !document.querySelector('[role=\"dialog\"][aria-label=\"Profiles\"]:not([inert])')",
          { timeoutMs: 5_000 },
        )
        .catch(() => {});
    }
  } catch (error) {
    summary.error = String(error).slice(0, 500);
  } finally {
    source?.close();
    await app?.stop().catch((error: unknown) => {
      summary.error += ` stop: ${String(error).slice(0, 200)}`;
    });
  }
  console.log(`PROFILE-LOOP ${JSON.stringify(summary)}`);
}

for (const variant of ["current", "nosteal", "showonly", "reassert"])
  it.skipIf(!mac)(
    `stress: a profile picked from an empty window, ${variant} (logs only)`,
    () => profileLoop(variant, 36),
    300_000,
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
      for (const guard of [false, true]) {
        await run(`window.__ffNoPaletteGuard = ${!guard}; return true`);
        let unfocused = 0;
        const rounds = 60;
        for (let round = 0; round < rounds; round += 1) {
          await run(`document.activeElement?.blur?.(); return true`);
          await sleep(100);
          await handle.eval(`new Promise((resolve) => requestAnimationFrame(() => {
            document.querySelector('[data-workspace-visible="true"] webview').focus();
            ${cmdP};
            resolve(true);
          }))`);
          await sleep(400);
          if (
            !(await run<boolean>(
              `return !!input() && document.activeElement === input()`,
            ))
          )
            unfocused += 1;
          await run(
            `window.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true})); return true`,
          );
          await wait(`return !input()`, "palette closed");
          await sleep(150);
        }
        console.log(
          `PALETTE-LOOP ${JSON.stringify({ guard, rounds, unfocused })}`,
        );
      }
    } catch (error) {
      console.log(`PALETTE-LOOP-ERROR ${String(error).slice(0, 800)}`);
    } finally {
      await app?.stop().catch(() => {});
      server.close();
    }
  },
  300_000,
);
