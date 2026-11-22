import type {
  MachineCreateRequest,
  MachinesHook,
  MachineTarget,
} from "@catamorphic/work-server";

/*
 * A Work server's machines on Hetzner Cloud (ADR 0349): the provisioner
 * half of a machines hook, as host code from the `machines-hetzner` pack,
 * yours to change. `hetznerMachines(...)` returns `create`, `destroy`,
 * `stop`, `start` and `describe`; your `plan` decides which machines exist:
 *
 *   hooks: { machines: { plan, ...hetznerMachines({ token, defaults, userData }) } }
 *
 * A machine's shape is its plan entry's `options`, laid over `defaults`:
 *
 *   serverType  "cpx41", "ccx33", ...
 *   location    "fsn1", "nbg1", "hel1", "ash", "hil", "sin"
 *   image       an image name such as "ubuntu-24.04", or an image id
 *   sshKeys     optional; SSH key names or ids for root
 *   firewalls   optional; firewall ids
 *   networks    optional; private network ids
 *
 * Hetzner has no idempotency token: one server per machine is kept by its
 * unique name and a `work-key` label carrying the create's key.
 */

export interface HetznerMachineOptions {
  serverType: string;
  location: string;
  image: string;
  sshKeys?: readonly (string | number)[];
  firewalls?: readonly number[];
  networks?: readonly number[];
}

type Fetch = (input: string, init?: RequestInit) => Promise<Response>;

export interface HetznerMachinesConfig {
  /** A project API token with read and write permission. */
  token: string;
  /** Options every machine starts from; a plan entry's `options` override them. */
  defaults?: Partial<HetznerMachineOptions>;
  /**
   * The user data a new machine boots with (at most 32 KiB): it must start
   * the Work worker with the enrollment. `workerUserData` from the
   * `machines-install` pack builds it.
   */
  userData(request: MachineCreateRequest): string;
  /** Labels on every server beside Work's own, for the project's bookkeeping. */
  labels?: Readonly<Record<string, string>>;
  /** Keep a snapshot of a machine's disk before it is destroyed. */
  snapshot?: boolean;
  /** Default https://api.hetzner.cloud/v1. */
  baseUrl?: string;
  fetch?: Fetch;
  /** The clock (tests move it). */
  now?: () => number;
}

/** The label every Work machine carries: its name. */
export const MACHINE_LABEL = "work-machine";
/** The label carrying the key of the create that made a server. */
export const KEY_LABEL = "work-key";
/** Labels a snapshot with the id of the server it was taken from. */
export const SNAPSHOT_SERVER_LABEL = "work-server-id";

/** A call Hetzner Cloud answered with an error, by its error code. */
export class HetznerCloudError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(`Hetzner Cloud: ${message} (${code})`);
    this.name = "HetznerCloudError";
  }

  /**
   * Hetzner refused the request (a 4xx other than 429): nothing was made
   * or changed, and asking again the same way fails the same way.
   */
  get definite(): boolean {
    return this.status >= 400 && this.status < 500 && this.status !== 429;
  }
}

interface HetznerServer {
  id: number;
  name: string;
  status: string;
  labels: Record<string, string>;
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? Object.fromEntries(Object.entries(value))
    : {};
}

function serverOf(value: unknown): HetznerServer | undefined {
  const server = record(value);
  if (typeof server.id !== "number" || typeof server.name !== "string")
    return undefined;
  const labels: Record<string, string> = {};
  for (const [key, label] of Object.entries(record(server.labels)))
    if (typeof label === "string") labels[key] = label;
  return {
    id: server.id,
    name: server.name,
    status: typeof server.status === "string" ? server.status : "unknown",
    labels,
  };
}

/** Hetzner label values hold at most 63 characters. */
function keyLabel(idempotencyKey: string): string {
  return idempotencyKey.slice(0, 63);
}

