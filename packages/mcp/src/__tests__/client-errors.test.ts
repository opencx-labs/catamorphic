import {
  ProtocolError,
  SdkError,
  SdkErrorCode,
} from "@modelcontextprotocol/client";
import { describe, expect, it } from "vitest";
import { mcpConnectionLost, mcpServerError } from "../client.js";

describe("telling a lost connection from the server's own answer", () => {
  it("passes on a JSON-RPC error the server sent", () => {
    const sent = new ProtocolError(-32602, "Invalid arguments");
    expect(mcpServerError(sent)).toEqual({
      code: -32602,
      message: expect.stringContaining("Invalid arguments"),
    });
    expect(mcpConnectionLost(sent)).toBe(false);
  });

  it("drops a client only when its connection is gone", () => {
    expect(
      mcpConnectionLost(
        new SdkError(SdkErrorCode.ConnectionClosed, "Connection closed"),
      ),
    ).toBe(true);
    expect(mcpConnectionLost(new TypeError("fetch failed"))).toBe(true);
    expect(
      mcpConnectionLost(new SdkError(SdkErrorCode.RequestTimeout, "timeout")),
    ).toBe(false);
    expect(
      mcpConnectionLost(
        new SdkError(SdkErrorCode.InvalidResult, "invalid structured content"),
      ),
    ).toBe(false);
    expect(mcpServerError(new Error("plain"))).toBeUndefined();
  });
});
