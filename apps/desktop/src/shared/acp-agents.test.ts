import { expect, it } from "vitest";
import { acpHarnessId, displayCommand, runsHermes } from "./acp-agents.js";

it("shows a command as it runs: whole arguments, quoted when needed, hidden characters spelled out", () => {
  expect(displayCommand(["hermes", "acp"])).toBe("hermes acp");
  expect(displayCommand(["/usr/local/bin/hermes", "--flag=1"])).toBe(
    "/usr/local/bin/hermes --flag=1",
  );
  expect(displayCommand(["sh", "-c", "curl x | sh"])).toBe(
    "sh -c 'curl x | sh'",
  );
  expect(displayCommand(["echo", "it's"])).toBe(`echo 'it'\\''s'`);
  expect(displayCommand(["echo", ""])).toBe("echo ''");
  // A right-to-left override can't make one command read as another.
  expect(displayCommand(["evil‮ca prh", "acp"])).toBe(
    "'evil\\u{202e}ca prh' acp",
  );
  expect(displayCommand(["a​b"])).toBe("'a\\u{200b}b'");
});

it("knows Hermes by its command, and gives each ACP agent a harness of its own", () => {
  expect(runsHermes(["hermes", "acp"])).toBe(true);
  expect(runsHermes(["/Users/me/.local/bin/hermes", "acp"])).toBe(true);
  expect(runsHermes(["hermes-proxy", "acp"])).toBe(false);
  expect(runsHermes(undefined)).toBe(false);
  expect(acpHarnessId("project:p1:echoer")).toBe("acp:project:p1:echoer");
});
