import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import type { PluginPayload } from "./plugin-upload.js";

export const WORKFLOW_PACKAGE_NAME = "@catamorphic/workflow";
export const APP_PACKAGE_NAME = "@catamorphic/app";

export interface WorkflowPackagePayload extends PluginPayload {
  version: string;
}

export async function resolveWorkflowPackageFallback(args: {
  packageJson?: string;
}): Promise<WorkflowPackagePayload | undefined> {
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
 * Strips locally-provided packages from a package.json so `bun install` does
 * not try (and fail) to resolve them from the registry; their payloads are
 * uploaded into node_modules instead.
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
 * The @catamorphic/app runtime for in-sandbox app builds, read from the local
 * install the same way the workflow fallback is. Uploaded into node_modules
 * because the package is not published to a registry.
 */
export async function loadAppPackagePayload(): Promise<PluginPayload> {
  const require = createRequire(import.meta.url);
  const packageJsonPath = require.resolve(`${APP_PACKAGE_NAME}/package.json`);
  const packageRoot = path.dirname(packageJsonPath);
  const [packageJson, javascript, javascriptMap, types, typesMap] =
    await Promise.all([
      readFile(packageJsonPath, "utf8"),
      readFile(path.join(packageRoot, "dist/index.js"), "utf8"),
      readFile(path.join(packageRoot, "dist/index.js.map"), "utf8"),
      readFile(path.join(packageRoot, "dist/index.d.ts"), "utf8"),
      readFile(path.join(packageRoot, "dist/index.d.ts.map"), "utf8"),
    ]);
  return {
    packageName: APP_PACKAGE_NAME,
    files: {
      "package.json": packageJson,
      "dist/index.js": javascript,
      "dist/index.js.map": javascriptMap,
      "dist/index.d.ts": types,
      "dist/index.d.ts.map": typesMap,
    },
  };
}

export async function loadWorkflowPackagePayload(): Promise<WorkflowPackagePayload> {
  const require = createRequire(import.meta.url);
  const packageJsonPath = require.resolve(
    `${WORKFLOW_PACKAGE_NAME}/package.json`,
  );
  const packageRoot = path.dirname(packageJsonPath);
  const [
    packageJson,
    javascript,
    javascriptMap,
    indexTypes,
    indexTypesMap,
    batchTypes,
    batchTypesMap,
    jsonTypes,
    jsonTypesMap,
    workflowTypes,
    workflowTypesMap,
  ] = await Promise.all([
    readFile(packageJsonPath, "utf8"),
    readFile(path.join(packageRoot, "dist/index.js"), "utf8"),
    readFile(path.join(packageRoot, "dist/index.js.map"), "utf8"),
    readFile(path.join(packageRoot, "dist/index.d.ts"), "utf8"),
    readFile(path.join(packageRoot, "dist/index.d.ts.map"), "utf8"),
    readFile(path.join(packageRoot, "dist/batch.d.ts"), "utf8"),
    readFile(path.join(packageRoot, "dist/batch.d.ts.map"), "utf8"),
    readFile(path.join(packageRoot, "dist/json.d.ts"), "utf8"),
    readFile(path.join(packageRoot, "dist/json.d.ts.map"), "utf8"),
    readFile(path.join(packageRoot, "dist/workflow.d.ts"), "utf8"),
    readFile(path.join(packageRoot, "dist/workflow.d.ts.map"), "utf8"),
  ]);
  const metadata = parsePackageMetadata(packageJson);
  return {
    packageName: WORKFLOW_PACKAGE_NAME,
    version: metadata.version,
    files: {
      "package.json": packageJson,
      "dist/index.js": javascript,
      "dist/index.js.map": javascriptMap,
      "dist/index.d.ts": indexTypes,
      "dist/index.d.ts.map": indexTypesMap,
      "dist/batch.d.ts": batchTypes,
      "dist/batch.d.ts.map": batchTypesMap,
      "dist/json.d.ts": jsonTypes,
      "dist/json.d.ts.map": jsonTypesMap,
      "dist/workflow.d.ts": workflowTypes,
      "dist/workflow.d.ts.map": workflowTypesMap,
    },
  };
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

function parsePackageMetadata(packageJson: string): {
  name: string;
  version: string;
} {
  const parsed = parseJsonObject(packageJson);
  if (
    parsed.name !== WORKFLOW_PACKAGE_NAME ||
    typeof parsed.version !== "string"
  ) {
    throw new Error("Invalid @catamorphic/workflow package metadata");
  }
  return { name: parsed.name, version: parsed.version };
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
