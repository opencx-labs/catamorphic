import { getTracer, withSpan } from "@catamorphic/otel";
import { z } from "zod";
import {
  type HetznerAction,
  HetznerActionSchema,
  HetznerCloudClient,
  type HetznerCloudClientOptions,
  HetznerCloudError,
  type HetznerImage,
  HetznerImageSchema,
  type HetznerServer,
  HetznerServerSchema,
} from "./client.js";

const tracer = getTracer("@catamorphic/hetzner");

/** The label every Work machine carries: its worker name. */
export const MACHINE_LABEL = "work-machine";
/** Labels a snapshot with the id of the server it was taken from. */
export const SNAPSHOT_SERVER_LABEL = "work-server-id";

/** What a Work machine is made of on Hetzner Cloud. */
export interface HetznerMachineSpec {
  /** The worker's name; also the server's name, unique in the project. */
  name: string;
  /** `cpx41`, `ccx33`, ... */
  serverType: string;
  /** `fsn1`, `nbg1`, `hel1`, `ash`, ... */
  location: string;
  /** An image name (`ubuntu-24.04`) or id. */
  image: string;
  /** SSH key names or ids for root, so an operator can reach the machine. */
  sshKeys?: readonly (string | number)[];
  /** Firewall ids applied to the server. */
  firewalls?: readonly number[];
  /** Private network ids the server joins. */
  networks?: readonly number[];
  labels?: Readonly<Record<string, string>>;
  /** Cloud-init user data, at most 32 KiB. */
  userData: string;
}

export interface HetznerCloudMachinesOptions {
  /** A client, or what to build one from. */
  client: HetznerCloudClient | HetznerCloudClientOptions;
  /**
   * How long one `destroy` waits for a snapshot it started (default 0: it
   * returns at once, and a later call finishes the destruction).
   */
  snapshotWaitMs?: number;
  /** How long one `destroy` waits for a deletion (default 1 minute). */
  deleteWaitMs?: number;
}

/**
 * Work machines on Hetzner Cloud (ADR 0205). Creation is idempotent by
 * name: a server already named so and labeled as this machine is the
 * machine. Destruction finds the server by its id or by its
 * `work-machine` label, succeeds when it is already gone, and can keep a
 * snapshot of its disk first, over as many calls as that takes.
 */
export class HetznerCloudMachines {
  readonly client: HetznerCloudClient;

  constructor(private readonly options: HetznerCloudMachinesOptions) {
    this.client =
      options.client instanceof HetznerCloudClient
        ? options.client
        : new HetznerCloudClient(options.client);
  }

  /** Create the machine's server, or find the one a previous call made. */
  create(spec: HetznerMachineSpec): Promise<{ ref: string; created: boolean }> {
    return withSpan(
      {
        tracer,
        name: "hetzner.machine.create",
        attributes: {
          "catamorphic.machine.name": spec.name,
          "catamorphic.machine.server_type": spec.serverType,
          "catamorphic.machine.location": spec.location,
        },
      },
      async (span) => {
        try {
          const body = await this.client.request({
            method: "POST",
            path: "/servers",
            body: {
              name: spec.name,
              server_type: spec.serverType,
              location: spec.location,
              image: spec.image,
              start_after_create: true,
              labels: { ...spec.labels, [MACHINE_LABEL]: spec.name },
              user_data: spec.userData,
              ...(spec.sshKeys?.length ? { ssh_keys: spec.sshKeys } : {}),
              ...(spec.firewalls?.length
                ? {
                    firewalls: spec.firewalls.map((firewall) => ({ firewall })),
                  }
                : {}),
              ...(spec.networks?.length ? { networks: spec.networks } : {}),
            },
          });
          const { server } = z
            .object({ server: HetznerServerSchema })
            .parse(body);
          span.setAttribute("catamorphic.machine.ref", String(server.id));
          return { ref: String(server.id), created: true };
        } catch (error) {
          if (
            !(error instanceof HetznerCloudError) ||
            error.code !== "uniqueness_error"
          )
            throw error;
          // A retry after a lost answer, or another replica's call: the
          // server with this name is this machine when it carries its label.
          const [existing] = await this.client.servers({ name: spec.name });
          if (!existing) throw error;
          if (existing.labels[MACHINE_LABEL] !== spec.name)
            throw new HetznerCloudError(
              409,
              "uniqueness_error",
              `A server named ${spec.name} already exists and was not created by Work; rename or delete it`,
            );
          if (existing.status === "deleting")
            throw new HetznerCloudError(
              409,
              "uniqueness_error",
              `The previous server named ${spec.name} is still being deleted; try again shortly`,
            );
          span.setAttribute("catamorphic.machine.ref", String(existing.id));
          return { ref: String(existing.id), created: false };
        }
      },
    );
  }