/** The provisioner verbs of a machines hook, on Hetzner Cloud. */
export function hetznerMachines(
  config: HetznerMachinesConfig,
): Pick<MachinesHook, "create" | "destroy" | "stop" | "start" | "describe"> {
  if (!config.token) throw new Error("A Hetzner Cloud API token is required");
  const baseUrl = (config.baseUrl ?? "https://api.hetzner.cloud/v1").replace(
    /\/+$/,
    "",
  );
  const doFetch: Fetch = config.fetch ?? ((input, init) => fetch(input, init));
  const defaults = config.defaults ?? {};

  /** One API call; resolves with the parsed body (null for an empty one). */
  const request = async (args: {
    method: "GET" | "POST" | "DELETE";
    path: string;
    query?: Readonly<Record<string, string | number | undefined>>;
    body?: unknown;
  }): Promise<unknown> => {
    const url = new URL(`${baseUrl}${args.path}`);
    for (const [key, value] of Object.entries(args.query ?? {}))
      if (value !== undefined) url.searchParams.set(key, String(value));
    const response = await doFetch(url.toString(), {
      method: args.method,
      headers: {
        authorization: `Bearer ${config.token}`,
        accept: "application/json",
        ...(args.body === undefined
          ? {}
          : { "content-type": "application/json" }),
      },
      ...(args.body === undefined ? {} : { body: JSON.stringify(args.body) }),
      signal: AbortSignal.timeout(30_000),
    });
    if (response.ok) {
      const text = await response.text();
      return text ? JSON.parse(text) : null;
    }
    const error = record(record(await response.json().catch(() => null)).error);
    throw new HetznerCloudError(
      response.status,
      typeof error.code === "string" ? error.code : "http_error",
      typeof error.message === "string"
        ? error.message
        : `${args.method} ${args.path} answered ${response.status}`,
    );
  };

  /** Every item of a paginated list. */
  const list = async (args: {
    path: string;
    key: string;
    query: Readonly<Record<string, string | undefined>>;
  }): Promise<unknown[]> => {
    const items: unknown[] = [];
    let page: number | null = 1;
    for (let count = 0; page !== null && count < 100; count += 1) {
      const body = record(
        await request({
          method: "GET",
          path: args.path,
          query: { ...args.query, page, per_page: 50 },
        }),
      );
      const entries = body[args.key];
      if (!Array.isArray(entries))
        throw new HetznerCloudError(
          200,
          "invalid_response",
          `GET ${args.path} returned no ${args.key}`,
        );
      items.push(...entries);
      const next = record(record(body.meta).pagination).next_page;
      page = typeof next === "number" ? next : null;
    }
    return items;
  };
  const servers = async (query: {
    name?: string;
    labelSelector?: string;
  }): Promise<HetznerServer[]> =>
    (
      await list({
        path: "/servers",
        key: "servers",
        query: { name: query.name, label_selector: query.labelSelector },
      })
    ).flatMap((entry) => {
      const server = serverOf(entry);
      return server ? [server] : [];
    });
  /** The server with this id, or undefined once it is gone. */
  const serverById = async (id: number): Promise<HetznerServer | undefined> => {
    try {
      return serverOf(
        record(await request({ method: "GET", path: `/servers/${id}` })).server,
      );
    } catch (error) {
      if (error instanceof HetznerCloudError && error.code === "not_found")
        return undefined;
      throw error;
    }
  };

  /**
   * The machine's servers: the one `create` answered, when it still
   * carries this machine's label, and any made with its key or carrying
   * its name whose create answer was lost.
   */
  const serversOf = async (target: MachineTarget): Promise<HetznerServer[]> => {
    const found = new Map<number, HetznerServer>();
    const id =
      target.ref && /^\d+$/.test(target.ref) ? Number(target.ref) : null;
    if (id !== null) {
      const server = await serverById(id);
      if (server && server.labels[MACHINE_LABEL] === target.name)
        found.set(server.id, server);
    }
    const selector = target.idempotencyKey
      ? `${KEY_LABEL}=${keyLabel(target.idempotencyKey)}`
      : `${MACHINE_LABEL}=${target.name}`;
    for (const server of await servers({ labelSelector: selector }))
      found.set(server.id, server);
    return [...found.values()];
  };
  const action = async (server: HetznerServer, name: string): Promise<void> => {
    await request({
      method: "POST",
      path: `/servers/${server.id}/actions/${name}`,
    });
  };

  /** The snapshot kept of a server, or being written, if any. */
  const snapshotOf = async (
    server: HetznerServer,
  ): Promise<{ status: string } | undefined> => {
    const images = (
      await list({
        path: "/images",
        key: "images",
        query: {
          type: "snapshot",
          label_selector: `${SNAPSHOT_SERVER_LABEL}=${server.id}`,
        },
      })
    ).map((image) => record(image));
    const kept =
      images.find((image) => image.status === "available") ?? images[0];
    return kept
      ? { status: typeof kept.status === "string" ? kept.status : "creating" }
      : undefined;
  };
  /**
   * Whether the server's snapshot is written. Starting one is never
   * retried blindly, since a second image would be billed: an earlier
   * call's is looked for first.
   */
  const snapshotted = async (
    server: HetznerServer,
    name: string,
  ): Promise<boolean> => {
    const kept = await snapshotOf(server);
    if (kept) return kept.status === "available";
    await request({
      method: "POST",
      path: `/servers/${server.id}/actions/create_image`,
      body: {
        type: "snapshot",
        description: `Work machine ${name}`,
        labels: {
          [MACHINE_LABEL]: name,
          [SNAPSHOT_SERVER_LABEL]: String(server.id),
        },
      },
    });
    return false;
  };

  return {
    create: async (creation) => {
      const options: Record<string, unknown> = {
        ...defaults,
        ...creation.options,
      };
      const text = (key: string) => {
        const value = options[key];
        return typeof value === "string" && value.length > 0
          ? value
          : undefined;
      };
      const serverType = text("serverType");
      const location = text("location");
      const image = text("image");
      if (!serverType || !location || !image)
        return {
          refused:
            "A machine needs serverType, location and image, in its plan entry's options or the recipe's defaults",
        };
      const userData = config.userData(creation);
      if (Buffer.byteLength(userData) > 32 * 1024)
        return {
          refused: `The user data is ${Buffer.byteLength(userData)} bytes; Hetzner Cloud takes 32768`,
        };
      const key = keyLabel(creation.enrollment.idempotencyKey);
      const ids = (value: unknown): unknown[] =>
        Array.isArray(value) ? value : [];
      try {
        const body = record(
          await request({
            method: "POST",
            path: "/servers",
            body: {
              name: creation.name,
              server_type: serverType,
              location,
              image,
              start_after_create: true,
              labels: {
                ...config.labels,
                [MACHINE_LABEL]: creation.name,
                [KEY_LABEL]: key,
              },
              user_data: userData,
              ...(ids(options.sshKeys).length
                ? { ssh_keys: ids(options.sshKeys) }
                : {}),
              ...(ids(options.firewalls).length
                ? {
                    firewalls: ids(options.firewalls).map((firewall) => ({
                      firewall,
                    })),
                  }
                : {}),
              ...(ids(options.networks).length
                ? { networks: ids(options.networks) }
                : {}),
            },
          }),
        );
        const server = serverOf(body.server);
        if (!server) throw new Error("Hetzner Cloud answered without a server");
        return { ref: String(server.id) };
      } catch (error) {
        if (!(error instanceof HetznerCloudError)) throw error;
        if (error.code === "uniqueness_error") {
          // Work repeating this create (a lost answer, another replica):
          // the server with this name and this key is the machine.
          const [existing] = await servers({ name: creation.name });
          if (existing?.labels[KEY_LABEL] === key)
            return { ref: String(existing.id) };
          // The name's previous server is still going: not yet.
          if (existing?.status === "deleting") return { pending: true };
          return {
            refused: `A server named ${creation.name} already exists and was not made for this enrollment; rename or delete it`,
          };
        }
        // Nothing was made, and asking again would fail the same way.
        if (error.definite) return { refused: error.message };
        throw error;
      }
    },

    destroy: async (target) => {
      const machines = await serversOf(target);
      for (const server of machines) {
        if (server.status === "deleting") continue;
        if (config.snapshot && !(await snapshotted(server, target.name)))
          continue;
        try {
          await request({ method: "DELETE", path: `/servers/${server.id}` });
        } catch (error) {
          if (
            !(error instanceof HetznerCloudError && error.code === "not_found")
          )
            throw error;
        }
      }
      // Done once a later call finds none left; a name is reused only then.
      return { done: machines.length === 0 };
    },

    stop: async (target) => {
      const machines = (await serversOf(target)).filter(
        (server) => server.status !== "deleting",
      );
      for (const server of machines)
        if (server.status === "running" || server.status === "starting")
          await action(server, "shutdown");
      return { done: machines.every((server) => server.status === "off") };
    },

    start: async (target) => {
      const machines = (await serversOf(target)).filter(
        (server) => server.status !== "deleting",
      );
      if (machines.length === 0) return { gone: true };
      for (const server of machines)
        if (server.status === "off") await action(server, "poweron");
      return { done: machines.every((server) => server.status === "running") };
    },

    describe: async (target) => {
      const machines = await serversOf(target);
      const states = machines.map((server) => server.status);
      if (states.some((state) => state === "off" || state === "stopping"))
        return { state: "stopped" };
      if (states.some((state) => state !== "deleting"))
        return { state: "running" };
      // Hetzner lists a server from the moment it is made: none is none.
      return { state: "gone" };
    },
  };
}
