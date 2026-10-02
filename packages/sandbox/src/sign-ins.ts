import path from "node:path";
import { SIGN_IN_HARNESSES, type SignInHarness } from "./types.js";

/**
 * Where a machine keeps one member's sign-in home for a harness (ADR
 * 0197): `<root>/<harness>/<member>`, on the machine's own disk. The
 * harness's own login writes there (`CLAUDE_CONFIG_DIR`, `CODEX_HOME`);
 * sandboxes of that member's chats see it at `signInHomePath`. Work never
 * reads what is inside.
 */
export function machineSignInHome(input: {
  root: string;
  harness: SignInHarness;
  member: string;
}): string {
  return path.join(
    input.root,
    input.harness,
    signInMemberDirectory(input.member),
  );
}

/**
 * The directory name of a member's sign-in home: their id, URI-encoded so
 * any id is one path segment. Refuses ids that are not one.
 */
export function signInMemberDirectory(member: string): string {
  const encoded = encodeURIComponent(member);
  if (!member || encoded.length > 255 || encoded === "." || encoded === "..")
    throw new Error(`'${member}' is not a member id a sign-in can belong to`);
  return encoded;
}

/** The member a sign-in home's directory name belongs to, if it is one. */
export function signInMemberOf(directory: string): string | undefined {
  try {
    const member = decodeURIComponent(directory);
    return signInMemberDirectory(member) === directory ? member : undefined;
  } catch {
    return undefined;
  }
}

/**
 * For providers whose sandboxes run on someone else's machines (cloud
 * sandboxes): a sign-in stays on the machine it was made on (ADR 0197), so
 * they refuse to be handed one.
 */
export function refuseSignIns(input: {
  signIns?: ReadonlyArray<{ harness: SignInHarness; member: string }>;
  provider: string;
}): void {
  if (input.signIns?.length)
    throw new Error(
      `${input.provider} sandboxes cannot run on a member's own sign-in: a sign-in stays on the machine it was made on. Use a model connection, or a worker the member signed in on`,
    );
}

/** The harness and member a `sign-in:<harness>:<member>` capability names. */
export function parseSignInCapability(
  capability: string,
): { harness: SignInHarness; member: string } | undefined {
  const match = /^sign-in:([a-z-]+):(.+)$/.exec(capability);
  const harness = SIGN_IN_HARNESSES.find((entry) => entry === match?.[1]);
  const member = match?.[2];
  return harness && member ? { harness, member } : undefined;
}

/**
 * Set by a provider whose sandboxes see virtual paths it maps onto real
 * directories (local-process): JSON `{ virtual, real }`. A process in such a
 * sandbox, like the agent runner, maps the virtual paths it is handed.
 */
export const SANDBOX_PATHS_ENV = "CATAMORPHIC_SANDBOX_PATHS";

/** A sandbox's virtual root and the real directory it stands for. */
export interface SandboxPathMap {
  virtual: string;
  real: string;
}

/** The mapping in {@link SANDBOX_PATHS_ENV}, when it is a valid one. */
export function parseSandboxPaths(
  raw: string | undefined,
): SandboxPathMap | undefined {
  if (!raw) return undefined;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (
      typeof parsed === "object" &&
      parsed !== null &&
      "virtual" in parsed &&
      "real" in parsed &&
      typeof parsed.virtual === "string" &&
      typeof parsed.real === "string" &&
      parsed.virtual.startsWith("/") &&
      path.isAbsolute(parsed.real)
    )
      return { virtual: parsed.virtual, real: parsed.real };
  } catch {
    /* Not a mapping. */
  }
  return undefined;
}

/**
 * A JSON value with every string that is `from` or a path under it moved
 * under `to`. Other strings, including ones that only mention a path, are
 * left as they are.
 */
export function remapPaths<T>(value: T, from: string, to: string): T {
  if (value === undefined) return value;
  const root = from.replace(/\/+$/, "");
  const target = to.replace(/\/+$/, "");
  return JSON.parse(JSON.stringify(value), (_key, entry: unknown) =>
    typeof entry === "string" &&
    (entry === root || entry.startsWith(`${root}/`))
      ? `${target}${entry.slice(root.length)}`
      : entry,
  );
}
