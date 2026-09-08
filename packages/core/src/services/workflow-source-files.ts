import type { FileReadOptions } from "@catamorphic/git";

/** Select parser inputs before opening files in general-purpose projects. */
export const WORKFLOW_READ_OPTIONS: FileReadOptions = {
  excludeNestedRepositories: true,
  filter: (file) =>
    /(^|\/)(package|tsconfig)\.json$/.test(file) ||
    (!file.startsWith("apps/") && /\.tsx?$/.test(file)) ||
    (file.startsWith("apps/") && file.endsWith(".d.ts")),
};
