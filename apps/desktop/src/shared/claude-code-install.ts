/** A Claude Code CLI the person installed themselves (ADR 0196). */
export interface InstalledClaudeCode {
  /** The resolved executable, after symlinks: what sessions run. */
  executablePath: string;
  /** Where it was found (`~/.local/bin/claude`): what updates run. */
  commandPath: string;
  version: string;
}

/** Which Claude Code Work runs, and why (ADR 0196). */
export interface ClaudeCodeInstallStatus {
  /** `installed`: the person's own Claude Code; `work`: Work's pinned copy. */
  using: "installed" | "work";
  /** The newest native Claude Code found on this machine, if any. */
  installed: InstalledClaudeCode | null;
  /** The oldest installed version Work runs; also Work's own copy's version. */
  minVersion: string;
}
