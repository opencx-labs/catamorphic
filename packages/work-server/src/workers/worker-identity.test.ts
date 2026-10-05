import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  executorPublicKey,
  generateExecutorKeyPair,
} from "@catamorphic/sandbox";
import { afterEach, describe, expect, it } from "vitest";
import { executionSettingsFromEnv } from "../execution-config.js";
import { loadWorkerIdentity, saveWorkerIdentity } from "./worker-identity.js";
import { startWorkWorker } from "./worker-runtime.js";

type Fetch = (input: string, init?: RequestInit) => Promise<Response>;

const dirs: string[] = [];
function dataDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "work-identity-"));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of dirs.splice(0))
    fs.rmSync(dir, { recursive: true, force: true });
});

const mode = (file: string) => fs.statSync(file).mode & 0o777;

describe("a worker's identity on disk (ADR 0206)", () => {
  it("keeps its credential and key owner-only", () => {
    const dir = dataDir();
    expect(loadWorkerIdentity(dir)).toBeUndefined();
    const keys = generateExecutorKeyPair();
    saveWorkerIdentity(dir, {
      credential: "worker.disk:first",
      privateKey: keys.privateKey,
    });
    expect(loadWorkerIdentity(dir)).toEqual({
      credential: "worker.disk:first",
      privateKey: keys.privateKey,
    });
    expect(fs.readdirSync(dir).sort()).toEqual([
      "worker-credential",
      "worker-key",
    ]);
    expect(mode(path.join(dir, "worker-credential"))).toBe(0o600);
    expect(mode(path.join(dir, "worker-key"))).toBe(0o600);
  });

  it("finishes a rotation a crash interrupted, and ignores one never written whole", () => {
    const dir = dataDir();
    const first = generateExecutorKeyPair();
    saveWorkerIdentity(dir, {
      credential: "worker.disk:first",
      privateKey: first.privateKey,
    });
    // The new pair was recorded, then the process died before installing it.
    const next = generateExecutorKeyPair();
    fs.writeFileSync(
      path.join(dir, "worker-identity.next"),
      JSON.stringify({
        credential: "worker.disk:second",
        privateKey: next.privateKey,
      }),
      { mode: 0o600 },
    );
    expect(loadWorkerIdentity(dir)).toEqual({
      credential: "worker.disk:second",
      privateKey: next.privateKey,
    });
    expect(fs.existsSync(path.join(dir, "worker-identity.next"))).toBe(false);
    // A record cut short never replaced anything.
    fs.writeFileSync(path.join(dir, "worker-identity.next"), '{"credent');
    expect(loadWorkerIdentity(dir)).toEqual({
      credential: "worker.disk:second",
      privateKey: next.privateKey,
    });
  });

  it("reads a worker enrolled before sealing, which has no key yet", () => {
    const dir = dataDir();
    fs.writeFileSync(path.join(dir, "worker-credential"), "worker.old:x\n");
    expect(loadWorkerIdentity(dir)).toEqual({ credential: "worker.old:x" });
  });
});

/**
 * A control plane in memory that answers each route from a script and
 * records which credential every call carried.
 */
function controlPlane(answer: (call: Call) => Response | Promise<Response>) {
  const calls: Call[] = [];
  const fetch: Fetch = async (input, init) => {
    const route = new URL(input).pathname.split("/").at(-1) ?? "";
    const credential =
      new Headers(init?.headers)
        .get("authorization")
        ?.replace(/^Worker /, "") ?? "";
    const body: unknown =
      typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
    const call = { route, credential, body };
    calls.push(call);
    const response = await answer(call);
    // An empty long poll waits, as the control plane's does.
    if (route === "poll" && response.status === 200)
      await new Promise((resolve) => {
        const timer = setTimeout(resolve, 100);
        init?.signal?.addEventListener("abort", () => {
          clearTimeout(timer);
          resolve(undefined);
        });
      });
    return response;
  };
  return { fetch, calls };
}
interface Call {
  route: string;
  credential: string;
  body: unknown;
}

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

function publicKeyOf(body: unknown): string | undefined {
  return typeof body === "object" &&
    body !== null &&
    "publicKey" in body &&
    typeof body.publicKey === "string"
    ? body.publicKey
    : undefined;
}

