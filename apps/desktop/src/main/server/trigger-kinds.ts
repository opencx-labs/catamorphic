import {
  aiToolCall,
  defineTriggerKind,
  SESSION_TRIGGER_KINDS,
  schedule,
  webhook,
} from "@catamorphic/server-sdk";
import { z } from "zod";

/** Pure host registrations shared by execution and installed authoring types. */
export const terminalIdle = defineTriggerKind({
  name: "terminal.idle",
  description:
    "A terminal in this project returned to its prompt after running a command",
  display: { label: "Terminal Idle", icon: "zap", color: "#0e7490" },
  payload: z.object({ sessionId: z.string(), shell: z.string() }),
});
export const DESKTOP_TRIGGER_KINDS = [
  ...SESSION_TRIGGER_KINDS,
  terminalIdle,
  aiToolCall,
  schedule,
  webhook,
];
