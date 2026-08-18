import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type AppHandle, launchApp } from "./harness.js";

/**
 * Remote projects end to end (ADR 0055): a member pastes a connect link,
 * picks a folder, and the app materializes what the server lets them see;
 * a local edit under store/ ships back with a version check. The "server"
 * is a tiny in-test HTTP server speaking the plugin's documents routes and
 * requiring the invite's bearer token.
 */

let app: AppHandle;
let server: http.Server;
let serverUrl: string;
const TOKEN = "invite-token";
const store = new Map<string, { version: number; text: string }>([
  ["store/customers/acme/notes.md", { version: 2, text: "Acme notes v2\n" }],
]);
const program = new Map<string, string>([
  ["docs/handbook.md", "# Handbook\n\nRefunds take 5 days.\n"],
]);
const writes: Array<{ path: string; ifVersion?: number; text: string }> = [];
const publications: Array<Record<string, unknown>> = [];
const proposals: Array<Record<string, unknown>> = [];

const helpers = `
  const $ = (selector) => document.querySelector(selector);
  const $$ = (selector) => [...document.querySelectorAll(selector)];
  const byText = (selector, text) =>
    $$(selector).find((el) => el.textContent.trim().includes(text));
  const setReactValue = (el, value) => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(el, value);
    el.dispatchEvent(new Event('input', { bubbles: true }));
  };
  const pressKey = (key, mods = {}) =>
    window.dispatchEvent(new KeyboardEvent('keydown',
      { key, bubbles: true, cancelable: true, ...mods }));
`;
const run = <T>(body: string) =>
  app.eval<T>(`(() => { ${helpers}\n${body} })()`);
const runWait = <T>(
  body: string,
  opts?: { timeoutMs?: number; label?: string },
) => app.waitFor<T>(`(() => { ${helpers}\n${body} })()`, opts);

function startFakeServer(): Promise<void> {
  server = http.createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    if (req.headers.authorization !== `Bearer ${TOKEN}`) {
      res.writeHead(401, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "Unauthorized" }));
      return;
    }
    const send = (
      status: number,
      body: unknown,
      headers: Record<string, string> = {},
    ) => {
      res.writeHead(status, { "content-type": "application/json", ...headers });
      res.end(typeof body === "string" ? body : JSON.stringify(body));
    };
    const readJson = (): Promise<Record<string, unknown>> =>
      new Promise((resolve) => {
        let raw = "";
        req.on("data", (chunk) => {
          raw += chunk;
        });
        req.on("end", () => resolve(raw ? JSON.parse(raw) : {}));
      });
    if (
      req.method === "POST" &&
      url.pathname === "/api/projects/remote-1/publications"
    ) {
      void readJson().then((body) => {
        publications.push(body);
        send(201, {
          slug: "shared-1",
          projectId: "remote-1",
          path: body.path,
          audience: body.audience,
          createdBy: "member",
          createdAt: new Date().toISOString(),
          revokedAt: null,
          url:
            body.audience === "public"
              ? "/public/remote-1/shared-1"
              : "/projects/remote-1/publications/shared-1",
        });
      });
      return;
    }
    if (
      req.method === "POST" &&
      url.pathname === "/api/projects/remote-1/proposals"
    ) {
      void readJson().then((body) => {
        proposals.push(body);
        send(201, {
          branch: "proposals/member/x-1",
          pullRequest: {
            url: "https://github.com/acme/brain/pull/7",
            number: 7,
          },
        });
      });
      return;
    }
    const m = /^\/api\/projects\/([^/]+)\/documents(\/[a-z]+)?$/.exec(
      url.pathname,
    );
    if (!m) return send(404, { error: "no route" });
    const sub = m[2] ?? "";
    if (req.method === "GET" && sub === "") {
      return send(200, [
        ...[...program].map(([p, text]) => ({
          path: p,
          source: "program",
          contentType: "text/markdown",
          size: -1,
          digest: `git:${text.length}`,
        })),
        ...[...store].map(([p, doc]) => ({
          path: p,
          source: "store",
          contentType: "text/markdown",
          size: doc.text.length,
          version: doc.version,
          writtenBy: "server",
        })),
      ]);
    }
    if (req.method === "GET" && sub === "/raw") {
      const p = url.searchParams.get("path") ?? "";
      const text = program.get(p) ?? store.get(p)?.text;
      if (text === undefined) return send(404, { error: "not found" });
      res.writeHead(200, {
        "content-type": "text/markdown",
        "x-catamorphic-document-source": program.has(p) ? "program" : "store",
        ...(store.has(p)
          ? { "x-catamorphic-document-version": String(store.get(p)?.version) }
          : {}),
      });
      res.end(text);
      return;
    }
    if (req.method === "PUT" && sub === "/content") {
      let raw = "";
      req.on("data", (chunk) => {
        raw += chunk;
      });
      req.on("end", () => {
        const body = JSON.parse(raw) as {
          path: string;
          base64?: string;
          text?: string;
          ifVersion?: number;
        };
        const current = store.get(body.path);
        const currentVersion = current?.version ?? 0;
        if (body.ifVersion !== undefined && body.ifVersion !== currentVersion) {
          return send(409, { error: "stale", currentVersion });
        }
        const text =
          body.text ??
          Buffer.from(body.base64 ?? "", "base64").toString("utf8");
        writes.push({ path: body.path, ifVersion: body.ifVersion, text });
        store.set(body.path, { version: currentVersion + 1, text });
        send(200, {
          path: body.path,
          source: "store",
          contentType: "text/markdown",
          size: text.length,
          version: currentVersion + 1,
          writtenBy: "member",
        });
      });
      return;
    }
    if (req.method === "GET" && sub === "/history") {
      const p = url.searchParams.get("path") ?? "";
      const doc = store.get(p);
      return send(
        200,
        doc
          ? [
              {
                version: doc.version,
                deleted: false,
                contentType: "text/markdown",
                size: doc.text.length,
                writtenBy: "server",
                writtenAt: new Date().toISOString(),
              },
            ]
          : [],
      );
    }
    return send(404, { error: "no route" });
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      serverUrl = `http://127.0.0.1:${port}/api`;
      resolve();
    });
  });
}

