import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { sanitizeSidebarSourcePage } from "../shared/source-rows.js";
import type { ModuleLaunch } from "./module-sandbox.js";
import { SidebarSourceRuntime } from "./sidebar-source-runtime.js";

/**
 * Waits on what the OS delivers: file-watch events (FSEvents batches and
 * delays them under load), worker processes starting, writing and exiting.
 * vi.waitFor's one-second default is a budget a loaded machine overruns.
 */
const eventually = <T>(callback: () => T | Promise<T>) =>
  vi.waitFor(callback, { timeout: 10_000, interval: 25 });
const roots: string[] = [];
const runtimes: SidebarSourceRuntime[] = [];
afterEach(() => {
  for (const runtime of runtimes.splice(0)) runtime.dispose();
  for (const root of roots.splice(0))
    fs.rmSync(root, { recursive: true, force: true });
});
function setup(
  source: string,
  opts: {
    idleMs?: number;
    timeoutMs?: number;
    startTimeoutMs?: number;
    launch?: () => Promise<ModuleLaunch>;
    /** The whole environment the module's process gets. */
    env?: Record<string, string>;
    work?: (requestId: string, call: unknown) => Promise<unknown>;
  } = {},
) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "sidebar-source-"));
  roots.push(root);
  const modulePath = path.join(root, "source.ts");
  fs.writeFileSync(modulePath, source);
  const worker = path.join(import.meta.dirname, "sidebar-source-worker.ts");
  const { launch, env, ...rest } = opts;
  const runtime = new SidebarSourceRuntime({
    projectRoot: root,
    modulePath,
    // Unconfined here: module-sandbox.test.ts runs the real sandbox.
    launch:
      launch ??
      (async () => ({
        command: "bun",
        args: [worker, modulePath],
        env: { PATH: process.env.PATH ?? "", ...env },
        close: async () => {},
      })),
    ...rest,
  });
  runtimes.push(runtime);
  const load = (extra = {}) =>
    runtime.request({
      projectId: "p",
      sectionId: "s",
      method: "load",
      requestId: crypto.randomUUID(),
      ...extra,
    });
  return { root, modulePath, runtime, load };
}

it("reads files, serializes simultaneous writes, watches changes, and keeps console output out of RPC", async () => {
  const { root, runtime, load } = setup(`
    import { readFile, writeFile } from 'node:fs/promises';
    import { watch } from 'node:fs';
    export default {
      async load() { console.log('ordinary module logging'); const data = JSON.parse(await readFile('todos.json','utf8')); return {items: data.map(item=>({...item, label:item.text}))}; },
      subscribe({invalidate}) { const watcher=watch('.',(_event,name)=>{if(name==='todos.json') invalidate()}); return ()=>watcher.close(); },
      async action({itemId}) { const data=JSON.parse(await readFile('todos.json','utf8')); await new Promise(r=>setTimeout(r,25)); data.find(item=>item.id===itemId).done=true; await writeFile('todos.json',JSON.stringify(data)); }
    };
  `);
  fs.writeFileSync(
    path.join(root, "todos.json"),
    JSON.stringify([
      { id: "a", text: "Plan" },
      { id: "b", text: "Review" },
    ]),
  );
  const notify = vi.fn();
  const release = runtime.subscribe(notify);
  expect(await load()).toMatchObject({
    items: [
      { id: "a", label: "Plan" },
      { id: "b", label: "Review" },
    ],
  });
  await Promise.all(
    ["a", "b"].map((itemId) =>
      runtime.request({
        projectId: "p",
        sectionId: "s",
        requestId: crypto.randomUUID(),
        method: "action",
        itemId,
        action: "complete",
      }),
    ),
  );
  expect(
    JSON.parse(fs.readFileSync(path.join(root, "todos.json"), "utf8")),
  ).toMatchObject([{ done: true }, { done: true }]);
  await eventually(() => expect(notify).toHaveBeenCalled());
  release();
});

