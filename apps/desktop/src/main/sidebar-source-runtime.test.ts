import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { SidebarSourceRuntime } from "./sidebar-source-runtime.js";
import { sanitizeSidebarSourcePage } from "./workspace-config.js";

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
    executable?: () => Promise<string>;
  } = {},
) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "sidebar-source-"));
  roots.push(root);
  const modulePath = path.join(root, "source.ts");
  fs.writeFileSync(modulePath, source);
  const runtime = new SidebarSourceRuntime({
    projectRoot: root,
    modulePath,
    workerPath: path.join(import.meta.dirname, "sidebar-source-worker.ts"),
    executable: async () => "bun",
    ...opts,
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

it("gives up on a toolchain that never resolves, and spawns nothing after", async () => {
  let resolveExecutable: (executable: string) => void = () => {};
  const { load, runtime } = setup(
    `export default {async load(){return {items:[]}}}`,
    {
      startTimeoutMs: 200,
      executable: () =>
        new Promise((resolve) => {
          resolveExecutable = resolve;
        }),
    },
  );
  await expect(load()).rejects.toThrow("took too long to start");
  // The toolchain arriving late must not start a worker for a dead request.
  resolveExecutable("bun");
  await new Promise((resolve) => setImmediate(resolve));
  expect(Reflect.get(runtime, "child")).toBeUndefined();
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
          actions: [{ action: "run:toggle", label: "Complete", icon: "Check" }],
        },
      ],
    }),
  ).toMatchObject({
    items: [
      { id: "x", description: "Details", actions: [{ action: "run:toggle" }] },
    ],
  });
});
