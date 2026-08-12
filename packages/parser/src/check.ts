import {
  appApiTypesPath,
  appWorkspaceNames,
  renderAppApiTypesModule,
} from "./app-codegen.js";
import { validateAgainstSchema } from "./json-schema-validate.js";
import { parseProject } from "./parser.js";

/**
 * Host-independent project validation, the engine behind each project's
 * seeded `scripts/check.ts`. Everything here needs only the project's own
 * files — no Catamorphic host, database, or sandbox:
 *
 * - parse errors, including non-constant trigger configs and app-api
 *   contract problems;
 * - trigger bindings validated against the host's kind catalog, when the
 *   caller fetched one (`GET /trigger-kinds` on any Catamorphic host);
 * - generated-file drift: the committed `catamorphic-app-api.d.ts` files
 *   are re-derived from source and compared, so a stale projection fails a
 *   local run or CI instead of silently type-checking app code against the
 *   wrong contract.
 *
 * `generated` carries the fresh projections so callers can write them.
 */
export interface CheckFinding {
  level: "error" | "warning";
  message: string;
  file?: string;
}

/** The subset of a host's trigger-kind catalog that checking needs. */
export interface CheckTriggerKind {
  name: string;
  configJsonSchema?: unknown;
}

export interface CheckResult {
  findings: CheckFinding[];
  /** Fresh generated projections, keyed by project-relative path. */
  generated: Record<string, string>;
  /** True when no error-level findings exist. */
  ok: boolean;
}

export function checkProject(
  files: Record<string, string>,
  options?: { triggerKinds?: readonly CheckTriggerKind[] },
): CheckResult {
  const findings: CheckFinding[] = [];
  const generated: Record<string, string> = {};

  const parsed = parseProject(files);
  for (const error of parsed.errors) {
    findings.push({ level: "error", message: error.message, file: error.file });
  }

  if (options?.triggerKinds) {
    const kinds = new Map(
      options.triggerKinds.map((kind) => [kind.name, kind]),
    );
    for (const workflow of parsed.workflows) {
      for (const binding of workflow.graph.triggers) {
        const kind = kinds.get(binding.kind);
        if (!kind) {
          findings.push({
            level: "error",
            file: workflow.filePath,
            message: `Workflow '${workflow.functionName}' binds unknown trigger kind '${binding.kind}' (host kinds: ${[...kinds.keys()].join(", ") || "none"})`,
          });
          continue;
        }
        const errors = validateAgainstSchema(
          binding.config,
          kind.configJsonSchema ?? {},
          "config",
        );
        for (const error of errors) {
          findings.push({
            level: "error",
            file: workflow.filePath,
            message: `Workflow '${workflow.functionName}' trigger '${binding.kind}': ${error}`,
          });
        }
      }
    }
  }

  if (parsed.appApi) {
    const content = renderAppApiTypesModule(parsed.appApi.entries);
    for (const appName of appWorkspaceNames(files)) {
      const path = appApiTypesPath(appName);
      generated[path] = content;
      const committed = files[path];
      if (committed === undefined) {
        findings.push({
          level: "warning",
          file: path,
          message: `Missing generated app-api types for '${appName}' — run with --write (or your host's syncTypes) to create it`,
        });
      } else if (committed !== content) {
        findings.push({
          level: "error",
          file: path,
          message: `Generated app-api types for '${appName}' are stale — app code is type-checking against the wrong contract; regenerate with --write`,
        });
      }
    }
  }

  return {
    findings,
    generated,
    ok: !findings.some((finding) => finding.level === "error"),
  };
}
