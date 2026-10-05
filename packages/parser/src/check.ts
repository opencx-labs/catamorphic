import {
  appApiTypesPath,
  appWorkspaceNames,
  renderAppApiTypesModule,
} from "./app-codegen.js";
import { holeSchemaErrors } from "./holes.js";
import { validateAgainstSchema } from "./json-schema-validate.js";
import { parseProject } from "./parser.js";
import { resolveTriggerBinding } from "./project-triggers.js";
import { triggerPermissionError } from "./trigger-permissions.js";
import {
  webhookSettingsConflicts,
  webhookSettingsIssues,
} from "./webhook-settings.js";

/**
 * Host-independent project validation, the engine behind each project's
 * seeded `scripts/check.ts`. Everything here needs only the project's own
 * files — no Catamorphic host, database, or sandbox:
 *
 * - parse errors, including non-constant trigger configs and app-api
 *   contract problems;
 * - project trigger kinds (ADR 0171) resolved through their chains, and
 *   cycles reported;
 * - trigger bindings validated against the host's kind catalog, when the
 *   caller fetched one (`GET /trigger-kinds` on any Catamorphic host),
 *   including the permissions a kind requires its workflows to declare;
 * - webhook settings checked by the rules the host applies at deploy:
 *   placeholders, replay protection, header or query, handshake filters,
 *   and one set of settings per webhook name;
 * - generated-file drift: the committed `work-app-api.d.ts` files
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
  /** Enables hole validation (ADR 0042) when present. */
  payloadJsonSchema?: unknown;
  /** Permissions a binding workflow must declare (ADR 0209). */
  requiredPermissions?: readonly string[];
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

  const hostKinds = options?.triggerKinds
    ? new Map(options.triggerKinds.map((kind) => [kind.name, kind]))
    : undefined;
  const hostKindList = () =>
    [...(hostKinds?.keys() ?? [])].join(", ") || "none";
  // Project trigger kinds (ADR 0171) resolve to the host kind they build on;
  // with the host's catalog, that root must exist and accept the config.
  for (const kind of parsed.triggerKinds) {
    if (!hostKinds) continue;
    if (hostKinds.has(kind.name)) {
      findings.push({
        level: "error",
        file: kind.filePath,
        message: `Trigger kind '${kind.name}' is already a host kind; give the project's kind another name`,
      });
      continue;
    }
    const resolved = resolveTriggerBinding({
      binding: { kind: kind.name, config: {} },
      projectKinds: parsed.triggerKinds,
    });
    if (!resolved.ok) continue; // reported by the parse
    const root = hostKinds.get(resolved.binding.kind);
    if (!root) {
      findings.push({
        level: "error",
        file: kind.filePath,
        message: `Trigger kind '${kind.name}' builds on unknown trigger kind '${resolved.binding.kind}' (host kinds: ${hostKindList()})`,
      });
      continue;
    }
    for (const error of validateAgainstSchema(
      resolved.binding.config,
      root.configJsonSchema ?? {},
      "config",
    )) {
      findings.push({
        level: "error",
        file: kind.filePath,
        message: `Trigger kind '${kind.name}' from '${root.name}': ${error}`,
      });
    }
  }

  // The host's `webhook` kind has rules its JSON Schema cannot state; the
  // host enforces the same ones at deploy (ADR 0171).
  const checksWebhooks = !hostKinds || hostKinds.has("webhook");
  const webhookBindings: { workflowName: string; config: unknown }[] = [];
  for (const workflow of parsed.workflows) {
    for (const binding of workflow.graph.triggers) {
      const resolved = resolveTriggerBinding({
        binding,
        projectKinds: parsed.triggerKinds,
      });
      if (!resolved.ok) {
        findings.push({
          level: "error",
          file: workflow.filePath,
          message: `Workflow '${workflow.functionName}' trigger '${binding.kind}': ${resolved.error}`,
        });
        continue;
      }
      if (checksWebhooks && resolved.binding.kind === "webhook") {
        webhookBindings.push({
          workflowName: workflow.functionName,
          config: resolved.binding.config,
        });
        for (const issue of webhookSettingsIssues(resolved.binding.config))
          findings.push({
            level: "error",
            file: workflow.filePath,
            message: `Workflow '${workflow.functionName}' trigger '${binding.kind}': config.${issue.path.join(".")}: ${issue.message}`,
          });
      }
      if (!hostKinds) continue;
      const kind = hostKinds.get(resolved.binding.kind);
      if (!kind) {
        findings.push({
          level: "error",
          file: workflow.filePath,
          message: `Workflow '${workflow.functionName}' binds unknown trigger kind '${binding.kind}' (host kinds: ${hostKindList()}; project kinds: ${parsed.triggerKinds.map((projectKind) => projectKind.name).join(", ") || "none"})`,
        });
        continue;
      }
      // A project kind's config is its own, checked with the kind above.
      const errors = resolved.binding.projectKind
        ? []
        : validateAgainstSchema(
            resolved.binding.config,
            kind.configJsonSchema ?? {},
            "config",
          );
      // Holes in the kind's payload template must freeze to concrete
      // schemas derived from this workflow's input — the same fail-closed
      // rule the host applies at scan time.
      for (const holeError of holeSchemaErrors({
        payloadSchema: kind.payloadJsonSchema ?? {},
        inputSchema: workflow.graph.inputSchema ?? {},
      })) {
        errors.push(holeError);
      }
      const permissionError = triggerPermissionError({
        kind: kind.name,
        required: kind.requiredPermissions,
        declared: workflow.graph.permissions,
      });
      if (permissionError) errors.push(permissionError);
      for (const error of errors) {
        findings.push({
          level: "error",
          file: workflow.filePath,
          message: `Workflow '${workflow.functionName}' trigger '${binding.kind}': ${error}`,
        });
      }
    }
  }

  for (const message of webhookSettingsConflicts(webhookBindings))
    findings.push({ level: "error", message });

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
