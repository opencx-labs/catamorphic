import type { AttemptStart } from "@catamorphic/agent-protocol/runner";
import { describe, expect, it } from "vitest";
import { codexLaunch } from "../config.js";
import { attemptBase } from "./replay/scenarios.js";

const context = {
  root: "/work-root",
  model: "https://gateway.example/v1",
  node: "node",
  fixtures: "/fixtures",
  command: "/opt/codex",
};

function launch(overrides: Partial<AttemptStart>) {
  const result = codexLaunch({
    ...attemptBase(context, { ordinal: 1, text: "Hi" }),
    options: {},
    ...overrides,
  });
  if (typeof result === "string") throw new Error(result);
  return result;
}

describe("codexLaunch", () => {
  it("reaches the gateway with a key command and a home in the state directory (ADR 0180)", () => {
    const result = launch({});
    expect(result.spawn.command).toBe("codex");
    expect(result.spawn.env).toEqual({
      WORK_MODEL_KEY_FILE: "/work-root/model-key",
      CODEX_HOME: "/work-root/state/codex-home",
    });
    expect(result.home).toBe("/work-root/state/codex-home");
    expect(result.spawn.args).toContain('model_provider="work"');
    expect(result.spawn.args.join(" ")).toContain(
      '"base_url"="https://gateway.example/v1"',
    );
    expect(result.spawn.args.join(" ")).not.toContain("model-key");
    // Outside the host the Work sandbox is the boundary.
    expect(launch({ permissions: {} }).sandbox).toBe("danger-full-access");
    expect(launch({ permissions: {} }).approvalPolicy).toBe("on-request");
  });

  it("gives Codex the session's secrets the runner read, under Work's own settings (ADR 0205)", () => {
    const result = launch({
      envFiles: [
        "/workspace/.work-session/env/gateway.sh",
        "/workspace/.work-session/env/secrets.sh",
      ],
      // What the runner adds from the file before the adapter starts.
      env: {
        CLICKHOUSE_API_KEY: "ch-key",
        BASH_ENV: "/workspace/.work-session/env/secrets.sh",
      },
    });
    expect(result.spawn.env).toEqual({
      CLICKHOUSE_API_KEY: "ch-key",
      BASH_ENV: "/workspace/.work-session/env/secrets.sh",
      WORK_MODEL_KEY_FILE: "/work-root/model-key",
      CODEX_HOME: "/work-root/state/codex-home",
    });
  });

  it("refuses a gateway connection that does not speak the OpenAI API", () => {
    expect(
      codexLaunch({
        ...attemptBase(context, { ordinal: 1, text: "Hi" }),
        modelAccess: {
          kind: "gateway",
          api: "anthropic",
          baseUrl: "https://gateway.example",
          keyFile: "/key",
        },
      }),
    ).toBe(
      "Codex speaks the OpenAI API; this chat's model connection is an anthropic API.",
    );
  });

  it("runs a sign-in in its own home and the host's Codex as configured (ADR 0199)", () => {
    const signIn = launch({
      modelAccess: { kind: "sign_in", home: "/homes/ada" },
    });
    expect(signIn.spawn.env).toEqual({ CODEX_HOME: "/homes/ada" });
    expect(signIn.spawn.args.join(" ")).not.toContain("model_provider");
    const host = launch({
      modelAccess: { kind: "host" },
      env: { CODEX_HOME: "/agent-home", CODEX_API_KEY: "sk-host" },
      permissions: {},
    });
    expect(host.home).toBe("/agent-home");
    expect(host.sandbox).toBe("workspace-write");
    expect(host.spawn.args).toEqual(
      expect.arrayContaining([
        'model_providers.openai.env_key="CODEX_API_KEY"',
        "model_providers.openai.requires_openai_auth=false",
      ]),
    );
  });

  it("reads harness permissions and per-agent options", () => {
    const result = launch({
      permissions: { sandbox: "read-only", approvals: "never" },
      options: {
        command: "/opt/codex",
        disableNativeSubagents: true,
        disableNativeGoals: true,
        networkAccess: false,
        config: { "analytics.enabled": false },
      },
    });
    expect(result.spawn.command).toBe("/opt/codex");
    expect(result.sandbox).toBe("read-only");
    expect(result.approvalPolicy).toBe("never");
    expect(result.threadConfig).toEqual({
      "sandbox_workspace_write.network_access": false,
      model_reasoning_summary: "auto",
    });
    expect(result.spawn.args).toEqual(
      expect.arrayContaining([
        'features={"default_mode_request_user_input"=true,"multi_agent"=false,"goals"=false}',
        "analytics.enabled=false",
      ]),
    );
  });
});