it("hands a session-scoped section's chat to load and actions, and nothing elsewhere (ADR 0226)", async () => {
  const { root, runtime, load } = setup(`
    import { writeFile } from 'node:fs/promises';
    export default {
      async load({ session }) {
        if (!session) return { items: [{ id: 'none', label: 'No chat' }] };
        const deploys = session.metadata.deploys ?? [];
        return { items: deploys.map((deploy) => ({ id: deploy.url, label: deploy.name, url: deploy.url, description: session.title })) };
      },
      async action({ session, itemId }) {
        await writeFile('acted.json', JSON.stringify({ session: session?.id, itemId }));
      },
    };
  `);
  const session = {
    id: "session-1",
    title: "Ship the preview",
    metadata: {
      deploys: [{ name: "Preview", url: "https://preview.example" }],
    },
  };
  expect(await load({ session })).toMatchObject({
    items: [
      {
        id: "https://preview.example",
        label: "Preview",
        description: "Ship the preview",
      },
    ],
  });
  expect(await load()).toMatchObject({ items: [{ id: "none" }] });
  await runtime.request({
    projectId: "p",
    sectionId: "s",
    requestId: crypto.randomUUID(),
    method: "action",
    itemId: "https://preview.example",
    action: "open",
    session,
  });
  expect(
    JSON.parse(fs.readFileSync(path.join(root, "acted.json"), "utf8")),
  ).toEqual({ session: "session-1", itemId: "https://preview.example" });
});

