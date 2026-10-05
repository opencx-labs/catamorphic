import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  executorKey,
  nodeExecutor,
  WorkerNodesService,
} from "@catamorphic/core";
import {
  executorPublicKey,
  generateExecutorKeyPair,
} from "@catamorphic/sandbox";
import { sql } from "kysely";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { executionSettingsFromEnv } from "../execution-config.js";
import {
  createWorkServer,
  SERVER_TENANT_ID,
  type WorkServer,
} from "../server.js";
import { createTestDatabase, testServerOptions } from "../test-support.js";
import { WORKER_PROTOCOL, WORKER_PROTOCOL_HEADER } from "./worker-protocol.js";
import { startWorkWorker } from "./worker-runtime.js";

/** What every worker call states (ADR 0198). */
const PROTOCOL = { [WORKER_PROTOCOL_HEADER]: String(WORKER_PROTOCOL.server) };
const OPERATOR_SECRET = "rotation-test-operator-secret-with-32-characters";
const OFFER = {
  isolation: "process",
  workspaceRoot: "/workspace",
  capacity: { workspaces: 1 },
};

/** UUIDv7 epochs (ADR 0192), later ones sorting after earlier ones. */
let epochs = 0;
function epoch(): string {
  epochs += 1;
  return `01920000-0000-7000-8000-${String(epochs).padStart(12, "0")}`;
}

/**
 * Worker credentials rotate, and operations stay sealed to the key that
 * came with the current one (ADR 0206). Postgres-backed, as a deployment's
 * control plane is.
 */
