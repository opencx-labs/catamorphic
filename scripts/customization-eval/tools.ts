import path from "node:path";
import {
  checkCustomization,
  previewCustomization,
} from "../../apps/desktop/src/main/customization-check.js";
import type { JsonValue } from "../../packages/agent-protocol/src/model.js";
import type { HostToolDescriptor } from "../../packages/agent-protocol/src/runner.js";
import type { EvalFixture } from "./fixture.js";
import { evalSourceAccess, projectFile } from "./grade.js";

export const EVAL_CUSTOMIZATION_TOOLS: HostToolDescriptor[] = [
  {
    name: "check_customization",
    description:
      "Use Work's installed checker to validate a source and optional workspace layout against the public Work SDK. Returns compiler and layout diagnostics without executing project scripts.",
    inputSchema: {
      type: "object",
      properties: { source: { type: "string" }, workspace: { type: "string" } },
      required: ["source"],
      additionalProperties: false,
    },
  },
  {
    name: "preview_customization",
    description:
      "Load a sidebar source in Work's real confined source worker. Returns actual validated rows or runtime diagnostics. Does not activate a layout or change personal settings.",
    inputSchema: {
      type: "object",
      properties: {
        source: {
          type: "string",
          description: "Project-relative TypeScript source module path",
        },
      },
      required: ["source"],
      additionalProperties: false,
    },
  },
];

export async function evalCustomizationTool(input: {
  name: string;
  input: JsonValue;
  project: string;
  directory: string;
  repository: string;
  sourceWork?: EvalFixture["sourceWork"];
}): Promise<JsonValue> {
  if (input.name === "check_customization") {
    const args = input.input;
    if (!args || typeof args !== "object" || Array.isArray(args))
      throw new Error("Check requires a source path");
    const sourcePath = await projectFile({
      project: input.project,
      relative: args.source,
    });
    const workspacePath = args.workspace
      ? await projectFile({ project: input.project, relative: args.workspace })
      : undefined;
    return JSON.parse(
      JSON.stringify(
        await checkCustomization({
          projectRoot: input.project,
          sourcePath,
          workspacePath,
          sdkRoot: input.project,
          bunPath: process.execPath,
        }),
      ),
    );
  }
  if (input.name !== "preview_customization")
    throw new Error(`Unknown eval capability ${input.name}`);
  const args = input.input;
  if (!args || typeof args !== "object" || Array.isArray(args))
    throw new Error("Preview requires a source path");
  const modulePath = await projectFile({
    project: input.project,
    relative: args.source,
  });
  const approvedAccess = evalSourceAccess({
    project: input.project,
    modulePath,
  });
  return JSON.parse(
    JSON.stringify(
      await previewCustomization({
        projectRoot: input.project,
        sourcePath: modulePath,
        workerPath: path.join(
          input.directory,
          "profile/runtime/sidebar-source-worker.mjs",
        ),
        scratchRoot: path.join(input.directory, "profile", "preview"),
        toolchain: {
          PATH: process.env.PATH ?? "",
          CATAMORPHIC_BUN: process.execPath,
        },
        approvedAccess,
        work: input.sourceWork?.({ modulePath }),
      }),
    ),
  );
}
