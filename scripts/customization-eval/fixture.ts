import type { JsonValue } from "../../packages/agent-protocol/src/model.js";
import type { HostToolDescriptor } from "../../packages/agent-protocol/src/runner.js";
import type { Grade } from "./grade.js";

export interface EvalFixture {
  context?: { sessionId: string; projectId: string };
  tools: HostToolDescriptor[];
  sourceWork?: (input: {
    modulePath: string;
  }) => (requestId: string, call: unknown) => Promise<unknown>;
  seed(): Promise<void>;
  invoke(input: { name: string; input: JsonValue }): Promise<JsonValue>;
  grade(): Promise<Grade[]>;
  close(): Promise<void>;
}
