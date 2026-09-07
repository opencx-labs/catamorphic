import { once } from "node:events";
import { createConnection } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { type AppHandle, launchApp } from "./harness.js";

let app: AppHandle | undefined;
afterEach(async () => {
  await app?.stop();
});

describe("terminal shutdown", () => {
  it("closes an unfinished HTTP request before flushing the database", async () => {
    app = await launchApp();
    const url = new URL(
      await app.eval<string>(
        "window.catamorphicDesktop.getServerState().then(state => state.url)",
      ),
    );
    const socket = createConnection({
      host: url.hostname,
      port: Number(url.port),
    });
    try {
      await once(socket, "connect");
      // A connected client whose headers are still arriving is not an idle
      // keep-alive socket. server.close() alone waits for it indefinitely.
      socket.write(`GET /api/projects HTTP/1.1\r\nHost: ${url.host}\r\n`);
      // Closing an incomplete request may reset the socket on Linux.
      socket.on("error", () => {});
      const closed = new Promise<void>((resolve) =>
        socket.once("close", () => resolve()),
      );
      await app.stop();
      app = undefined;
      await closed;
      expect(socket.destroyed).toBe(true);
    } finally {
      socket.destroy();
    }
  });

  it.each([1, 2, 3])(
    "exits cleanly with live and just-closed terminals (%i)",
    async () => {
      app = await launchApp();
      await app.eval(`window.catamorphicDesktop.createProject({
        name: 'shutdown-recovery',
        rootPath: ${JSON.stringify(`${app.userDataDir}/shutdown-recovery`)}
      })`);
      const { userDataDir } = app;
      await app.kill();
      app = await launchApp({ userDataDir });
      await app.eval(`(async () => {
      const desktop = window.catamorphicDesktop;
      const terminals = await Promise.all(Array.from({length: 3}, () => desktop.terminalCreate({})));
      await desktop.terminalKill(terminals[1].sessionId);
      return true;
    })()`);
      // stop validates the process exit status, not just the UI assertions.
      await app.stop();
      app = undefined;
    },
  );
});
