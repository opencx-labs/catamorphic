"use client";

import { WorkflowEditor } from "@catamorphic/ui";
import { useCallback, useState } from "react";
import "@catamorphic/ui/styles.css";
import { MonacoCodeEditor } from "@/components/monaco-editor";
import { generateWorkflowCode } from "@/lib/ai-action";
import { parseWorkflowAction } from "@/lib/parse-action";

const STARTER_CODE = `/**
 * @displayname My Workflow
 * @description A new workflow
 */
export async function myWorkflow({ input }: { input: string }) {
  "use workflow";

  return { result: input };
}
`;

export default function NewWorkflowPage() {
  const [code, setCode] = useState(STARTER_CODE);

  const handleCodeChange = useCallback((newCode: string) => {
    setCode(newCode);
  }, []);

  const handleAIPrompt = useCallback(
    async (prompt: string) => {
      const result = await generateWorkflowCode({
        prompt,
        currentCode: code,
      });
      return result;
    },
    [code],
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
      />
    </div>
  );
}