  /**
   * Delete the machine's server. `ref` is its id when known; otherwise it is
   * found by its `work-machine` label. With `snapshot`, an image of its disk
   * is kept first: the first call starts it, and until it is written a call
   * returns `done: false`, as it does while Hetzner is still deleting the
   * server. One call waits about a minute at most; call again until done.
   */
  destroy(args: {
    name: string;
    ref: string | null;
    snapshot?: {
      description: string;
      labels?: Readonly<Record<string, string>>;
    };
  }): Promise<{ done: boolean; deleted: number[]; snapshots: number[] }> {
    return withSpan(
      {
        tracer,
        name: "hetzner.machine.destroy",
        attributes: {
          "catamorphic.machine.name": args.name,
          "catamorphic.machine.snapshot": Boolean(args.snapshot),
        },
      },
      async (span) => {
        const servers = await this.find(args);
        const deleted: number[] = [];
        const snapshots: number[] = [];
        let done = true;
        for (const server of servers) {
          if (server.status === "deleting") {
            done = false;
            continue;
          }
          if (args.snapshot) {
            const image = await this.snapshot({
              server,
              ...args.snapshot,
              name: args.name,
            });
            if (image.status !== "available") {
              done = false;
              continue;
            }
            snapshots.push(image.id);
          }
          if (!(await this.delete(server))) {
            done = false;
            continue;
          }
          deleted.push(server.id);
        }
        span.setAttribute("catamorphic.machine.done", done);
        return { done, deleted, snapshots };
      },
    );
  }

  /** The machine's servers: by id when it carries the label, else by label. */
  private async find(args: {
    name: string;
    ref: string | null;
  }): Promise<HetznerServer[]> {
    const id = args.ref && /^\d+$/.test(args.ref) ? Number(args.ref) : null;
    if (id !== null) {
      const server = await this.client.server({ id });
      if (server && server.labels[MACHINE_LABEL] === args.name) return [server];
    }
    return this.client.servers({
      labelSelector: `${MACHINE_LABEL}=${args.name}`,
    });
  }

  /** Delete one server; false while Hetzner is still deleting it. */
  private async delete(server: HetznerServer): Promise<boolean> {
    let actionId: number;
    try {
      const body = await this.client.request({
        method: "DELETE",
        path: `/servers/${server.id}`,
      });
      actionId = z.object({ action: HetznerActionSchema }).parse(body)
        .action.id;
    } catch (error) {
      if (error instanceof HetznerCloudError && error.code === "not_found")
        return true;
      throw error;
    }
    try {
      // A name is reused only once its old server is gone.
      await this.client.waitForAction({
        id: actionId,
        timeoutMs: this.options.deleteWaitMs ?? 60_000,
      });
      return true;
    } catch (error) {
      if (error instanceof HetznerCloudError && error.code === "timeout")
        return false;
      throw error;
    }
  }

  /** The snapshot kept of a server, or being written, if any. */
  private async snapshotOf(
    server: HetznerServer,
  ): Promise<HetznerImage | undefined> {
    const images = await this.client.images({
      type: "snapshot",
      labelSelector: `${SNAPSHOT_SERVER_LABEL}=${server.id}`,
    });
    return images.find((image) => image.status === "available") ?? images[0];
  }

  /**
   * The server's snapshot: the one an earlier call kept or started, or one
   * started now. Starting one is never retried blindly, since a retry after
   * a lost answer would bill a second image: it looks for it instead.
   */
  private async snapshot(args: {
    server: HetznerServer;
    name: string;
    description: string;
    labels?: Readonly<Record<string, string>>;
  }): Promise<Pick<HetznerImage, "id" | "status">> {
    const kept = await this.snapshotOf(args.server);
    if (kept) return kept;
    let started: { image: HetznerImage; action: HetznerAction };
    try {
      const body = await this.client.request({
        method: "POST",
        path: `/servers/${args.server.id}/actions/create_image`,
        idempotent: false,
        body: {
          type: "snapshot",
          description: args.description,
          labels: {
            ...args.labels,
            [MACHINE_LABEL]: args.name,
            [SNAPSHOT_SERVER_LABEL]: String(args.server.id),
          },
        },
      });
      started = z
        .object({ image: HetznerImageSchema, action: HetznerActionSchema })
        .parse(body);
    } catch (error) {
      if (error instanceof HetznerCloudError && !error.definite) {
        const appeared = await this.snapshotOf(args.server);
        if (appeared) return appeared;
      }
      throw error;
    }
    try {
      await this.client.waitForAction({
        id: started.action.id,
        timeoutMs: this.options.snapshotWaitMs ?? 0,
      });
      return { id: started.image.id, status: "available" };
    } catch (error) {
      if (error instanceof HetznerCloudError && error.code === "timeout")
        return started.image;
      throw error;
    }
  }
}
