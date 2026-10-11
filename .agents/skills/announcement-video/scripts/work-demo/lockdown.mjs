// Writes demo/.claude/settings.json so the film's agent cannot reach the
// person's own accounts. "Use your Claude Code setup" runs Claude Code on
// their login, which brings every claude.ai connector, their user MCP
// servers and their plugins. Run it once per machine before any take, then
// check in a scratch project that tool search finds none of them.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const read = (file) => {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return {};
  }
};
const state = read(path.join(os.homedir(), ".claude.json"));
const settings = read(path.join(os.homedir(), ".claude", "settings.json"));
const serverName = (name) =>
  name.replace(/[^A-Za-z0-9_-]+/g, "_").replace(/^_+|_+$/g, "");
const deny = [
  ...(state.claudeAiMcpEverConnected ?? []).map(
    (name) =>
      `mcp__claude_ai_${serverName(name.replace(/^claude\.ai\s+/, ""))}`,
  ),
  ...Object.keys(state.mcpServers ?? {}).map(
    (name) => `mcp__${serverName(name)}`,
  ),
  // A plugin's server is usually named after the plugin; turning the plugin
  // off below is what removes it.
  ...Object.keys(settings.enabledPlugins ?? {}).map((id) => {
    const name = serverName(id.split("@")[0]);
    return `mcp__plugin_${name}_${name}`;
  }),
  "WebFetch",
  "WebSearch",
];
const enabledPlugins = Object.fromEntries(
  Object.keys(settings.enabledPlugins ?? {}).map((name) => [name, false]),
);
const out = new URL("./demo/.claude/settings.json", import.meta.url).pathname;
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(
  out,
  `${JSON.stringify({ enabledPlugins, permissions: { deny } }, null, 2)}\n`,
);
console.log(
  `${out}: ${deny.length} denied, ${Object.keys(enabledPlugins).length} plugins off`,
);
