import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, it } from "vitest";
import { chromeBinary, launchPwa, type PwaHandle } from "./harness.js";

/**
 * The whole product loop against the REAL stock server (apps/server):
 * admin mints an invite over the admin API, the phone redeems the link,
 * and a scoped member chats with the (fake) assistant — including the
 * project-agent addressing a scoped identity requires.
 */

const SERVER_DIR = path.resolve(import.meta.dirname, "../../server");

const TYPE = (selector: string, value: string) => `
  (() => {
    const el = document.querySelector(${JSON.stringify(selector)});
    if (!el) return false;
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value").set.call(el, ${JSON.stringify(value)});
    el.dispatchEvent(new Event("input", { bubbles: true }));
    return true;
  })()
`;
const CLICK = (selector: string) => `
  (() => {
    const el = document.querySelector(${JSON.stringify(selector)});
    if (!el) return false;
    el.click();
    return true;
  })()
`;

describe.skipIf(!chromeBinary())("pwa against the stock server", () => {
  let app: PwaHandle;
  let dataDir: string;

  beforeAll(async () => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "pwa-stock-"));
    app = await launchPwa({
      backend: (apiPort) => ({
        command: "bun",
        args: ["src/index.ts"],
        cwd: SERVER_DIR,
        env: {
          PORT: String(apiPort),
          CATAMORPHIC_DATA_DIR: dataDir,
          CATAMORPHIC_FAKE_AGENT: "1",
          CATAMORPHIC_MDNS: "off",
        },
      }),
      mintLink: async (apiBase) => {
        const auth = JSON.parse(
          fs.readFileSync(path.join(dataDir, "auth.json"), "utf8"),
        ) as { tokens: Array<{ token: string; kind: string }> };
        const admin = auth.tokens.find((t) => t.kind === "admin");
        if (!admin) throw new Error("No admin token on disk");
        const headers = {
          authorization: `Bearer ${admin.token}`,
          "content-type": "application/json",
        };
        const project = (await fetch(
          `${apiBase.replace(/\/api$/, "")}/admin/projects`,
          { method: "POST", headers, body: JSON.stringify({ name: "brain" }) },
        ).then((r) => r.json())) as { id: string };
        const invite = (await fetch(
          `${apiBase.replace(/\/api$/, "")}/admin/invites`,
          {
            method: "POST",
            headers,
            body: JSON.stringify({ projectId: project.id, user: "sam" }),
          },
        ).then((r) => r.json())) as { token: string };
        return `catamorphic://connect?server=${encodeURIComponent(apiBase)}&token=${encodeURIComponent(invite.token)}&project=${project.id}&name=brain`;
      },
    });
  }, 180_000);

  afterAll(async () => {
    await app?.stop();
    if (dataDir) fs.rmSync(dataDir, { recursive: true, force: true });
  });

  it("redeems a real invite and chats as a scoped member", async () => {
    await app.waitFor(
      "!!document.querySelector('[data-testid=connect-input]')",
    );
    await app.eval(TYPE("[data-testid=connect-input]", app.connectLink));
    await app.waitFor(
      "!document.querySelector('[data-testid=connect-submit]').disabled",
    );
    await app.eval(CLICK("[data-testid=connect-submit]"));
    await app.waitFor("!!document.querySelector('[data-testid=new-chat]')", {
      timeoutMs: 30_000,
      label: "sessions screen",
    });
    await app.eval(CLICK("[data-testid=new-chat]"));
    await app.waitFor("!!document.querySelector('[data-testid=chat-input]')");
    // The send button unlocks once /me resolved the project agent.
    await app.eval(TYPE("[data-testid=chat-input]", "hello real server"));
    await app.waitFor(
      "!document.querySelector('[data-testid=chat-send]').disabled",
      { label: "send ready (me resolved)" },
    );
    await app.eval(CLICK("[data-testid=chat-send]"));
    try {
      await app.waitFor(
        "document.body.innerText.includes('Echo: hello real server')",
        {
          timeoutMs: 60_000,
          label: "assistant reply through the stock server",
        },
      );
    } catch (error) {
      const text = await app.eval<string>("document.body.innerText");
      throw new Error(`${String(error)}\n--- page text ---\n${text}`);
    }
  }, 120_000);
});
