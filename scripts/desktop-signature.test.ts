import { expect, it } from "vitest";
import { verifyDesktopSignature } from "./desktop-signature.js";

function fixture({
  helperTeam = "TEAM123",
  voiceTeam = "TEAM123",
  quietTeam = "TEAM123",
  developerId = true,
  protocol = 1,
  voiceProtocol = 1,
  quietProtocol = 1,
} = {}) {
  const calls: Array<{ command: string; args: string[] }> = [];
  const run = (command: string, args: string[]) => {
    calls.push({ command, args });
    const file = args.at(-1) ?? "";
    if (args.includes("--display"))
      return `${developerId ? "Authority=Developer ID Application: Test\n" : "Signature=adhoc\n"}TeamIdentifier=${file.endsWith("browser-keychain") ? helperTeam : file.endsWith("voice-keys") ? voiceTeam : file.endsWith("voice-quiet") ? quietTeam : "TEAM123"}`;
    if (args[0] === "--version")
      return command.endsWith("voice-keys")
        ? `work-voice-keys ${voiceProtocol}`
        : command.endsWith("voice-quiet")
          ? `work-voice-quiet ${quietProtocol}`
          : `work-browser-keychain ${protocol}`;
    return "";
  };
  return { run, calls };
}

it("verifies every signed binary and only asks the helpers their version", () => {
  const { run, calls } = fixture();
  expect(verifyDesktopSignature({ appPath: "/release/Work.app", run })).toEqual(
    {
      teamId: "TEAM123",
      protocols: {
        "browser-keychain": "work-browser-keychain 1",
        "voice-keys": "work-voice-keys 1",
        "voice-quiet": "work-voice-quiet 1",
      },
      architectures: ["arm64", "x86_64"],
    },
  );
  expect(
    calls.filter((call) =>
      /(browser-keychain|voice-keys|voice-quiet)$/.test(call.command),
    ),
  ).toEqual([
    {
      command: "/release/Work.app/Contents/MacOS/browser-keychain",
      args: ["--version"],
    },
    {
      command: "/release/Work.app/Contents/MacOS/voice-keys",
      args: ["--version"],
    },
    {
      command: "/release/Work.app/Contents/MacOS/voice-quiet",
      args: ["--version"],
    },
  ]);
});

it.each([
  [{ developerId: false }, "Developer ID"],
  [{ helperTeam: "OTHER123" }, "same signing team"],
  [{ voiceTeam: "OTHER123" }, "Voice keys helper and app must have"],
  [{ protocol: 2 }, "unsupported protocol"],
  [{ voiceProtocol: 2 }, "Voice keys helper has an unsupported protocol"],
  [{ quietTeam: "OTHER123" }, "Voice quiet helper and app must have"],
  [{ quietProtocol: 2 }, "Voice quiet helper has an unsupported protocol"],
])(
  "rejects invalid release identity or helper protocol %j",
  (options, message) => {
    expect(() =>
      verifyDesktopSignature({
        appPath: "/release/Work.app",
        run: fixture(options).run,
      }),
    ).toThrow(message);
  },
);
