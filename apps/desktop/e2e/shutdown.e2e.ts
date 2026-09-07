import { afterEach, describe, it } from "vitest";
import { type AppHandle, launchApp } from "./harness.js";

let app: AppHandle | undefined;
afterEach(async () => {
  await app?.stop();
});

describe("terminal shutdown", () => {
  it.each([1, 2, 3])(
    "exits cleanly with live and just-closed terminals (%i)",
    async () => {
      app = await launchApp();
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
