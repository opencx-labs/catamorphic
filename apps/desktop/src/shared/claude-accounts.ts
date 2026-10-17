/** One row of Settings, Agents, Claude accounts (ADR 0243). */
export interface ClaudeAccountRow {
  id: string;
  /** The account's email, or what stands for it while unknown. */
  label: string;
  /** The machine's own Claude Code login, which Work only reads. */
  machine: boolean;
  plan?: string;
  inUse: boolean;
  /** Percent used, 0-100, when Claude Code said. */
  fiveHour?: number;
  weekly?: number;
  /** Why the account is not taking turns, or what it waits for. */
  note?: string;
}

export interface ClaudeAccountSwitch {
  from: string;
  to: string;
  reason: string;
  at: number;
}

export interface ClaudeAccountsView {
  accounts: ClaudeAccountRow[];
  signingIn: boolean;
  /** The switch point, as a percent, for the words around the roster. */
  switchAt: number;
  lastSwitch?: ClaudeAccountSwitch;
}

export type ClaudeAccountSignIn =
  | { ok: true; email: string }
  | { ok: false; error?: string };
