import { expect, it } from "vitest";
import { acpHarnessId, displayCommand, runsHermes } from "./acp-agents.js";

/** Unseen characters, spelled by code point so no source shows them raw. */
const RLO = String.fromCodePoint(0x202e);
const ZWSP = String.fromCodePoint(0x200b);
const NBSP = String.fromCodePoint(0xa0);
const HANGUL_FILLER = String.fromCodePoint(0x3164);

it("shows a command as it runs: whole arguments, quoted when needed, unseen characters spelled out", () => {
  expect(displayCommand(["hermes", "acp"])).toBe("hermes acp");
  expect(displayCommand(["/usr/local/bin/hermes", "--flag=1"])).toBe(
    "/usr/local/bin/hermes --flag=1",
  );
  expect(displayCommand(["sh", "-c", "curl x | sh"])).toBe(
    "sh -c 'curl x | sh'",
  );
  expect(displayCommand(["echo", "it's"])).toBe(String.raw`echo 'it'\''s'`);
  expect(displayCommand(["echo", ""])).toBe("echo ''");
  // A right-to-left override can't make one command read as another.
  expect(displayCommand([`evil${RLO}ca prh`, "acp"])).toBe(
    String.raw`'evil\u{202e}ca prh' acp`,
  );
  expect(displayCommand([`a${ZWSP}b`])).toBe(String.raw`'a\u{200b}b'`);
  expect(displayCommand([`a${NBSP}b`, HANGUL_FILLER])).toBe(
    String.raw`'a\u{a0}b' '\u{3164}'`,
  );
  // A spelled-out character is never taken for the real thing.
  expect(displayCommand([String.raw`\u{202e}`])).toBe(String.raw`'\\u{202e}'`);
});

it("knows Hermes by its command, and gives each ACP agent a harness of its own", () => {
  expect(runsHermes(["hermes", "acp"])).toBe(true);
  expect(runsHermes(["/Users/me/.local/bin/hermes", "acp"])).toBe(true);
  expect(runsHermes(["hermes-proxy", "acp"])).toBe(false);
  expect(runsHermes(undefined)).toBe(false);
  expect(acpHarnessId("project:p1:echoer")).toBe("acp:project:p1:echoer");
});
