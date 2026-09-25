/**
 * An upstream identity directory (ADR 0161). It answers whether an account
 * signed in through one sign-in provider is still active, and which of the
 * named groups it belongs to. Provider-neutral: Google Workspace is one
 * implementation; a host may inject others.
 */
export interface DirectoryProvider {
  /** The sign-in provider id whose accounts this directory governs. */
  readonly providerId: string;
  /** Groups every account must belong to (any of them). Empty means none. */
  readonly requiredGroups: readonly string[];
  check(args: {
    /** The provider's stable account id (the OIDC `sub`). */
    accountId: string;
    email: string;
    /** Groups to test; the answer lists the subset the account belongs to. */
    groups: readonly string[];
  }): Promise<DirectoryAccountStatus>;
}

export type DirectoryAccountStatus =
  | { active: true; groups: string[] }
  | { active: false; reason: DirectoryInactiveReason };

export type DirectoryInactiveReason =
  | "suspended"
  | "archived"
  | "deleted"
  | "not_in_required_group";

/** A directory call failed; distinct from a definitive inactive answer. */
export class DirectoryUnavailableError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "DirectoryUnavailableError";
  }
}

/** Apply the required-group rule shared by every directory. */
export function requireGroups(
  directory: Pick<DirectoryProvider, "requiredGroups">,
  status: DirectoryAccountStatus,
): DirectoryAccountStatus {
  if (!status.active || directory.requiredGroups.length === 0) return status;
  const member = directory.requiredGroups.some((group) =>
    status.groups.includes(normalizeGroup(group)),
  );
  return member ? status : { active: false, reason: "not_in_required_group" };
}

export function normalizeGroup(group: string): string {
  return group.trim().toLowerCase();
}
