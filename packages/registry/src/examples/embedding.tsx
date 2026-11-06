import { useForkAgentSession, useOnParse } from "@catamorphic/react";
import { WorkflowEditor } from "@catamorphic/ui";
import { type ComponentProps, useState } from "react";
import { AgentChat } from "../agent-chat/agent-chat.js";

/**
 * Mounted under the host's CatamorphicProvider; auth and API base belong to
 * it. The host decides which session is open, so a fork opens the copy.
 */
export function EmbeddedChat({
  projectId,
  viewerId,
}: {
  projectId: string;
  /** The signed-in person's external user id, from the host's auth. */
  viewerId?: string;
}) {
  const [sessionId, setSessionId] = useState<string>();
  const fork = useForkAgentSession(projectId);
  return (
    <AgentChat
      projectId={projectId}
      sessionId={sessionId}
      onSessionCreated={setSessionId}
      variant="full"
      viewerId={viewerId}
      onFork={({ sessionId: source, itemId }) =>
        fork.mutate(
          { sessionId: source, messageId: itemId },
          { onSuccess: (forked) => setSessionId(forked.id) },
        )
      }
    />
  );
}

/** Inspector and execution actions are supplied by the host, not desktop. */
export function EmbeddedWorkflow({
  files,
  workflowName,
  initialCode,
  renderInspector,
  onRun,
}: {
  files: Parameters<typeof useOnParse>[0]["files"];
  workflowName: string;
  initialCode: string;
  renderInspector: ComponentProps<typeof WorkflowEditor>["renderInspector"];
  onRun: ComponentProps<typeof WorkflowEditor>["onRun"];
}) {
  const [code, setCode] = useState(initialCode);
  const onParse = useOnParse({ files, workflowName });
  return (
    <WorkflowEditor
      code={code}
      onCodeChange={setCode}
      onParse={onParse}
      renderInspector={renderInspector}
      onRun={onRun}
    />
  );
}
