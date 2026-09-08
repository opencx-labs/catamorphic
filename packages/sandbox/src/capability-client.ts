import { z } from "zod";
import {
  type AgentCapabilityGateway,
  CapabilityPageSchema,
  DiscoverCapabilitiesSchema,
  InvokeCapabilitySchema,
} from "./agent-capabilities.js";

/** A host-supplied, session-scoped controller URL with credentials refreshed per call. */
export class HttpAgentCapabilityGateway implements AgentCapabilityGateway {
  private readonly url: URL;
  constructor(
    private readonly config: {
      url: string;
      allocationId?: string;
      headers(): Record<string, string> | Promise<Record<string, string>>;
    },
  ) {
    this.url = new URL(config.url);
    if (
      !["http:", "https:"].includes(this.url.protocol) ||
      this.url.username ||
      this.url.password ||
      this.url.search ||
      this.url.hash
    )
      throw new Error("Expected a credential-free HTTP capability base URL");
    this.url.pathname = this.url.pathname.replace(/\/$/, "");
  }
  async discover(input: Parameters<AgentCapabilityGateway["discover"]>[0]) {
    return CapabilityPageSchema.parse(
      await this.call("discover", DiscoverCapabilitiesSchema.parse(input)),
    );
  }
  async invoke(input: Parameters<AgentCapabilityGateway["invoke"]>[0]) {
    return z
      .object({ value: z.json() })
      .parse(
        await this.call(
          "invoke",
          InvokeCapabilitySchema.parse(input),
          input.signal,
        ),
      ).value;
  }
  private async call(
    operation: string,
    input: unknown,
    signal?: AbortSignal,
  ): Promise<unknown> {
    const headers = new Headers(await this.config.headers());
    headers.set("content-type", "application/json");
    if (this.config.allocationId)
      headers.set("x-catamorphic-allocation-id", this.config.allocationId);
    const response = await fetch(`${this.url}/${operation}`, {
      method: "POST",
      headers,
      body: JSON.stringify(input),
      signal,
      redirect: "error",
    });
    if (!response.ok)
      throw new Error(
        `Capability gateway rejected ${operation} (${response.status})`,
      );
    return response.json();
  }
}
