import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, it } from "vitest";
import { readClaudeCodeUsage } from "../list-models.js";

it("reports a Claude Code home nobody signed in to as signed out, without a request", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "claude-usage-"));
  try {
    const usage = await readClaudeCodeUsage({
      env: {
        CLAUDE_CONFIG_DIR: home,
        ANTHROPIC_API_KEY: "",
        ANTHROPIC_AUTH_TOKEN: "",
        CLAUDE_CODE_OAUTH_TOKEN: "",
        ANTHROPIC_BASE_URL: "http://127.0.0.1:9",
        CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
        HTTP_PROXY: "http://127.0.0.1:9",
        HTTPS_PROXY: "http://127.0.0.1:9",
      },
    });
    expect(usage).toEqual({ signedIn: false });
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});