describe.skipIf(!process.env.DATABASE_URL)(
  "worker credentials rotate (ADR 0206)",
  () => {
    let root: string;
    let database: Awaited<ReturnType<typeof createTestDatabase>>;
    let server: WorkServer;
    let base: string;
    let worker: Awaited<ReturnType<typeof startWorkWorker>> | undefined;

    beforeAll(async () => {
      root = fs.mkdtempSync(path.join(os.tmpdir(), "work-rotation-"));
      database = await createTestDatabase("work_rotation");
      server = await createWorkServer(
        testServerOptions({
          dataDir: path.join(root, "control-plane"),
          publicBases: ["https://rotation.example.test"],
          env: {
            DATABASE_URL: database.url,
            WORK_SECRET: "rotation-test-secret-with-at-least-32-characters",
            WORK_OPERATOR_SECRET: OPERATOR_SECRET,
            WORK_VAULT_KEY: Buffer.alloc(32, 5).toString("base64"),
            WORK_CONTROL_PLANE_WORKLOADS: "workflow",
            WORK_FAKE_AGENT: "1",
            PATH: process.env.PATH,
          },
        }),
      );
      await server.app.listen({ port: 0, host: "127.0.0.1" });
      const address = server.app.server.address();
      if (!address || typeof address === "string")
        throw new Error("No address");
      base = `http://127.0.0.1:${address.port}`;
    }, 120_000);

    afterAll(async () => {
      await worker?.stop();
      await server?.shutdown();
      await database?.drop();
      fs.rmSync(root, { recursive: true, force: true });
    });

    const db = () => server.catamorphic.core.db;

    function operator(method: "GET" | "POST", url: string, body?: unknown) {
      return server.operatorApp.inject({
        method,
        url,
        headers: {
          authorization: `Bearer ${OPERATOR_SECRET}`,
          ...(body ? { "content-type": "application/json" } : {}),
        },
        ...(body ? { payload: JSON.stringify(body) } : {}),
      });
    }

    /** A worker call made with `credential`. */
    function call(credential: string, route: string, body: unknown) {
      return server.app.inject({
        method: "POST",
        url: `/api/workers/${route}`,
        headers: {
          ...PROTOCOL,
          authorization: `Worker ${credential}`,
          "content-type": "application/json",
        },
        payload: JSON.stringify(body),
      });
    }

    async function enroll(name: string) {
      const enrollment = await operator("POST", "/_work/operator/workers", {
        name,
        trusted: true,
      });
      expect(enrollment.statusCode).toBe(201);
      const keys = generateExecutorKeyPair();
      const enrolled = await server.app.inject({
        method: "POST",
        url: "/api/workers/enroll",
        headers: PROTOCOL,
        payload: { code: enrollment.json().code, publicKey: keys.publicKey },
      });
      expect(enrolled.statusCode).toBe(200);
      return { credential: String(enrolled.json().credential), keys };
    }

    const registeredKey = (name: string) =>
      executorKey({ db: db(), executor: nodeExecutor(`worker.${name}`) });

    it("keeps the current credential until the rotated one is first used, so a lost answer strands nothing", async () => {
      const first = await enroll("rotor");
      const session = epoch();
      const connected = await call(first.credential, "connect", {
        session,
        offer: OFFER,
        publicKey: first.keys.publicKey,
      });
      expect(connected.statusCode).toBe(200);
      expect(connected.json().rotate).toBeUndefined();
      expect(await registeredKey("rotor")).toBe(first.keys.publicKey);

      // The operator asks; the worker hears it in its next answer and is
      // refused nothing meanwhile.
      expect(
        (await operator("POST", "/_work/operator/workers/rotor/rotate"))
          .statusCode,
      ).toBe(200);
      const renewed = await call(first.credential, "renew", { session });
      expect(renewed.statusCode).toBe(200);
      expect(renewed.json().rotate).toBe(true);
      const polled = await call(first.credential, "poll", {
        session,
        pollId: crypto.randomUUID(),
      });
      expect(polled.json()).toMatchObject({ jobs: [], rotate: true });

      // The first rotation's answer is lost on the way.
      const lostKeys = generateExecutorKeyPair();
      const lost = await call(first.credential, "rotate", {
        publicKey: lostKeys.publicKey,
      });
      expect(lost.statusCode).toBe(200);
      // The worker asks again with the credential it still holds.
      const nextKeys = generateExecutorKeyPair();
      const rotated = await call(first.credential, "rotate", {
        publicKey: nextKeys.publicKey,
      });
      expect(rotated.statusCode).toBe(200);
      const next = String(rotated.json().credential);
      expect(next).not.toBe(lost.json().credential);
      // The lost credential was replaced; the current one still works, and
      // operations are still sealed to its key.
      expect(
        (await call(String(lost.json().credential), "renew", { session }))
          .statusCode,
      ).toBe(401);
      expect(
        (await call(first.credential, "renew", { session })).statusCode,
      ).toBe(200);
      expect(await registeredKey("rotor")).toBe(first.keys.publicKey);

      // Its first use makes the new credential current and ends the old.
      const after = await call(next, "renew", { session });
      expect(after.statusCode).toBe(200);
      expect(after.json().rotate).toBeUndefined();
      expect(await registeredKey("rotor")).toBe(nextKeys.publicKey);
      expect(
        (await call(first.credential, "renew", { session })).statusCode,
      ).toBe(401);
      const listed = (await operator("GET", "/_work/operator/workers")).json();
      expect(listed.workers).toContainEqual(
        expect.objectContaining({ name: "rotor", rotationRequested: false }),
      );
    });

    it("asks for a rotation once a credential is 30 days old", async () => {
      const { credential, keys } = await enroll("aged");
      const session = epoch();
      await call(credential, "connect", {
        session,
        offer: OFFER,
        publicKey: keys.publicKey,
      });
      expect(
        (await call(credential, "renew", { session })).json().rotate,
      ).toBeUndefined();
      await db()
        .updateTable("work_workers")
        .set({ credential_issued_at: sql`now() - interval '31 days'` })
        .where("name", "=", "aged")
        .execute();
      expect((await call(credential, "renew", { session })).json().rotate).toBe(
        true,
      );
    });

    it("refuses a key other than the enrolled one, and takes a key from a worker enrolled before sealing", async () => {
      const { credential } = await enroll("keyed");
      const stranger = generateExecutorKeyPair();
      const refused = await call(credential, "connect", {
        session: epoch(),
        offer: OFFER,
        publicKey: stranger.publicKey,
      });
      expect(refused.statusCode).toBe(403);
      expect(refused.json().error).toContain("enroll it again");
      // A worker enrolled before operations were sealed has no key yet:
      // its credential vouches for the one it brings.
      await db()
        .deleteFrom("executor_keys")
        .where("executor", "=", nodeExecutor("worker.keyed"))
        .execute();
      const legacy = await call(credential, "connect", {
        session: epoch(),
        offer: OFFER,
        publicKey: stranger.publicKey,
      });
      expect(legacy.statusCode).toBe(200);
      expect(await registeredKey("keyed")).toBe(stranger.publicKey);
      // Revoking forgets it: nothing more is sealed to that machine.
      await server.operatorApp.inject({
        method: "DELETE",
        url: "/_work/operator/workers/keyed",
        headers: { authorization: `Bearer ${OPERATOR_SECRET}` },
      });
      expect(await registeredKey("keyed")).toBeUndefined();
    });

    it("a running worker rotates on the operator's request and keeps running sealed operations", async () => {
      const enrollment = await operator("POST", "/_work/operator/workers", {
        name: "runner",
        trusted: true,
      });
      const dataDir = path.join(root, "runner");
      const log: string[] = [];
      worker = await startWorkWorker({
        controlPlaneUrl: base,
        dataDir,
        enrollmentCode: enrollment.json().code,
        execution: executionSettingsFromEnv({
          PATH: process.env.PATH,
          WORK_MAX_WORKSPACES: "2",
        }),
        log: (line) => log.push(line),
      });
      const nodes = new WorkerNodesService(db());
      const remote = async () => {
        const [node] = (
          await nodes.list({
            tenantId: SERVER_TENANT_ID,
            authorityId: (
              await db()
                .selectFrom("worker_nodes")
                .select("authority_id")
                .where("id", "=", "worker.runner")
                .executeTakeFirstOrThrow()
            ).authority_id,
          })
        ).filter((candidate) => candidate.id === "worker.runner");
        return node?.available && node.remote
          ? nodes.remoteProvider({
              nodeId: node.id,
              offer: node.remote,
              label: "The worker",
            })
          : undefined;
      };
      await expect.poll(remote, { timeout: 20_000 }).toBeTruthy();
      const provider = await remote();
      if (!provider) throw new Error("The worker is not connected");
      const sandbox = await provider.createSandbox({});
      expect(
        await provider.executeCommand(sandbox.providerId, "echo before"),
      ).toMatchObject({ exitCode: 0, result: "before\n" });

      const credentialFile = path.join(dataDir, "worker-credential");
      const firstCredential = fs.readFileSync(credentialFile, "utf8").trim();
      const firstKey = await registeredKey("runner");
      expect(firstKey).toBe(
        executorPublicKey(
          fs.readFileSync(path.join(dataDir, "worker-key"), "utf8"),
        ),
      );
      expect(
        (await operator("POST", "/_work/operator/workers/runner/rotate"))
          .statusCode,
      ).toBe(200);
      // The worker rotates at its next call and uses the new credential.
      await expect
        .poll(() => registeredKey("runner"), { timeout: 30_000 })
        .not.toBe(firstKey);
      const rotatedCredential = fs.readFileSync(credentialFile, "utf8").trim();
      expect(rotatedCredential).not.toBe(firstCredential);
      expect(await registeredKey("runner")).toBe(
        executorPublicKey(
          fs.readFileSync(path.join(dataDir, "worker-key"), "utf8"),
        ),
      );
      expect(
        (
          await db()
            .selectFrom("work_workers")
            .select("rotation_requested_at")
            .where("name", "=", "runner")
            .executeTakeFirstOrThrow()
        ).rotation_requested_at,
      ).toBeNull();
      // The same sandbox keeps working, sealed to the new key.
      expect(
        await provider.executeCommand(sandbox.providerId, "echo after"),
      ).toMatchObject({ exitCode: 0, result: "after\n" });
      // The old credential ended.
      expect(
        (await call(firstCredential, "renew", { session: epoch() })).statusCode,
      ).toBe(401);
      await provider.destroySandbox(sandbox.providerId);
      expect(log).toContain("Rotated this worker's credential and key");
      expect(log.some((line) => line.includes("revoked"))).toBe(false);
    }, 60_000);
  },
);
