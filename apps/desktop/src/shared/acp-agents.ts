/**
 * Agent Client Protocol agents (ADR 0241): a person's or a project's agent
 * that Work runs as its own command, on its own model and sign-in. Hermes
 * is the one Settings offers by name; any other ACP agent runs the same way.
 *
 * Dependency-free, so the main process and the renderer share it.
 */

/** Hermes Agent, as Settings sets it up: Hermes' own commands, not Work's. */
export const HERMES = {
  name: "Hermes",
  command: ["hermes", "acp"],
  /** Hermes' own installer (hermes-agent.nousresearch.com). */
  install: "curl -fsSL https://hermes-agent.nousresearch.com/install.sh | bash",
  /** Where Hermes keeps its provider and sign-in. */
  setup: "hermes setup",
  /** Where Hermes keeps its model. */
  model: "hermes model",
} as const;

/**
 * Each ACP agent has its own harness identity, so switching agents never
 * resumes a different ACP agent's native thread.
 */
export function acpHarnessId(agentId: string): string {
  return `acp:${agentId}`;
}

/** Whether an ACP agent's command runs Hermes. */
export function runsHermes(command: readonly string[] | undefined): boolean {
  return /(^|[\\/])hermes$/.test(command?.[0] ?? "");
}

/**
 * Characters that change how a command reads without showing: controls,
 * direction and joiner marks, separators other than the plain space, and
 * the blank letters (Hangul fillers, the blank braille cell).
 */
const UNSEEN =
  /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}\p{Zs}\u115F\u1160\u3164\uFFA0\u2800]/gu;

/**
 * A command as the person reviews it before it runs: each argument whole,
 * quoted when it holds anything but plain characters, and every unseen
 * character spelled out (a backslash doubled first, so a spelled-out one
 * never passes for the real thing), so what shows is what runs.
 */
export function displayCommand(command: readonly string[]): string {
  return command
    .map((part) => {
      const shown = part
        .replaceAll("\\", "\\\\")
        .replace(UNSEEN, (char) =>
          char === " "
            ? char
            : `\\u{${char.codePointAt(0)?.toString(16) ?? ""}}`,
        );
      return /^[\w@%+=:,./~-]+$/.test(shown)
        ? shown
        : `'${shown.replaceAll("'", `'\\''`)}'`;
    })
    .join(" ");
}
