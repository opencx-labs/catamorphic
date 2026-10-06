import type { Identity, WorkerNode } from "@catamorphic/core";
import {
  accessTier,
  MACHINE_CAPABILITIES,
  parseSignInCapability,
  signInCapability,
} from "@catamorphic/sandbox";
import { z } from "zod";
import {
  CodexSignedOutSchema,
  CodexSignInRefusedError,
  CodexSignInRefusedSchema,
  type CodexSignInRequest,
  type CodexSignInStarted,
  CodexSignInStartedSchema,
  type CodexSignInStatus,
  CodexSignInStatusSchema,
  type CodexSignIns,
} from "./codex-sign-ins.js";
import { nodeAccess, type ScheduledPlacement } from "./placement.js";
import { isWorkerNode, WORKER_NODE_PREFIX } from "./worker-registry.js";

/*
 * A member's own machines, as the app shows them for Codex sign-ins (ADR
 * 0213): workers whose access names only that member, and a single
 * server's own machine when its operator accepted personal credentials
 * there and no one else signed in on it first. A sign-in on any other
 * machine would show the provider several people's accounts from one
 * machine, so it is never offered, and placement would not run on it.
 */

export interface MemberMachine {
  id: string;
  name: string;
  available: boolean;
  codex: "signed-in" | "signed-out";
}

/** The machine is not one the member may sign in on. */
export class NotYourMachineError extends Error {
  constructor() {
    super(
      "This is not a machine of your own, so your Codex sign-in cannot go on it",
    );
    this.name = "NotYourMachineError";
  }
}

export class MemberMachines {
  constructor(
    private readonly deps: {
      nodes: () => Promise<readonly WorkerNode[]>;
      placements: () => Promise<ReadonlyMap<string, ScheduledPlacement>>;
      /** The member's placement identity: their email and groups. */
      owner: (
        userId: string,
      ) => Promise<{ userId: string; groups: string[] } | undefined>;
      /**
       * The server's own machine, when it may hold a member's sign-in: a
       * single server whose operator accepted personal credentials.
       */
      ownMachine?: { nodeId: string; signIns: CodexSignIns };
      /** A request to a worker through the operation queue. */
      worker: (args: {
        nodeId: string;
        request: CodexSignInRequest;
      }) => Promise<unknown>;
    },
  ) {}

  async list(identity: Identity): Promise<MemberMachine[]> {
    const own = await this.own(identity);
    const nodes = await this.deps.nodes();
    const member = identity.externalUserId;
    return nodes
      .filter((node) => own.has(node.id))
      .map((node) => ({
        id: node.id,
        name: node.id.startsWith(WORKER_NODE_PREFIX)
          ? node.id.slice(WORKER_NODE_PREFIX.length)
          : node.descriptor.label,
        available: node.available,
        codex: node.descriptor.capabilities.includes(
          signInCapability({ harness: "codex", member }),
        )
          ? "signed-in"
          : "signed-out",
      }));
  }

  /** Throws {@link CodexSignInRefusedError} with the machine's reason. */
  async begin(args: {
    identity: Identity;
    machineId: string;
  }): Promise<CodexSignInStarted> {
    const answer = z
      .union([CodexSignInStartedSchema, CodexSignInRefusedSchema])
      .parse(
        await this.send(args, {
          action: "begin",
          member: args.identity.externalUserId,
        }),
      );
    if ("refused" in answer) throw new CodexSignInRefusedError(answer.refused);
    return answer;
  }

  async status(args: {
    identity: Identity;
    machineId: string;
    attempt: string;
  }): Promise<CodexSignInStatus> {
    return CodexSignInStatusSchema.parse(
      await this.send(args, {
        action: "status",
        member: args.identity.externalUserId,
        attempt: args.attempt,
      }),
    );
  }

  async cancel(args: {
    identity: Identity;
    machineId: string;
    attempt: string;
  }): Promise<void> {
    await this.send(args, {
      action: "cancel",
      member: args.identity.externalUserId,
      attempt: args.attempt,
    });
  }

  async signOut(args: {
    identity: Identity;
    machineId: string;
  }): Promise<{ signedOut: boolean }> {
    return CodexSignedOutSchema.parse(
      await this.send(args, {
        action: "signOut",
        member: args.identity.externalUserId,
      }),
    );
  }

  /** The member's own machine gets the request, and only then. */
  private async send(
    args: { identity: Identity; machineId: string },
    request: CodexSignInRequest,
  ): Promise<unknown> {
    const own = await this.own(args.identity);
    if (!own.has(args.machineId)) throw new NotYourMachineError();
    const ownMachine = this.deps.ownMachine;
    if (ownMachine && args.machineId === ownMachine.nodeId)
      return ownMachine.signIns.handle(request);
    return this.deps.worker({ nodeId: args.machineId, request });
  }

  /** The ids of the machines that are the member's own. */
  private async own(identity: Identity): Promise<Set<string>> {
    const [placements, owner] = await Promise.all([
      this.deps.placements(),
      this.deps.owner(identity.externalUserId),
    ]);
    const ids = new Set<string>();
    if (owner)
      for (const [nodeId, placement] of placements) {
        if (!isWorkerNode(nodeId) || placement.released) continue;
        if (accessTier({ access: nodeAccess(placement.access), owner }) === 0)
          ids.add(nodeId);
      }
    const ownMachine = this.deps.ownMachine;
    if (ownMachine) {
      const node = (await this.deps.nodes()).find(
        (entry) => entry.id === ownMachine.nodeId,
      );
      const capabilities = node?.descriptor.capabilities ?? [];
      const heldByOther = capabilities.some(
        (capability) =>
          (parseSignInCapability(capability)?.member ??
            identity.externalUserId) !== identity.externalUserId,
      );
      if (
        capabilities.includes(MACHINE_CAPABILITIES.personalCredentials) &&
        !heldByOther
      )
        ids.add(ownMachine.nodeId);
    }
    return ids;
  }
}
