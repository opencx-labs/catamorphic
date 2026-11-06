/**
 * The environment file a sandbox's shells and runner load (ADR 0206): one
 * `export NAME='value'` line per variable, values single-quoted so a shell
 * takes them literally, newlines included. Work writes it; shells read it
 * as `BASH_ENV` or with `.`, and the agent runner reads it with
 * {@link parseEnvFile} for every attempt.
 */

/** Names an environment file may set. */
const NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** `value` in single quotes, each quote in it as `'\''`. */
export function shellSingleQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

/** The file's text for `variables`, in the order given. */
export function formatEnvFile(
  variables: Readonly<Record<string, string>>,
): string {
  return Object.entries(variables)
    .map(([name, value]) => {
      if (!NAME.test(name))
        throw new Error(`'${name}' is not an environment variable name`);
      return `export ${name}=${shellSingleQuote(value)}\n`;
    })
    .join("");
}

/**
 * The variables in a file {@link formatEnvFile} wrote. Lines it did not
 * write (comments, blank lines, anything else) are skipped, never guessed
 * at.
 */
export function parseEnvFile(text: string): Record<string, string> {
  const variables: Record<string, string> = {};
  let at = 0;
  while (at < text.length) {
    const end = text.indexOf("\n", at);
    const lineEnd = end === -1 ? text.length : end;
    const match = /^export ([A-Za-z_][A-Za-z0-9_]*)=/.exec(
      text.slice(at, lineEnd),
    );
    if (!match?.[1]) {
      at = lineEnd + 1;
      continue;
    }
    const name = match[1];
    let cursor = at + match[0].length;
    let value = "";
    let complete = false;
    // Quoted runs and `\'` escapes, until the assignment's end of line.
    for (;;) {
      const char = text[cursor];
      if (char === "'") {
        const close = text.indexOf("'", cursor + 1);
        if (close === -1) break;
        value += text.slice(cursor + 1, close);
        cursor = close + 1;
      } else if (char === "\\" && cursor + 1 < text.length) {
        value += text[cursor + 1];
        cursor += 2;
      } else {
        complete = char === undefined || char === "\n";
        break;
      }
    }
    if (complete) variables[name] = value;
    const next = text.indexOf("\n", cursor);
    at = next === -1 ? text.length : next + 1;
  }
  return variables;
}