it("loads paged HTTP data, propagates HTTP failures and recovers on retry", async () => {
  let fail = false;
  const server = http.createServer((req, res) => {
    res.statusCode = fail ? 503 : 200;
    res.end(
      JSON.stringify({
        items: [{ id: req.url, label: "From HTTP" }],
        cursor: "next",
      }),
    );
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw Error("No port");
  const { load } = setup(
    `export default {async load({cursor,signal}) {const r=await fetch('http://127.0.0.1:${address.port}/'+(cursor??'first'),{signal}); if(!r.ok) throw Error('Service unavailable: '+r.status); return r.json()}};`,
  );
  try {
    expect(await load()).toMatchObject({
      items: [{ id: "/first" }],
      cursor: "next",
    });
    expect(await load({ cursor: "next" })).toMatchObject({
      items: [{ id: "/next" }],
    });
    fail = true;
    await expect(load()).rejects.toThrow("503");
    fail = false;
    expect(await load()).toMatchObject({ items: [{ id: "/first" }] });
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

it("cancels pending reads and starts a new load without publishing a stale response", async () => {
  const { runtime, load } = setup(
    `export default {async load({signal,cursor}) { if(!cursor) await new Promise((resolve,reject)=>{const t=setTimeout(resolve,5000);signal.addEventListener('abort',()=>{clearTimeout(t);reject(Error('aborted'))})}); return {items:[{id:cursor??'old',label:'Item'}]}}}`,
  );
  const old = load({ requestId: "old" });
  const rejected = expect(old).rejects.toThrow("cancelled");
  runtime.cancel("old");
  await rejected;
  expect(await load({ cursor: "new" })).toMatchObject({
    items: [{ id: "new" }],
  });
});

it("reports a hung load as too slow", async () => {
  const { load } = setup(`export default {async load(){ while(true){} }};`, {
    timeoutMs: 200,
  });
  await expect(load()).rejects.toThrow("too long");
});

it("gives up on a launch that never resolves, spawns nothing after, and releases it", async () => {
  let resolveLaunch: (launch: ModuleLaunch) => void = () => {};
  const { load, runtime } = setup(
    `export default {async load(){return {items:[]}}}`,
    {
      startTimeoutMs: 200,
      launch: () =>
        new Promise((resolve) => {
          resolveLaunch = resolve;
        }),
    },
  );
  await expect(load()).rejects.toThrow("took too long to start");
  // A launch arriving late must not start a worker for a dead request, and
  // what it holds (its proxy) is let go.
  const close = vi.fn(async () => {});
  resolveLaunch({ command: "bun", args: [], env: {}, close });
  await new Promise((resolve) => setImmediate(resolve));
  expect(Reflect.get(runtime, "child")).toBeUndefined();
  expect(close).toHaveBeenCalled();
});

it("survives a hung source, source edits and a worker crash", async () => {
  const { root, load, modulePath, runtime } = setup(
    `import {writeFileSync} from 'node:fs'; export default {async load(){ writeFileSync('hung', String(process.pid)); while(true){} }};`,
  );
  const notify = vi.fn();
  const release = runtime.subscribe(notify);
  const hung = load();
  const marker = path.join(root, "hung");
  const pid = await eventually(() => {
    const value = fs.readFileSync(marker, "utf8");
    expect(value).toMatch(/^\d+$/);
    return Number(value);
  });
  const replaced = expect(hung).rejects.toThrow("changed");
  fs.writeFileSync(
    modulePath,
    `export default {async load(){return {items:[{id:'recovered',label:'Ready'}]}}}`,
  );
  await replaced;
  await eventually(() => expect(notify).toHaveBeenCalled());
  // The retired worker never yields from its loop and is still killed.
  await eventually(() => expect(() => process.kill(pid, 0)).toThrow());
  expect(await load()).toMatchObject({ items: [{ id: "recovered" }] });
  notify.mockClear();
  fs.writeFileSync(
    modulePath,
    `export default {async load(){ process.exit(1) }}`,
  );
  await eventually(() => expect(notify).toHaveBeenCalled());
  await expect(load()).rejects.toThrow("stopped");
  release();
});

it("times a request from when a loaded worker receives it, not from process start", async () => {
  const { load } = setup(
    `await new Promise(r=>setTimeout(r,1200)); export default {async load(){ process.exit(1) }}`,
    { timeoutMs: 800 },
  );
  // Startup outlasts the request budget; the crash still reports as one.
  await expect(load()).rejects.toThrow("stopped");
});

it("ignores late protocol messages from a replaced worker", async () => {
  const { load, modulePath, runtime } = setup(`
    import {writeSync} from 'node:fs';
    process.on('SIGTERM', () => {
      setTimeout(() => {
        writeSync(3, JSON.stringify({type:'subscription-error',error:'Old worker cleanup failed'})+'\\n');
        process.exit(0);
      }, 150);
    });
    export default {async load(){return {items:[{id:'old',label:'Old'}]}}};
  `);
  const notify = vi.fn();
  const release = runtime.subscribe(notify);
  await load();
  fs.writeFileSync(
    modulePath,
    `export default {async load(){return {items:[{id:'new',label:'Ready'}]}}}`,
  );
  await eventually(() => expect(notify).toHaveBeenCalled());
  expect(await load()).toMatchObject({ items: [{ id: "new" }] });
  await new Promise((resolve) => setTimeout(resolve, 250));
  expect(notify.mock.calls.every(([error]) => error === undefined)).toBe(true);
  expect(await load()).toMatchObject({ items: [{ id: "new" }] });
  release();
});

it("reloads an atomically replaced entry without restarting for unrelated files", async () => {
  const { root, modulePath, runtime, load } = setup(
    `export default {async load(){return {items:[{id:String(process.pid),label:'Original'}]}}}`,
  );
  const notify = vi.fn();
  const release = runtime.subscribe(notify);
  const first = await load();
  fs.writeFileSync(path.join(root, "notes.txt"), "unrelated change");
  await new Promise((resolve) => setTimeout(resolve, 250));
  expect(notify).not.toHaveBeenCalled();
  expect(await load()).toEqual(first);
  const temporary = path.join(root, "replacement.tmp");
  fs.writeFileSync(
    temporary,
    `export default {async load(){return {items:[{id:'updated',label:'Updated'}]}}}`,
  );
  fs.renameSync(temporary, modulePath);
  await eventually(() => expect(notify).toHaveBeenCalled());
  expect(await load()).toMatchObject({ items: [{ id: "updated" }] });
  release();
});

it("releases subscriptions and retires idle processes", async () => {
  const { root, load, runtime } = setup(
    `import {writeFileSync} from 'node:fs'; export default {async load(){return {items:[{id:String(process.pid),label:'Process'}]}}, subscribe(){writeFileSync('watching','yes');return()=>writeFileSync('watching','no')}}`,
    { idleMs: 30 },
  );
  const release = runtime.subscribe(() => {});
  const first = await load();
  await eventually(() =>
    expect(fs.readFileSync(path.join(root, "watching"), "utf8")).toBe("yes"),
  );
  release();
  await eventually(() =>
    expect(fs.readFileSync(path.join(root, "watching"), "utf8")).toBe("no"),
  );
  await new Promise((resolve) => setTimeout(resolve, 80));
  expect(await load()).not.toEqual(first);
});

it("rejects malformed pages and preserves executable actions and display fields", () => {
  expect(() =>
    sanitizeSidebarSourcePage({
      items: [
        { id: "x", label: "A" },
        { id: "x", label: "B" },
      ],
    }),
  ).toThrow("unique");
  expect(() => sanitizeSidebarSourcePage({ items: [{ id: "x" }] })).toThrow(
    "labels",
  );
  expect(
    sanitizeSidebarSourcePage({
      items: [
        {
          id: "x",
          label: "A",
          description: "Details",
          actions: [{ action: "toggle", label: "Complete", icon: "Check" }],
        },
      ],
    }),
  ).toMatchObject({
    items: [
      { id: "x", description: "Details", actions: [{ action: "toggle" }] },
    ],
  });
  // A module names its own actions; run: is from before ADR 0234.
  expect(() =>
    sanitizeSidebarSourcePage({
      items: [
        {
          id: "x",
          label: "A",
          actions: [{ action: "run:toggle", label: "T" }],
        },
      ],
    }),
  ).toThrow("without run:");
});

it("answers a module's work calls for the request they serve, and gives it only the environment it was launched with", async () => {
  const calls: Array<{ requestId: string; call: unknown }> = [];
  const { load, runtime } = setup(
    `
    export default {
      async load({ work }) {
        const page = await work.read({ source: "tabs" });
        const output = await work.call({ workflow: "count", input: { n: 2 } });
        return { items: [
          ...page.items,
          { id: "env", label: process.env.CATAMORPHIC_TEST_TOOLCHAIN ?? "missing" },
          { id: "secret", label: process.env.CATAMORPHIC_TEST_SECRET ?? "none" },
          { id: "out", label: String(output.total) },
        ] };
      },
      async action({ work, itemId, action, values }) {
        await work.execute({ source: "tabs", itemId, action, values });
        return { message: "Closed " + itemId, open: "command:new-tab", mode: "tab" };
      },
    };
  `,
    {
      env: { CATAMORPHIC_TEST_TOOLCHAIN: "bun-here" },
      work: async (requestId, call) => {
        calls.push({ requestId, call });
        if (
          typeof call === "object" &&
          call !== null &&
          "op" in call &&
          call.op === "call"
        )
          return { total: 3 };
        return { items: [{ id: "browser:1", label: "Docs" }] };
      },
    },
  );
  const requestId = "window-1:load-1";
  expect(await load({ requestId })).toMatchObject({
    items: [
      { id: "browser:1", label: "Docs" },
      { id: "env", label: "bun-here" },
      // Work's own environment never reaches a module (ADR 0277).
      { id: "secret", label: "none" },
      { id: "out", label: "3" },
    ],
  });
  expect(calls).toEqual([
    { requestId, call: { op: "read", source: "tabs" } },
    {
      requestId,
      call: { op: "call", workflow: "count", input: { n: 2 } },
    },
  ]);
  calls.length = 0;
  expect(
    await runtime.request({
      projectId: "p",
      sectionId: "s",
      method: "action",
      requestId: "window-1:act-1",
      itemId: "browser:1",
      action: "close",
      values: { reason: "done" },
    }),
  ).toEqual({
    message: "Closed browser:1",
    open: "command:new-tab",
    mode: "tab",
  });
  expect(calls).toEqual([
    {
      requestId: "window-1:act-1",
      call: {
        op: "execute",
        source: "tabs",
        itemId: "browser:1",
        action: "close",
        values: { reason: "done" },
      },
    },
  ]);
});

it("fails a module's work call with the reason Work refused it", async () => {
  const { load } = setup(
    `export default { async load({ work }) {
      try { await work.read({ source: "chats" }); }
      catch (error) { return { items: [{ id: "e", label: error.message }] }; }
      return { items: [] };
    } };`,
    {
      work: async () => {
        throw new Error("This section does not grant Work's chats list.");
      },
    },
  );
  expect(await load()).toMatchObject({
    items: [
      { id: "e", label: "This section does not grant Work's chats list." },
    ],
  });
});

it("waits on Work without spending the module's own time, a few calls at once", async () => {
  const { load } = setup(
    `export default { async load({ work }) {
      const page = await work.read({ source: "tabs" });
      const many = await Promise.allSettled(
        Array.from({ length: 9 }, () => work.read({ source: "tabs" })),
      );
      const refused = many.find((result) => result.status === "rejected");
      return { items: [
        { id: "slow", label: String(page.items.length) },
        { id: "cap", label: refused ? refused.reason.message : "none" },
      ] };
    } };`,
    {
      timeoutMs: 300,
      // A workflow behind work.call can take longer than the budget.
      work: () =>
        new Promise((resolve) =>
          setTimeout(() => resolve({ items: [{ id: "t", label: "T" }] }), 600),
        ),
    },
  );
  expect(await load()).toMatchObject({
    items: [
      { id: "slow", label: "1" },
      { id: "cap", label: expect.stringContaining("At most 8 calls") },
    ],
  });
});

it("answers work only for a request the worker is serving", async () => {
  const work = vi.fn(async () => ({ items: [] }));
  const { load } = setup(
    `export default {
      async load({ work }) {
        // Called after load answered: no request is being served.
        setTimeout(() => work.read({ source: "tabs" }).catch((error) =>
          console.error(error.message)), 50);
        return { items: [] };
      },
    };`,
    { work },
  );
  await load();
  await new Promise((resolve) => setTimeout(resolve, 300));
  expect(work).not.toHaveBeenCalled();
});
