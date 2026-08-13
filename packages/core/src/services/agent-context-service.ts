import type { PluginResolver } from "@catamorphic/plugins";
import type { PluginsService } from "./plugins-service.js";

/**
 * Builds an LLM-ready suffix describing every plugin attached to a project —
 * README + `dist/index.d.ts` inlined — so the workflow-builder model knows
 * exactly which packages it can import and which symbols each one exposes.
 *
 * Kept deliberately small: no truncation for v1 (workflow SDKs are expected to
 * ship a curated surface). Revisit if a plugin ships a 100KB d.ts.
 */
export class AgentContextService {
  constructor(
    private readonly plugins: PluginsService,
    private readonly resolver: PluginResolver,
  ) {}

  async buildPrompt(projectId: string): Promise<string> {
    const attached = await this.plugins.loadAttachedResolved(projectId);
    if (attached.length === 0) return "";

    const sections: string[] = [];
    for (const plugin of attached) {
      const [readme, types] = await Promise.all([
        this.resolver.readReadme(plugin),
        this.resolver.readTypes(plugin),
      ]);

      const parts: string[] = [];
      parts.push(
        `## ${plugin.packageName} (${plugin.manifest.displayName})`,
        plugin.manifest.description,
      );
      if (readme) {
        parts.push("### README", readme.trim());
      }
      if (types) {
        parts.push(`### Types (${plugin.manifest.docs.types})`);
        parts.push("```typescript");
        parts.push(types.trim());
        parts.push("```");
      }
      sections.push(parts.join("\n\n"));
    }

    return [
      "<attached_packages>",
      "The following NPM packages are attached to this project and installed at runtime. They are available to import from the project's code (workflows, steps, scripts). Use their exported functions and types; do NOT invent new names.",
      "",
      sections.join("\n\n---\n\n"),
      "</attached_packages>",
    ].join("\n");
  }
}