describe("remote projects (ADR 0055)", () => {
  let projectDir: string;

  beforeAll(async () => {
    await startFakeServer();
    app = await launchApp();
  }, 120_000);

  afterAll(async () => {
    await app?.stop();
    await new Promise<void>((resolve) => server?.close(() => resolve()));
  });

  it("connects from a pasted link and materializes the scoped tree", async () => {
    // The empty state offers connecting to a server beside "New project".
    await runWait(`return !!$('[data-testid="empty-connect-remote"]');`, {
      timeoutMs: 60_000,
      label: "empty-state connect button",
    });
    await run(
      `$('[data-testid="empty-connect-remote"]').click(); return true;`,
    );
    await runWait(`return !!$('[data-testid="remote-link-input"]');`, {
      label: "connect modal",
    });

    const link = `catamorphic://connect?server=${encodeURIComponent(serverUrl)}&token=${TOKEN}&project=remote-1&name=Acme%20brain`;
    await run(
      `setReactValue($('[data-testid="remote-link-input"]'), ${JSON.stringify(link)}); return true;`,
    );
    await runWait(
      `return $('[data-testid="remote-server-input"]').value.length > 0 && $('[data-testid="remote-name-input"]').value === 'Acme brain';`,
      {
        label: "link parsed into fields",
      },
    );
    await runWait(
      `const btn = $('[data-testid="remote-connect-submit"]'); if (btn && !btn.disabled) { btn.click(); return true; } return false;`,
      {
        label: "connect submit",
      },
    );

    // The Server section shows for the connected project.
    await runWait(`return !!$('[data-testid="remote-sync"]');`, {
      timeoutMs: 60_000,
      label: "Server section",
    });
    projectDir = path.join(app.userDataDir, "Catamorphic", "acme-brain");
    expect(
      fs.readFileSync(path.join(projectDir, "docs/handbook.md"), "utf8"),
    ).toContain("Refunds take 5 days");
    expect(
      fs.readFileSync(
        path.join(projectDir, "store/customers/acme/notes.md"),
        "utf8",
      ),
    ).toBe("Acme notes v2\n");
    // The store never enters the local git history.
    expect(
      fs.readFileSync(path.join(projectDir, ".gitignore"), "utf8"),
    ).toContain("store/");
  });

  it("ships a local store edit with the synced version", async () => {
    fs.writeFileSync(
      path.join(projectDir, "store/customers/acme/notes.md"),
      "Acme notes v2 + brief\n",
    );
    fs.mkdirSync(path.join(projectDir, "store/customers/acme"), {
      recursive: true,
    });
    fs.writeFileSync(
      path.join(projectDir, "store/customers/acme/brief.md"),
      "# Brief\n",
    );
    // Ship becomes enabled once the poll notices local changes.
    await runWait(
      `const btn = $('[data-testid="remote-ship"]'); return !!btn && !btn.disabled;`,
      {
        timeoutMs: 30_000,
        label: "ship enabled",
      },
    );
    await run(`$('[data-testid="remote-ship"]').click(); return true;`);
    await runWait(
      `const m = $('[data-testid="remote-message"]'); return !!m && m.textContent.includes('shipped');`,
      {
        timeoutMs: 30_000,
        label: "ship message",
      },
    );
    expect(writes.map((w) => `${w.path}@${w.ifVersion}`).sort()).toEqual([
      "store/customers/acme/brief.md@0",
      "store/customers/acme/notes.md@2",
    ]);
    expect(store.get("store/customers/acme/notes.md")).toEqual({
      version: 3,
      text: "Acme notes v2 + brief\n",
    });
  });

  it("Publish ships a dirty store file first, then hands back the link", async () => {
    fs.writeFileSync(
      path.join(projectDir, "store/customers/acme/brief.md"),
      "# Brief v2\n",
    );
    await runWait(`const row = byText('li', 'brief.md'); return !!row;`, {
      timeoutMs: 30_000,
      label: "brief.md listed as changed",
    });
    await run(
      `const row = byText('li', 'brief.md'); row.querySelector('[data-testid="remote-publish"]').click(); return true;`,
    );
    await runWait(`return !!$('[data-testid="publish-submit"]');`, {
      label: "publish modal",
    });
    await run(`$('[data-testid="publish-submit"]').click(); return true;`);
    await runWait(
      `const url = $('[data-testid="publish-url"]'); return !!url && url.value.includes('/projects/remote-1/publications/shared-1');`,
      { timeoutMs: 30_000, label: "publish url" },
    );
    // Shipped first (v2 of brief.md), then published.
    expect(writes.at(-1)).toMatchObject({
      path: "store/customers/acme/brief.md",
      ifVersion: 1,
      text: "# Brief v2\n",
    });
    expect(publications).toEqual([
      { path: "store/customers/acme/brief.md", audience: "members" },
    ]);
    await run(`pressKey('Escape'); return true;`);
  });

  it("Propose turns program edits into a pull request on the member's behalf", async () => {
    fs.writeFileSync(
      path.join(projectDir, "docs/handbook.md"),
      "# Handbook\n\nRefunds take 3 days.\n",
    );
    await runWait(`return !!$('[data-testid="remote-propose"]');`, {
      timeoutMs: 30_000,
      label: "propose button",
    });
    await run(`$('[data-testid="remote-propose"]').click(); return true;`);
    await runWait(`return !!$('[data-testid="propose-title"]');`, {
      label: "propose modal",
    });
    await run(
      `setReactValue($('[data-testid="propose-title"]'), 'Refunds now take 3 days'); return true;`,
    );
    await runWait(
      `const btn = $('[data-testid="propose-submit"]'); if (btn && !btn.disabled) { btn.click(); return true; } return false;`,
      { label: "propose submit" },
    );
    await runWait(
      `const r = $('[data-testid="propose-result"]'); return !!r && r.textContent.includes('#7');`,
      { timeoutMs: 30_000, label: "propose result" },
    );
    expect(proposals).toHaveLength(1);
    expect(proposals[0]).toMatchObject({
      title: "Refunds now take 3 days",
      changes: [
        {
          path: "docs/handbook.md",
          content: "# Handbook\n\nRefunds take 3 days.\n",
        },
      ],
    });
  });
});
