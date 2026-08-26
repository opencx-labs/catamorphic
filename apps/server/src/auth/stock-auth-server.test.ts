import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { buildStockServer } from "../server.js";

describe("stock auth server lifecycle", () => {
  it("accepts local agent provisioning only with the machine credential", async () => {
    const dataDir = fs.mkdtempSync(
      path.join(os.tmpdir(), "catamorphic-stock-auth-operator-"),
    );
    const server = await buildStockServer({
      dataDir,
      publicBases: ["http://127.0.0.1:4700"],
      env: { CATAMORPHIC_FAKE_AGENT: "1", PATH: process.env.PATH },
    });
    const password = "correct horse battery staple";
    const payload = { username: "grace", name: "Grace Hopper", password };

    try {
      const denied = await server.app.inject({
        method: "POST",
        url: "/_catamorphic/operator/users",
        payload,
      });
      expect(denied.statusCode).toBe(401);

      const operatorSecret = fs
        .readFileSync(path.join(dataDir, "operator-secret"), "utf8")
        .trim();
      const provisioned = await server.app.inject({
        method: "POST",
        url: "/_catamorphic/operator/users",
        headers: { authorization: `Bearer ${operatorSecret}` },
        payload,
      });
      expect(provisioned.statusCode).toBe(201);
      expect(provisioned.body).not.toContain(password);

      const signedIn = await server.stockAuth.signInUsername({
        username: "grace",
        password,
      });
      expect(signedIn.user.id).toBe(provisioned.json().user.id);
    } finally {
      await server.shutdown();
      fs.rmSync(dataDir, { recursive: true, force: true });
    }
  }, 120_000);

  it("migrates at boot and preserves a local user across restart", async () => {
    const dataDir = fs.mkdtempSync(
      path.join(os.tmpdir(), "catamorphic-stock-auth-server-"),
    );
    const options = {
      dataDir,
      publicBases: ["http://127.0.0.1:4700"],
      env: {
        CATAMORPHIC_FAKE_AGENT: "1",
        PATH: process.env.PATH,
      },
    };
    const liveServers = new Set<Awaited<ReturnType<typeof buildStockServer>>>();

    try {
      const first = await buildStockServer(options);
      liveServers.add(first);
      const created = await first.stockAuth.createLocalUser({
        username: "ada",
        name: "Ada Lovelace",
        password: "correct horse battery staple",
      });
      await first.shutdown();
      liveServers.delete(first);

      const second = await buildStockServer(options);
      liveServers.add(second);
      const signedIn = await second.stockAuth.signInUsername({
        username: "ada",
        password: "correct horse battery staple",
      });
      expect(signedIn.user.id).toBe(created.id);
      await second.shutdown();
      liveServers.delete(second);
    } finally {
      await Promise.all([...liveServers].map((server) => server.shutdown()));
      fs.rmSync(dataDir, { recursive: true, force: true });
    }
  }, 120_000);
});
