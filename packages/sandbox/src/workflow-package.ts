import appPayload from "@catamorphic/app/package-payload";
import workflowPayload from "@catamorphic/workflow/package-payload";
import type { PluginPayload } from "./plugin-upload.js";

export const WORKFLOW_PACKAGE_NAME = "@catamorphic/workflow";
export const APP_PACKAGE_NAME = "@catamorphic/app";

export interface WorkflowPackagePayload extends PluginPayload {
  version: string;
}

export async function resolveWorkflowPackageFallback(args: {
  packageJson?: string;
  /** A committed lockfile is authoritative; never replace its resolved package. */
  hasLockfile?: boolean;
}): Promise<WorkflowPackagePayload | undefined> {
  if (args.hasLockfile) return undefined;
  const declaredVersion = readDeclaredVersion(args.packageJson);
  if (!declaredVersion) return undefined;

  const payload = await loadWorkflowPackagePayload();
  return declaredVersion === payload.version ? payload : undefined;
}

export function removeWorkflowPackageDependency(args: {
  packageJson: string;
}): string {
  return removePackageDependencies({
    packageJson: args.packageJson,
    packageNames: [WORKFLOW_PACKAGE_NAME],
  });
}

/**
 * Strips host-supplied packages before `bun install`. Their exact payloads
 * are uploaded into node_modules as part of the sandbox build.
 */
export function removePackageDependencies(args: {
  packageJson: string;
  packageNames: readonly string[];
}): string {
  const parsed = parseJsonObject(args.packageJson);
  const remove = new Set(args.packageNames);
  const dependencySections = new Set([
    "dependencies",
    "optionalDependencies",
    "devDependencies",
  ]);
  const entries = Object.entries(parsed).map(([key, value]) => {
    if (!dependencySections.has(key) || !isRecord(value)) {
      return recordEntry({ key, value });
    }
    return recordEntry({
      key,
      value: Object.fromEntries(
        Object.entries(value).filter(
          ([packageName]) => !remove.has(packageName),
        ),
      ),
    });
  });
  return JSON.stringify(Object.fromEntries(entries), null, 2);
}

/**
 * Built JavaScript carries the exact app runtime and declarations. Uploading
 * this payload does not depend on declaration files surviving host packaging.
 */
export async function loadAppPackagePayload(): Promise<PluginPayload> {
  return appPayload;
}

/** Built JavaScript carries the exact SDK payload, including its declarations. */
export async function loadWorkflowPackagePayload(): Promise<WorkflowPackagePayload> {
  return workflowPayload;
}

function readDeclaredVersion(packageJson?: string): string | undefined {
  if (!packageJson) return undefined;
  const parsed = parseJsonObject(packageJson);
  return (
    readDependencyVersion(parsed.dependencies) ??
    readDependencyVersion(parsed.optionalDependencies) ??
    readDependencyVersion(parsed.devDependencies)
  );
}

function readDependencyVersion(value: unknown): string | undefined {
  if (!isRecord(value)) return undefined;
  const version = value[WORKFLOW_PACKAGE_NAME];
  return typeof version === "string" ? version : undefined;
}

function parseJsonObject(value: string): Record<string, unknown> {
  const parsed: unknown = JSON.parse(value);
  if (!isRecord(parsed)) {
    throw new Error("Expected package.json to contain an object");
  }
  return parsed;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function recordEntry(args: {
  key: string;
  value: unknown;
}): readonly [string, unknown] {
  return [args.key, args.value];
}
