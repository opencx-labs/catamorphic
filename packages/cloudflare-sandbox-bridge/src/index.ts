import { DurableObject } from "cloudflare:workers";
import { Files } from "@cloudflare/sandbox";
import { bridgeRequest } from "./bridge.js";
import { INACTIVITY_TIMEOUT_MS, SandboxBridge } from "./sandbox.js";

/** The host's sandbox id addresses this object and its native container. */
export class NativeSandbox extends DurableObject<Env> {
  private readonly bridge: SandboxBridge;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    const container = ctx.container;
    if (!container) throw new Error("The sandbox container is not configured.");
    this.bridge = new SandboxBridge({ container, files: new Files(container) });
    // Native inactivity settings do not survive a Durable Object restart.
    if (container.running) {
      void ctx.blockConcurrencyWhile(() =>
        container.setInactivityTimeout(INACTIVITY_TIMEOUT_MS),
      );
    }
  }

  override fetch(request: Request): Promise<Response> {
    return this.bridge.fetch(request);
  }
}

export default {
  fetch(request: Request, env: Env): Promise<Response> {
    return bridgeRequest({
      request,
      apiKey: env.SANDBOX_API_KEY,
      sandboxes: env.NativeSandbox,
    });
  },
} satisfies ExportedHandler<Env>;
