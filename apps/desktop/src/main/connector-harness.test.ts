import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { connectorHarnessPath } from "./connector-harness.js";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0))
    fs.rmSync(dir, { recursive: true, force: true });
});
it("stages skills without the plugin's unresolved MCP config and preserves installed files", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "connector-harness-"));
  dirs.push(dir);
  const source = path.join(dir, "github");
  fs.mkdirSync(path.join(source, ".claude-plugin"), { recursive: true });
  fs.mkdirSync(path.join(source, "skills"));
  const manifest = JSON.stringify({
    name: "github",
    mcpServers: "./.mcp.json",
  });
  fs.writeFileSync(path.join(source, ".claude-plugin/plugin.json"), manifest);
  fs.writeFileSync(
    path.join(source, ".mcp.json"),
    // biome-ignore lint/suspicious/noTemplateCurlyInString: fixture for native plugin staging
    '{"token":"${GITHUB_PERSONAL_ACCESS_TOKEN}"}',
  );
  fs.writeFileSync(path.join(source, "skills/SKILL.md"), "Use GitHub");
  const staged = connectorHarnessPath(source);
  expect(fs.existsSync(path.join(staged, ".mcp.json"))).toBe(false);
  expect(
    JSON.parse(
      fs.readFileSync(path.join(staged, ".claude-plugin/plugin.json"), "utf8"),
    ),
  ).toEqual({ name: "github" });
  expect(fs.readFileSync(path.join(staged, "skills/SKILL.md"), "utf8")).toBe(
    "Use GitHub",
  );
  expect(
    fs.readFileSync(path.join(source, ".claude-plugin/plugin.json"), "utf8"),
  ).toBe(manifest);
  expect(fs.existsSync(path.join(source, ".mcp.json"))).toBe(true);
});
