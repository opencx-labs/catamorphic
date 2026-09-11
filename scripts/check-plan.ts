export interface CheckCommand {
  label: string;
  command: string;
  args: readonly string[];
}

export function checkCommands(input: {
  generatedTypesBaseline: string;
  lane?: "validation" | "workspace";
  shard?: string;
  reuseTests?: boolean;
}): readonly CheckCommand[] {
  const commands = [
    { label: "lint", command: "bun", args: ["run", "lint"] },
    {
      label: "root orchestration typecheck",
      command: "bun",
      args: ["run", "typecheck:scripts"],
    },
    {
      label: "workspace typecheck",
      command: "bun",
      args: ["run", "typecheck"],
    },
    { label: "build", command: "bun", args: ["run", "build"] },
    {
      label: "database migration",
      command: "bun",
      args: ["run", "db:migrate"],
    },
    {
      label: "database codegen",
      command: "bun",
      args: ["run", "db:codegen"],
    },
    {
      label: "generated-type diff check",
      command: "git",
      args: [
        "diff",
        "--no-index",
        "--exit-code",
        "--",
        input.generatedTypesBaseline,
        "packages/db/src/generated/db.ts",
      ],
    },
    {
      label: "root orchestration tests",
      command: "bun",
      args: ["run", "test:scripts"],
    },
    {
      label: "deterministic workspace tests",
      command: "bun",
      // Shard identity is a test-only hashed environment input. Passing it
      // through Turbo CLI arguments would also invalidate build hashes.
      args: input.shard
        ? [
            "scripts/tool-runtime.ts",
            "turbo",
            "run",
            "test",
            "--no-daemon",
            "--concurrency=2",
            ...(input.reuseTests ? [] : ["--force"]),
            "--output-logs=new-only",
            "--summarize",
          ]
        : ["run", "test:workspace"],
    },
    {
      label: "PWA E2E",
      command: "bun",
      args: ["run", "--cwd", "apps/pwa", "test:e2e"],
    },
    {
      label: "desktop E2E",
      command: "bun",
      args: ["run", "--cwd", "apps/desktop", "test:e2e"],
    },
  ];
  if (input.lane === "validation") return commands.slice(0, 8);
  if (input.lane === "workspace")
    return commands.filter(
      (phase) => phase.label === "deterministic workspace tests",
    );
  return commands;
}

export function checkOptions(args: readonly string[]): {
  lane?: "validation" | "workspace";
  shard?: string;
} {
  const lane = args.find((arg) => arg.startsWith("--lane="))?.slice(7);
  const shard = args.find((arg) => arg.startsWith("--shard="))?.slice(8);
  if (
    args.some(
      (arg) => !arg.startsWith("--lane=") && !arg.startsWith("--shard="),
    ) ||
    (lane !== undefined && lane !== "validation" && lane !== "workspace")
  ) {
    throw new Error(
      "Usage: bun run check [--lane=validation|workspace] [--shard=index/total]",
    );
  }
  if (shard !== undefined) {
    const [index, total] = shard.split("/").map(Number);
    if (
      lane !== "workspace" ||
      !/^[1-9]\d*\/[1-9]\d*$/.test(shard) ||
      !index ||
      !total ||
      index > total
    ) {
      throw new Error("A valid --shard=index/total requires --lane=workspace");
    }
  }
  return { lane, shard };
}
