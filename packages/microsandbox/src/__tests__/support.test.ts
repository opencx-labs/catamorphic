import { describe, expect, it } from "vitest";
import { microsandboxSupport } from "../support.js";

describe("microsandboxSupport", () => {
  const msb = () => "/opt/msb";

  it("runs on Apple silicon and on Linux with a usable /dev/kvm", () => {
    expect(
      microsandboxSupport({ platform: "darwin", arch: "arm64", msbPath: msb }),
    ).toEqual({ ok: true });
    expect(
      microsandboxSupport({
        platform: "linux",
        arch: "x64",
        kvmUsable: () => true,
        msbPath: msb,
      }),
    ).toEqual({ ok: true });
  });

  it("says how to proceed without KVM", () => {
    expect(
      microsandboxSupport({
        platform: "linux",
        arch: "arm64",
        kvmUsable: () => false,
        msbPath: msb,
      }),
    ).toEqual({
      ok: false,
      reason:
        "This machine has no usable /dev/kvm, so microsandbox cannot run here. Use WORK_SANDBOX=container (gVisor) or auto.",
    });
  });

  it("needs the msb runtime and a supported platform", () => {
    expect(
      microsandboxSupport({
        platform: "darwin",
        arch: "arm64",
        msbPath: () => undefined,
      }),
    ).toMatchObject({ ok: false, reason: expect.stringContaining("MSB_PATH") });
    expect(
      microsandboxSupport({ platform: "darwin", arch: "x64", msbPath: msb }),
    ).toMatchObject({ ok: false });
    expect(
      microsandboxSupport({ platform: "win32", arch: "x64", msbPath: msb }),
    ).toMatchObject({ ok: false });
  });

  it("finds msb through MSB_PATH", () => {
    expect(
      microsandboxSupport({
        platform: "darwin",
        arch: "arm64",
        env: { MSB_PATH: process.execPath },
      }),
    ).toEqual({ ok: true });
  });
});