/** A worker whose data directory already holds an enrolled credential. */
function enrolledDir(credential: string, withKey = true) {
  const dir = dataDir();
  if (withKey)
    saveWorkerIdentity(dir, {
      credential,
      privateKey: generateExecutorKeyPair().privateKey,
    });
  else
    fs.writeFileSync(path.join(dir, "worker-credential"), `${credential}\n`, {
      mode: 0o600,
    });
  return dir;
}

const OLD = "worker.rotor:old-secret";

describe("a worker rotates its credential and key (ADR 0206)", () => {
  it("rotates when asked, with both on disk before it calls with them", async () => {
    const dir = enrolledDir(OLD);
    const rotations: string[] = [];
    const plane = controlPlane((call) => {
      if (call.route === "rotate") {
        rotations.push(publicKeyOf(call.body) ?? "");
        // What the worker saved must be on disk by its next call.
        return json(200, { credential: "worker.rotor:new-secret" });
      }
      // The control plane asks while the old credential is in use.
      const rotate = call.credential === OLD ? { rotate: true } : {};
      if (call.route === "connect")
        return json(200, { session: "s", nodeId: "worker.rotor", ...rotate });
      if (call.route === "poll") return json(200, { jobs: [], ...rotate });
      return json(200, { ok: true, ...rotate });
    });
    const log: string[] = [];
    const worker = await startWorkWorker({
      controlPlaneUrl: "http://127.0.0.1:1",
      dataDir: dir,
      execution: executionSettingsFromEnv({ PATH: process.env.PATH }),
      fetch: plane.fetch,
      log: (line) => log.push(line),
    });
    try {
      await expect
        .poll(() =>
          plane.calls.some(
            (call) =>
              call.route === "poll" &&
              call.credential === "worker.rotor:new-secret",
          ),
        )
        .toBe(true);
      expect(rotations).toHaveLength(1);
      const saved = loadWorkerIdentity(dir);
      expect(saved?.credential).toBe("worker.rotor:new-secret");
      // The key on disk is the one whose public half the worker sent.
      expect(executorPublicKey(saved?.privateKey ?? "")).toBe(rotations[0]);
      expect(mode(path.join(dir, "worker-key"))).toBe(0o600);
      // Once it called with the new credential, it never used the old one.
      const firstNew = plane.calls.findIndex(
        (call) => call.credential === "worker.rotor:new-secret",
      );
      expect(
        plane.calls.slice(firstNew).every((call) => call.credential !== OLD),
      ).toBe(true);
      expect(log).toContain("Rotated this worker's credential and key");
    } finally {
      await worker.stop();
    }
  }, 20_000);

  it("keeps working when a rotation's answer is lost, and rotates at the next request", async () => {
    const dir = enrolledDir(OLD);
    const rotations: string[] = [];
    const plane = controlPlane((call) => {
      if (call.route === "rotate") {
        rotations.push(publicKeyOf(call.body) ?? "");
        // The control plane issued a credential, but its answer is lost.
        if (rotations.length === 1)
          throw new TypeError("fetch failed: socket hang up");
        return json(200, { credential: "worker.rotor:second-secret" });
      }
      const rotate = call.credential === OLD ? { rotate: true } : {};
      if (call.route === "connect")
        return json(200, { session: "s", nodeId: "worker.rotor", ...rotate });
      if (call.route === "poll") return json(200, { jobs: [], ...rotate });
      return json(200, { ok: true, ...rotate });
    });
    const log: string[] = [];
    const worker = await startWorkWorker({
      controlPlaneUrl: "http://127.0.0.1:1",
      dataDir: dir,
      execution: executionSettingsFromEnv({ PATH: process.env.PATH }),
      fetch: plane.fetch,
      rotationRetryMs: 200,
      log: (line) => log.push(line),
    });
    try {
      await expect
        .poll(() => loadWorkerIdentity(dir)?.credential)
        .toBe("worker.rotor:second-secret");
      // Meanwhile it went on calling with the credential it had.
      const lost = plane.calls.findIndex((call) => call.route === "rotate");
      expect(
        plane.calls
          .slice(lost + 1)
          .some((call) => call.route === "poll" && call.credential === OLD),
      ).toBe(true);
      expect(log.some((line) => line.startsWith("Could not rotate"))).toBe(
        true,
      );
      // Each attempt brought a key of its own; the last one is on disk.
      expect(rotations).toHaveLength(2);
      expect(rotations[0]).not.toBe(rotations[1]);
      expect(executorPublicKey(loadWorkerIdentity(dir)?.privateKey ?? "")).toBe(
        rotations[1],
      );
      await expect
        .poll(() =>
          plane.calls.some(
            (call) => call.credential === "worker.rotor:second-secret",
          ),
        )
        .toBe(true);
    } finally {
      await worker.stop();
    }
  }, 20_000);

  it("calls again with the new credential when a call made with the old one is refused after a rotation", async () => {
    const dir = enrolledDir(OLD);
    const NEW = "worker.rotor:new-secret";
    // As the control plane does: the old credential ends once the new one
    // is first used.
    let newUsed = false;
    const waiting = new Set<() => void>();
    let asked = false;
    const plane = controlPlane(async (call) => {
      if (call.credential === NEW) {
        newUsed = true;
        for (const wake of waiting) wake();
      }
      if (call.credential === OLD && newUsed)
        return json(401, { error: "Worker credential required" });
      if (call.route === "rotate") return json(200, { credential: NEW });
      if (call.route === "connect")
        return json(200, { session: "s", nodeId: "worker.rotor" });
      if (call.route === "poll" && call.credential === OLD) {
        if (!asked) {
          asked = true;
          return json(200, { jobs: [], rotate: true });
        }
        // This long poll left with the old credential before the rotation
        // finished; it is answered only after the worker's renewal made
        // the new credential current.
        await new Promise<void>((resolve) => waiting.add(resolve));
        return json(401, { error: "Worker credential required" });
      }
      if (call.route === "poll") return json(200, { jobs: [] });
      return json(200, { ok: true });
    });
    const log: string[] = [];
    const worker = await startWorkWorker({
      controlPlaneUrl: "http://127.0.0.1:1",
      dataDir: dir,
      execution: executionSettingsFromEnv({ PATH: process.env.PATH }),
      fetch: plane.fetch,
      log: (line) => log.push(line),
    });
    try {
      // The heartbeat renews with the new credential within ten seconds;
      // the refused poll then goes again with it.
      await expect
        .poll(
          () =>
            plane.calls.some(
              (call) => call.route === "poll" && call.credential === NEW,
            ),
          { timeout: 20_000 },
        )
        .toBe(true);
      const refused = plane.calls.filter(
        (call) => call.route === "poll" && call.credential === OLD,
      );
      expect(refused).toHaveLength(2);
      expect(
        plane.calls.some(
          (call) => call.route === "renew" && call.credential === NEW,
        ),
      ).toBe(true);
      expect(log.some((line) => line.includes("revoked"))).toBe(false);
    } finally {
      await worker.stop();
    }
  }, 30_000);

  it("gives a worker enrolled before sealing a key, which it registers when it connects", async () => {
    const dir = enrolledDir(OLD, false);
    const plane = controlPlane((call) =>
      call.route === "connect"
        ? json(200, { session: "s", nodeId: "worker.rotor" })
        : call.route === "poll"
          ? json(200, { jobs: [] })
          : json(200, { ok: true }),
    );
    const worker = await startWorkWorker({
      controlPlaneUrl: "http://127.0.0.1:1",
      dataDir: dir,
      execution: executionSettingsFromEnv({ PATH: process.env.PATH }),
      fetch: plane.fetch,
    });
    try {
      await expect
        .poll(() => plane.calls.some((call) => call.route === "connect"))
        .toBe(true);
      const saved = loadWorkerIdentity(dir);
      expect(saved?.credential).toBe(OLD);
      expect(mode(path.join(dir, "worker-key"))).toBe(0o600);
      const connect = plane.calls.find((call) => call.route === "connect");
      expect(publicKeyOf(connect?.body)).toBe(
        executorPublicKey(saved?.privateKey ?? ""),
      );
    } finally {
      await worker.stop();
    }
  }, 20_000);
});
