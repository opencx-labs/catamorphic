import { expect, it } from "vitest";
import {
  verifyDesktopFuses,
  verifyDesktopSignature,
} from "./desktop-signature.js";

function fuseBinary(wire = "01001100", version = 1): Buffer {
  return Buffer.concat([
    Buffer.from("prefix:dL7pKGdnNz796PbbjQWNKmHXBZaB9tsX"),
    Buffer.from([version, wire.length]),
    Buffer.from(wire),
  ]);
}

const hardenedFuses = {
  runAsNode: false,
  enableCookieEncryption: true,
  enableNodeOptionsEnvironmentVariable: false,
  enableNodeCliInspectArguments: false,
  enableEmbeddedAsarIntegrityValidation: true,
  onlyLoadAppFromAsar: true,
  grantFileProtocolExtraPrivileges: false,
};

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
  const readBinary = (file: string) => {
    expect(file).toBe(
      "/release/Work.app/Contents/Frameworks/Electron Framework.framework/Electron Framework",
    );
    return fuseBinary();
  };
  expect(
    verifyDesktopSignature({ appPath: "/release/Work.app", run, readBinary }),
  ).toEqual({
    teamId: "TEAM123",
    protocols: {
      "browser-keychain": "work-browser-keychain 1",
      "voice-keys": "work-voice-keys 1",
      "voice-quiet": "work-voice-quiet 1",
    },
    architectures: ["arm64", "x86_64"],
    fuses: hardenedFuses,
  });
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
        readBinary: () => fuseBinary(),
      }),
    ).toThrow(message);
  },
);

it("verifies the actual fuses in every packaged binary slice", () => {
  expect(verifyDesktopFuses({ binary: fuseBinary() })).toEqual(hardenedFuses);
  expect(
    verifyDesktopFuses({ binary: Buffer.concat([fuseBinary(), fuseBinary()]) }),
  ).toEqual(hardenedFuses);
  expect(() =>
    verifyDesktopSignature({
      appPath: "/release/Work.app",
      run: fixture().run,
      readBinary: () => fuseBinary("11001100"),
    }),
  ).toThrow("runAsNode must be disabled");
  expect(() =>
    verifyDesktopFuses({
      binary: Buffer.concat([fuseBinary(), fuseBinary("11001100")]),
    }),
  ).toThrow("runAsNode must be disabled");
});

it.each([0, 1, 2, 3, 4, 5, 7])(
  "rejects a weakened packaged fuse at position %i",
  (index) => {
    const wire = [..."01001100"];
    wire[index] = wire[index] === "1" ? "0" : "1";
    expect(() =>
      verifyDesktopFuses({ binary: fuseBinary(wire.join("")) }),
    ).toThrow("Packaged Electron fuse");
  },
);

it.each([
  Buffer.from("not an Electron framework"),
  fuseBinary("01001100", 2),
  fuseBinary("0100110"),
  fuseBinary().subarray(0, -1),
  fuseBinary("r1001100"),
  Buffer.concat([fuseBinary(), fuseBinary(), fuseBinary()]),
])("fails closed for an absent or invalid fuse wire %#", (binary) => {
  expect(() => verifyDesktopFuses({ binary })).toThrow();
});
