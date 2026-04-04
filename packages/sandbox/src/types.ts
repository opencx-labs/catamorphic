export interface SandboxConfig {
  provider: "local" | "docker" | "e2b" | "daytona";
  agent: "claude" | "codex" | "opencode";
  packages?: string[];
  providerOptions?: Record<string, unknown>;
}

export interface SandboxEvent {
  type: "text" | "tool_call" | "error" | "done";
  content?: string;
  toolName?: string;
  toolInput?: unknown;
}

export interface CatamorphicSandbox {
  prompt(input: {
    message: string;
    currentCode?: string;
  }): AsyncIterable<SandboxEvent>;

  executeWorkflow(input: {
    code: string;
    triggerData: unknown;
  }): Promise<{ success: boolean; result?: unknown; error?: string }>;

  dispose(): Promise<void>;
}
