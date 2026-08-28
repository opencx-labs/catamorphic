export interface CliErrorOutput {
  write(chunk: string): unknown;
}

function cliErrorLines(error: unknown, depth: number): string[] {
  const indentation = "  ".repeat(depth);
  if (error instanceof AggregateError) {
    const header = `${indentation}${error.message || "AggregateError"}`;
    const details = error.errors.flatMap((nested: unknown) => {
      const nestedLines = cliErrorLines(nested, depth + 1);
      const nestedIndentation = "  ".repeat(depth + 1);
      return [
        `${nestedIndentation}- ${nestedLines[0]?.slice(nestedIndentation.length) ?? "Unknown error"}`,
        ...nestedLines.slice(1),
      ];
    });
    return [header, ...details];
  }
  return [
    `${indentation}${error instanceof Error ? error.message : String(error)}`,
  ];
}

export function formatCliError(error: unknown): string {
  return cliErrorLines(error, 0).join("\n");
}

export function writeCliError(
  error: unknown,
  output: CliErrorOutput = process.stderr,
): void {
  output.write(`${formatCliError(error)}\n`);
}
