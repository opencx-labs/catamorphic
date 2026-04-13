"use client";

import { WorkflowEditor } from "@catamorphic/ui";
import { useCallback, useRef, useState } from "react";
import "@catamorphic/ui/styles.css";
import { MonacoCodeEditor } from "@/components/monaco-editor";
import { generateWorkflowCode } from "@/lib/ai-action";
import { parseWorkflowAction } from "@/lib/parse-action";
import { runWorkflowAction } from "@/lib/run-action";

const STARTER_CODE = `/**
 * @displayname My Workflow
 * @description A new workflow
 */
export async function myWorkflow({ input }: { input: string }) {
  "use workflow";

  return { result: input };
}
`;

export default function NewProjectPage() {
  const [code, setCode] = useState(STARTER_CODE);
  const codeRef = useRef(code);

  const handleCodeChange = useCallback((newCode: string) => {
    setCode(newCode);
    codeRef.current = newCode;
  }, []);

  const handleAIPrompt = useCallback(
    async (prompt: string) => {
      return generateWorkflowCode({
        prompt,
        currentCode: code,
      });
    },
    [code],
  );

  const handleRun = useCallback(
    async (triggerData: Record<string, unknown>) => {
      const fnMatch = codeRef.current.match(
        /export\s+async\s+function\s+(\w+)/,
      );
      const workflowName = fnMatch?.[1] ?? "myWorkflow";
      const result = await runWorkflowAction({
        files: { "src/workflow.ts": codeRef.current },
        workflowName,
        triggerData,
      });
      return {
        status: result.status,
        result: result.result,
        error: result.error,
        steps: result.steps,
        startedAt: result.startedAt,
        completedAt: result.completedAt,
      };
    },
    [],
  );

  return (
    <div className="h-[calc(100vh-3.5rem)]">
      <WorkflowEditor
        code={code}
        onCodeChange={handleCodeChange}
        onParse={parseWorkflowAction}
        renderCodeEditor={(props) => <MonacoCodeEditor {...props} />}
        showCodeEditor={true}
        showMinimap={true}
        aiEnabled={true}
        onAIPrompt={handleAIPrompt}
        onRun={handleRun}
      />
    </div>
  );
}
