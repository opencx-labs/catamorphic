import { expect, it } from "vitest";
import { verifyDesktopSignature } from "./desktop-signature.js";

function fixture({
  helperTeam = "TEAM123",
  developerId = true,
  protocol = 1,
} = {}) {
  const calls: Array<{ command: string; args: string[] }> = [];
  const run = (command: string, args: string[]) => {
    calls.push({ command, args });
    if (args.includes("--display"))
      return `${developerId ? "Authority=Developer ID Application: Test\n" : "Signature=adhoc\n"}TeamIdentifier=${args.at(-1)?.endsWith("browser-keychain") ? helperTeam : "TEAM123"}`;
    if (args[0] === "--version")
      return `catamorphic-browser-keychain ${protocol}`;
    return "";
  };
  return { run, calls };
}

it("verifies both signed binaries and never requests a browser key", () => {
  const { run, calls } = fixture();
  expect(
    verifyDesktopSignature({ appPath: "/release/Catamorphic.app", run }).teamId,
  ).toBe("TEAM123");
  expect(
    calls.filter((call) => call.command.endsWith("browser-keychain")),
  ).toEqual([
    {
      command: "/release/Catamorphic.app/Contents/MacOS/browser-keychain",
      args: ["--version"],
    },
  ]);
});

it.each([
  [{ developerId: false }, "Developer ID"],
  [{ helperTeam: "OTHER123" }, "same signing team"],
  [{ protocol: 2 }, "unsupported protocol"],
])(
  "rejects invalid release identity or helper protocol %j",
  (options, message) => {
    expect(() =>
      verifyDesktopSignature({
        appPath: "/release/Catamorphic.app",
        run: fixture(options).run,
      }),
    ).toThrow(message);
  },
);
