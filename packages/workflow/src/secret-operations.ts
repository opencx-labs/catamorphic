import type { WorkflowTransition } from "./workflow.js";

/**
 * One project secret as `list` reports it (ADR 0205). Never a value: only
 * whether a shared value exists and which members hold their own.
 */
export interface SecretStatusEntry {
  name: string;
  label?: string;
  description?: string;
  /** Where the secret is declared. */
  source: "project" | "plugin";
  /** A shared value is set. */
  shared: boolean;
  /** Members who hold their own value, by id. */
  members: string[];
  /** Environments whose sandboxes receive it. */
  environments: string[];
}

/** A member by their id, or by the email they sign in with. */
type Member = string;

type Call<Input, Output = unknown> = (
  input: Input,
) => WorkflowTransition<Output>;

/**
 * The project's secrets (ADR 0209), caller-bound like every host call. A
 * run reaches them only when its workflow declared `secrets:read` (for
 * `list`) or `secrets:write`, and values stay write-only.
 */
export interface SecretHostOperations {
  list: Call<Record<string, never>, { items: SecretStatusEntry[] }>;
  /**
   * Set the shared value, or `member`'s own value (an email or a member
   * id). Declared names only.
   */
  set: Call<
    { name: string; value: string; member?: Member },
    { name: string; member: string | null; updatedAt: string }
  >;
  /** Remove the shared value, or `member`'s own. */
  delete: Call<
    { name: string; member?: Member },
    { name: string; member: string | null; deleted: boolean }
  >;
}
