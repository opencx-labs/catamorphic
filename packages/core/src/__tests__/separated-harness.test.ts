import { describe, expect, it } from "vitest";
import {
  SEPARATED_WITHOUT_AGENT_SIDE,
  separatedHarnessRefusal,
} from "../services/agent-sessions-service.js";

describe("a harness in a sandbox whose commands run apart (ADR 0332)", () => {
  const agentShare = { cpuMillis: 1000, memoryMb: 2048 };

  it("refuses one that runs in a sandbox made with no agent container", () => {
    expect(
      separatedHarnessRefusal({
        placement: "sandbox",
        separateCommands: {},
      }),
    ).toBe(SEPARATED_WITHOUT_AGENT_SIDE);
  });

  it("starts one that runs in the sandbox beside its agent container", () => {
    expect(
      separatedHarnessRefusal({
        placement: "sandbox",
        separateCommands: { agentResources: agentShare },
      }),
    ).toBeUndefined();
  });

  it("starts the built-in agent, which runs outside the sandbox, with or without one", () => {
    for (const separateCommands of [{}, { agentResources: agentShare }])
      expect(
        separatedHarnessRefusal({ placement: "host", separateCommands }),
      ).toBeUndefined();
    expect(
      separatedHarnessRefusal({
        placement: "sandbox",
        separateCommands: undefined,
      }),
    ).toBeUndefined();
  });
});
