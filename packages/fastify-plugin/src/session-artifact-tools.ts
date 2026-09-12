import { APP_ICON_NAMES } from "@catamorphic/app";
import type { CatamorphicCore, Identity } from "@catamorphic/core";
import { z } from "zod";
import { toolError, toolValue } from "./mcp-shared.js";
import type { SurfaceTool } from "./project-mcp-surface.js";

const Input = z.object({
  action: z.enum(["create", "list", "read", "update", "discard", "run"]),
  sessionId: z.string().uuid().optional(),
  artifactId: z.string().uuid().optional(),
  kind: z.enum(["app", "workflow"]).optional(),
  name: z.string().max(100).optional(),
  title: z.string().max(200).optional(),
  icon: z.enum(APP_ICON_NAMES).optional(),
  source: z.string().optional(),
  files: z.record(z.string(), z.string().nullable()).optional(),
  revision: z.number().int().positive().optional(),
  environment: z.string().optional(),
  input: z.json().optional(),
});

/** The same source lifecycle is available to every harness through project MCP. */
export function sessionArtifactTool(
  core: CatamorphicCore,
  identity: Identity,
  projectId: string,
  currentSessionId?: string,
): SurfaceTool {
  return {
    definition: {
      name: "session_artifact",
      description:
        "Create, read, update, run or discard a temporary app or workflow owned by this session. Load the session-artifacts skill first. App source is a React component exporting default; the host supplies the standard app scaffold and builds it immediately. Additional files use ordinary workspace paths and may include shared components, dependencies and helper workflows. Workflow source is an ordinary exported defineWorkflow. No files are added to the user's checkout. Results survive closing tabs and remain available with the chat. Update requires the revision returned by read; files are explicit changed paths. Apps return their ordinary app:<appName> target. Creating a workflow does not run or enable it; use run for a one-off invocation, and the watcher tool for temporary scheduled activation. Discard prevents new use. Saving reusable work into the project is a separate selected-file change.",
      inputSchema: z.toJSONSchema(Input),
    },
    call: async (raw) => {
      try {
        const input = Input.parse(raw);
        const sessionId = input.sessionId ?? currentSessionId;
        if (!sessionId) throw new Error("sessionId is required");
        if (input.action === "list")
          return toolValue(
            await core.sessionArtifacts.list({
              identity,
              projectId,
              sessionId,
            }),
          );
        if (input.action === "create") {
          if (!input.kind || !input.name || !input.source)
            throw new Error("kind, name and source are required");
          if (input.kind === "app" && !core.apps)
            throw new Error("App building is unavailable");
          const artifact = await core.sessionArtifacts.create({
            identity,
            projectId,
            sessionId,
            kind: input.kind,
            name: input.name,
            title: input.title,
            source: input.source,
            files: input.files
              ? Object.fromEntries(
                  Object.entries(input.files).filter(
                    (entry): entry is [string, string] => entry[1] !== null,
                  ),
                )
              : undefined,
          });
          const build =
            artifact.appName && core.apps
              ? await core.apps.build({
                  identity,
                  projectId,
                  appName: artifact.appName,
                  artifactId: artifact.id,
                  kind: "preview",
                })
              : null;
          if (artifact.appName && input.icon && core.apps)
            await core.apps.updatePresentation({
              identity,
              projectId,
              appName: artifact.appName,
              icon: input.icon,
            });
          return toolValue({
            artifact,
            build,
            target: artifact.appName
              ? `app:${artifact.appName}`
              : `artifact:${artifact.id}`,
          });
        }
        if (!input.artifactId) throw new Error("artifactId is required");
        const address = { identity, projectId, artifactId: input.artifactId };
        if (input.action === "discard") {
          const items = await core.sessionArtifacts.list({
            identity,
            projectId,
            sessionId,
          });
          if (!items.some((item) => item.id === input.artifactId))
            throw new Error("Artifact belongs to another session");
          await core.sessionArtifacts.discard(address);
          await core.watchers?.stop({
            identity,
            projectId,
            sessionId,
            watcherId: input.artifactId,
          });
          return toolValue({ discarded: true });
        }
        const artifact = await core.sessionArtifacts.get(address);
        if (artifact.sessionId !== sessionId)
          throw new Error("Artifact belongs to another session");
        if (input.action === "read")
          return toolValue({
            artifact,
            files: await core.sessionArtifacts.files(address),
          });
        if (input.action === "update") {
          if (!input.revision || !input.files)
            throw new Error("revision and files are required");
          const updated = await core.sessionArtifacts.update({
            ...address,
            revision: input.revision,
            files: input.files,
            title: input.title,
          });
          const build =
            updated.appName && core.apps
              ? await core.apps.build({
                  identity,
                  projectId,
                  appName: updated.appName,
                  artifactId: updated.id,
                  kind: "preview",
                })
              : null;
          return toolValue({
            artifact: updated,
            build,
            target: updated.appName
              ? `app:${updated.appName}`
              : `artifact:${updated.id}`,
          });
        }
        if (artifact.kind !== "workflow")
          throw new Error("Only workflow artifacts can be run");
        await core.sessionArtifacts.assertActive(address);
        return toolValue(
          await core.runs.triggerAtCommit({
            identity,
            projectId,
            workflowName: artifact.name,
            commitSha: artifact.commitSha,
            remoteBranch: artifact.remoteBranch,
            environment: input.environment,
            input: input.input,
          }),
        );
      } catch (error) {
        return toolError(
          error instanceof Error ? error.message : String(error),
        );
      }
    },
  };
}
