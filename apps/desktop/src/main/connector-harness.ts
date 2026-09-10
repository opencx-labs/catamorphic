import fs from "node:fs";
import path from "node:path";

const staged = new Map<string, { stamp: string; target: string }>();
/** Native plugins provide skills/commands; the connection store alone owns MCP credentials. */
export function connectorHarnessPath(source: string): string {
  const manifest = path.join(source, ".claude-plugin", "plugin.json");
  const stamp = [source, manifest, path.join(source, ".mcp.json")]
    .map((file) => {
      try {
        const stat = fs.statSync(file);
        return `${stat.mtimeMs}:${stat.size}`;
      } catch {
        return "missing";
      }
    })
    .join(":");
  const cached = staged.get(source);
  if (cached?.stamp === stamp) return cached.target;
  const target = path.join(
    path.dirname(source),
    ".harness",
    path.basename(source),
  );
  fs.mkdirSync(path.dirname(target), { recursive: true });
  // This directory is a disposable projection, never the installed source.
  fs.rmSync(target, { recursive: true, force: true });
  fs.cpSync(source, target, {
    recursive: true,
    filter: (entry) => ![".git", ".mcp.json"].includes(path.basename(entry)),
  });
  const targetManifest = path.join(target, ".claude-plugin", "plugin.json");
  if (fs.existsSync(targetManifest)) {
    const value: unknown = JSON.parse(fs.readFileSync(targetManifest, "utf8"));
    if (!value || typeof value !== "object" || Array.isArray(value))
      throw new Error("Invalid connector plugin manifest");
    const clean = Object.fromEntries(
      Object.entries(value).filter(([key]) => key !== "mcpServers"),
    );
    fs.writeFileSync(targetManifest, JSON.stringify(clean, null, 2));
  }
  staged.set(source, { stamp, target });
  return target;
}
