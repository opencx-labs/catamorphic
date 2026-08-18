import { DOCUMENTS_CAPABILITY } from "@catamorphic/sandbox";
import type { Identity } from "../identity.js";
import type { CapabilityRegistry } from "./capability-providers.js";
import type { DocumentsService } from "./documents-service.js";

/**
 * Serves `host_call` transitions (ADR 0055): a boundary returned
 * `context.documents.<fn>(args)` or `context.host.<capability>.<fn>(args)`;
 * core runs it AS THE RUN'S CALLER and feeds the result to the next step.
 * The caller is the identity stamped on the run at trigger time — a
 * workflow cannot widen it, so a project author cannot leak what the caller
 * may not see, whether or not they remember to filter.
 */
export interface HostCallInput {
  caller: Identity;
  projectId: string;
  runId: string;
  workflowName: string;
  capability: string;
  fn: string;
  args: unknown;
}

export async function executeHostCall(
  deps: { documents: DocumentsService; capabilities: CapabilityRegistry },
  input: HostCallInput,
): Promise<unknown> {
  if (input.capability === DOCUMENTS_CAPABILITY) {
    return callDocuments(deps.documents, input);
  }
  return deps.capabilities.call(
    input.capability,
    input.fn,
    {
      caller: input.caller,
      projectId: input.projectId,
      runId: input.runId,
      workflowName: input.workflowName,
    },
    input.args,
  );
}

function record(value: unknown, what: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${what} expects an object argument`);
  }
  return value as Record<string, unknown>;
}

function str(value: unknown, name: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`'${name}' must be a non-empty string`);
  }
  return value;
}

function optStr(value: unknown, name: string): string | undefined {
  if (value === undefined) return undefined;
  return str(value, name);
}

function optInt(value: unknown, name: string): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    throw new Error(`'${name}' must be a non-negative integer`);
  }
  return value;
}

function optEnum<T extends string>(
  value: unknown,
  name: string,
  allowed: readonly T[],
): T | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !allowed.includes(value as T)) {
    throw new Error(`'${name}' must be one of ${allowed.join(", ")}`);
  }
  return value as T;
}

async function callDocuments(
  documents: DocumentsService,
  input: HostCallInput,
): Promise<unknown> {
  const { caller: identity, projectId } = input;
  const args = record(input.args ?? {}, `documents.${input.fn}`);
  switch (input.fn) {
    case "list":
      return documents.list({
        identity,
        projectId,
        ...(optStr(args.prefix, "prefix") !== undefined
          ? { prefix: args.prefix as string }
          : {}),
        ...(optEnum(args.source, "source", ["program", "store"] as const)
          ? { source: args.source as "program" | "store" }
          : {}),
      });
    case "read": {
      const doc = await documents.read({
        identity,
        projectId,
        path: str(args.path, "path"),
        ...(optInt(args.version, "version") !== undefined
          ? { version: args.version as number }
          : {}),
      });
      const { bytes: _bytes, ...rest } = doc;
      return rest;
    }
    case "write":
      return documents.write({
        identity,
        projectId,
        path: str(args.path, "path"),
        content: str(args.text, "text"),
        ...(optStr(args.contentType, "contentType") !== undefined
          ? { contentType: args.contentType as string }
          : {}),
        ...(optInt(args.ifVersion, "ifVersion") !== undefined
          ? { ifVersion: args.ifVersion as number }
          : {}),
      });
    case "delete":
      return documents.delete({
        identity,
        projectId,
        path: str(args.path, "path"),
        ...(optInt(args.ifVersion, "ifVersion") !== undefined
          ? { ifVersion: args.ifVersion as number }
          : {}),
      });
    case "history":
      return documents.history({
        identity,
        projectId,
        path: str(args.path, "path"),
      });
    case "search":
      return documents.search({
        identity,
        projectId,
        query: str(args.query, "query"),
        ...(optEnum(args.mode, "mode", ["grep", "text"] as const)
          ? { mode: args.mode as "grep" | "text" }
          : {}),
        ...(optStr(args.prefix, "prefix") !== undefined
          ? { prefix: args.prefix as string }
          : {}),
        ...(optInt(args.limit, "limit") !== undefined
          ? { limit: args.limit as number }
          : {}),
      });
    default:
      throw new Error(
        `documents.${input.fn} is not a documents operation (list, read, write, delete, history, search)`,
      );
  }
}
