import type { Identity, WorkerNode } from "@catamorphic/core";
import {
  accessTier,
  MACHINE_CAPABILITIES,
  parseSignInCapability,
  type SignInHarness,
  signInCapability,
} from "@catamorphic/sandbox";
import { z } from "zod";
import {
  HarnessSignedOutSchema,
  HarnessSignInRefusedError,
  HarnessSignInRefusedSchema,
  type HarnessSignInRequest,
  type HarnessSignInStarted,
  HarnessSignInStartedSchema,
  type HarnessSignInStatus,
  HarnessSignInStatusSchema,
  type HarnessSignIns,
} from "./harness-sign-ins.js";
import { nodeAccess, type ScheduledPlacement } from "./placement.js";
import { isWorkerNode, WORKER_NODE_PREFIX } from "./worker-registry.js";

/*
 * A member's own machines, as the app shows them for Claude Code and Codex
 * sign-ins (ADRs 0213, 0340): workers whose access names only that member,
 * and a single server's own machine when its operator accepted personal
 * credentials there and no one else signed in on it first. A sign-in on
 * any other machine would show the provider several people's accounts
 * from one machine, so it is never offered, and placement would not run
 * on it.
 */

export type MemberSignInState = "signed-in" | "signed-out";

export interface MemberMachine {
  id: string;
  name: string;
  available: boolean;
  /** Whether the member is signed in to each harness on this machine. */
  signIns: Record<SignInHarness, MemberSignInState>;
}

/** The machine is not one the member may sign in on. */
export class NotYourMachineError extends Error {
  constructor() {
    super("This is not a machine of your own, so your sign-in cannot go on it");
    this.name = "NotYourMachineError";
  }
}

/** One of the member's machines and a harness on it. */
interface Target {
  identity: Identity;
  machineId: string;
  harness: SignInHarness;
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
      ownMachine?: { nodeId: string; signIns: HarnessSignIns };
      /** A request to a worker through the operation queue. */
      worker: (args: {
        nodeId: string;
        request: HarnessSignInRequest;
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
        signIns: signInStates((harness) =>
          node.descriptor.capabilities.includes(
            signInCapability({ harness, member }),
          )
            ? "signed-in"
            : "signed-out",
        ),
      }));
  }

  /** Throws {@link HarnessSignInRefusedError} with the machine's reason. */
  async begin(args: Target): Promise<HarnessSignInStarted> {
    const answer = z
      .union([HarnessSignInStartedSchema, HarnessSignInRefusedSchema])
      .parse(
        await this.send(args, {
          action: "begin",
          harness: args.harness,
          member: args.identity.externalUserId,
        }),
      );
    if ("refused" in answer)
      throw new HarnessSignInRefusedError(answer.refused);
    return answer;
  }

  /**
   * Where a sign-in stands. Signed in means usable: the machine placed the
   * login and placement sees it, so a chat started at once finds it.
   */
  async status(
    args: Target & { attempt: string },
  ): Promise<HarnessSignInStatus> {
    return this.usable(
      args,
      HarnessSignInStatusSchema.parse(
        await this.send(args, {
          action: "status",
          harness: args.harness,
          member: args.identity.externalUserId,
          attempt: args.attempt,
        }),
      ),
    );
  }

  /**
   * Hand a waiting login the code the member copied from their browser.
   * Answers where the sign-in stands, never the code. Throws
   * {@link HarnessSignInRefusedError} when the machine would not take it.
   */
  async input(
    args: Target & { attempt: string; text: string },
  ): Promise<HarnessSignInStatus> {
    const answer = z
      .union([HarnessSignInStatusSchema, HarnessSignInRefusedSchema])
      .parse(
        await this.send(args, {
          action: "input",
          harness: args.harness,
          member: args.identity.externalUserId,
          attempt: args.attempt,
          text: args.text,
        }),
      );
    if ("refused" in answer)
      throw new HarnessSignInRefusedError(answer.refused);
    return this.usable(args, answer);
  }

  async cancel(args: Target & { attempt: string }): Promise<void> {
    await this.send(args, {
      action: "cancel",
      harness: args.harness,
      member: args.identity.externalUserId,
      attempt: args.attempt,
    });
  }

  async signOut(args: Target): Promise<{ signedOut: boolean }> {
    return HarnessSignedOutSchema.parse(
      await this.send(args, {
        action: "signOut",
        harness: args.harness,
        member: args.identity.externalUserId,
      }),
    );
  }

  /** A machine's "signed in" counts once placement sees the sign-in too. */
  private async usable(
    args: Target,
    status: HarnessSignInStatus,
  ): Promise<HarnessSignInStatus> {
    if (status.state !== "signed-in") return status;
    const node = (await this.deps.nodes()).find(
      (entry) => entry.id === args.machineId,
    );
    const reported = node?.descriptor.capabilities.includes(
      signInCapability({
        harness: args.harness,
        member: args.identity.externalUserId,
      }),
    );
    return reported ? status : { state: "waiting" };
  }

  /** The member's own machine gets the request, and only then. */
  private async send(
    args: { identity: Identity; machineId: string },
    request: HarnessSignInRequest,
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

/** One state per harness a member signs in to. */
function signInStates(
  state: (harness: SignInHarness) => MemberSignInState,
): Record<SignInHarness, MemberSignInState> {
  return {
    "claude-code": state("claude-code"),
    codex: state("codex"),
  };
}
