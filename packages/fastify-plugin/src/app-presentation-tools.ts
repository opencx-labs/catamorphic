import { APP_ICON_DESCRIPTIONS, APP_ICON_NAMES } from "@catamorphic/app";
import type { CatamorphicCore, Identity } from "@catamorphic/core";
import { z } from "zod";
import { toolError, toolValue } from "./mcp-shared.js";
import type { SurfaceTool } from "./project-mcp-surface.js";

const Input = z
  .object({
    appName: z.string().min(1),
    icon: z.enum(APP_ICON_NAMES).optional(),
    title: z.string().trim().min(1).max(200).optional(),
  })
  .refine(
    (value) => value.icon !== undefined || value.title !== undefined,
    "Supply a title or icon",
  );

export function appPresentationTool(
  core: CatamorphicCore,
  identity: Identity,
  projectId: string,
): SurfaceTool {
  return {
    definition: {
      name: "set_app_presentation",
      description: `Set an app's title and/or canonical icon without rebuilding or publishing. Use a short, descriptive title that names what the app does or contains. Match the language of the task, avoid generic labels like Session app, and keep the title stable through revisions. There is no required title template. Use the returned appName for temporary apps, not their display title. All reviews use review. Choose default when in doubt; never infer a specialized type just from a filename. Choices: ${APP_ICON_NAMES.map((name) => `${name}: ${APP_ICON_DESCRIPTIONS[name]}`).join("; ")}.`,
      inputSchema: z.toJSONSchema(Input),
    },
    call: async (raw) => {
      try {
        if (!core.apps) throw new Error("Apps are unavailable");
        return toolValue(
          await core.apps.updatePresentation({
            ...Input.parse(raw),
            identity,
            projectId,
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
