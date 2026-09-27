import { createHash } from "node:crypto";

/**
 * What a sandbox provider gives each sandbox beyond running commands (ADR
 * 0176). Machines advertise these in their Environment binding descriptors
 * and Environments require them, so placement matches both.
 */
export const SANDBOX_CAPABILITIES = {
  /** Boots the OCI image an Environment names. */
  images: "images",
  /** Builds an image from a project Dockerfile on this machine. */
  imageBuild: "images.build",
  /** Gives each sandbox its own container runtime (`docker`, `docker compose`). */
  containers: "containers",
  /** Enforces an Environment's egress policy. */
  egressPolicy: "network.policy",
} as const;

export type SandboxCapability =
  (typeof SANDBOX_CAPABILITIES)[keyof typeof SANDBOX_CAPABILITIES];

/** The image a sandbox boots: a registry reference, or a reviewed Dockerfile. */
export type SandboxImage =
  | { kind: "oci"; reference: string }
  | {
      kind: "dockerfile";
      /** Project path, for messages and audit. */
      path: string;
      content: string;
      /** sha256 of `content`; names the built image in each machine's cache. */
      digest: string;
    };

/** Outbound network reach, resolved for one sandbox. */
export type SandboxEgress =
  | { mode: "open" }
  | {
      mode: "allowlist";
      /**
       * Domains, `*.suffix` patterns, or IP literals, each optionally with a
       * port (`host:443`, `[fd00::1]:8080`) that narrows it to that TCP
       * port. DNS is always allowed.
       */
      allow: readonly string[];
    };

/** An Environment's egress policy as a project declares it. */
export type EnvironmentNetworkPolicy =
  | { egress: "open" }
  | { egress: "gateway" }
  | { egress: "allowlist"; allow: readonly string[] };

const DOMAIN =
  /^(\*\.)?(?=.{1,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)(\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*$/;
const IPV4 = /^(\d{1,3})(\.\d{1,3}){3}$/;

/** A domain, a `*.suffix` pattern, or an IPv4 literal. */
export function isEgressPattern(value: string): boolean {
  if (IPV4.test(value))
    return value.split(".").every((part) => Number(part) <= 255);
  return DOMAIN.test(value);
}

/**
 * Resolve a declared policy for a sandbox. `gateway` reaches only the
 * control plane; `allowlist` reaches the listed hosts and the control plane,
 * which is always reachable so gateway grants keep working (ADR 0175).
 */
export function resolveEgress(args: {
  policy: EnvironmentNetworkPolicy | undefined;
  gatewayHosts: readonly string[];
}): SandboxEgress {
  const policy = args.policy;
  if (!policy || policy.egress === "open") return { mode: "open" };
  const allow = [
    ...args.gatewayHosts,
    ...(policy.egress === "allowlist" ? policy.allow : []),
  ].map((host) => host.toLowerCase());
  return { mode: "allowlist", allow: [...new Set(allow)] };
}

/**
 * The host and port of a URL (`work.acme.com:443`, `[::1]:8787`), for
 * `gatewayHosts`: sandboxes reach the gateway there and nowhere else on
 * that host.
 */
export function gatewayHostOf(url: string): string {
  const parsed = new URL(url);
  const port = parsed.port || (parsed.protocol === "https:" ? "443" : "80");
  return `${parsed.hostname}:${port}`.toLowerCase();
}

export function dockerfileDigest(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("hex");
}

/** The reference a built Dockerfile image carries in a machine's cache. */
export function dockerfileImageReference(digest: string): string {
  return `work.local/images:${digest.slice(0, 40)}`;
}

/** What an agent may change outside its own sandbox (ADR 0176). */
export const AGENT_MODES = ["read-only", "edit", "full-access"] as const;
export type AgentMode = (typeof AGENT_MODES)[number];

/** Whether an agent in `mode` may take an action that needs `required`. */
export function modeAllows(mode: AgentMode, required: AgentMode): boolean {
  return AGENT_MODES.indexOf(mode) >= AGENT_MODES.indexOf(required);
}

/** The readable refusal an agent sees at a boundary its mode does not cross. */
export function modeRefusal(args: { mode: AgentMode; action: string }): string {
  return args.mode === "read-only"
    ? `This agent runs in read-only mode: it may inspect and run anything inside its own sandbox, but not ${args.action}. Report what you found instead.`
    : `This agent runs in edit mode: it may propose changes, but not ${args.action}. Propose the change for someone who may publish it.`;
}
