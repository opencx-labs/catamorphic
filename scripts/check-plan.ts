export interface CheckCommand {
  label: string;
  command: string;
  args: readonly string[];
}

export function checkCommands(): readonly CheckCommand[] {
  return [
    { label: "lint", command: "bun", args: ["run", "lint"] },
    { label: "typecheck", command: "bun", args: ["run", "typecheck"] },
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
      args: ["diff", "--exit-code", "--", "packages/db/src/generated/db.ts"],
    },
    {
      label: "deterministic workspace tests",
      command: "bun",
      args: ["run", "test:workspace"],
    },
    {
      label: "PWA E2E",
      command: "bun",
      args: ["run", "--cwd", "apps/pwa", "test:e2e"],
    },
    {
      label: "desktop visible E2E",
      command: "bun",
      args: ["run", "--cwd", "apps/desktop", "test:e2e:visible"],
    },
    {
      label: "desktop hidden E2E",
      command: "bun",
      args: ["run", "--cwd", "apps/desktop", "test:e2e"],
    },
  ];
}
