"use client";

import { WorkflowEditor } from "@catamorphic/ui";
import { useParams } from "next/navigation";
import { useCallback, useState } from "react";
import "@catamorphic/ui/styles.css";
import { MonacoCodeEditor } from "@/components/monaco-editor";
import { generateWorkflowCode } from "@/lib/ai-action";
import { parseWorkflowAction } from "@/lib/parse-action";
import { SAMPLE_WORKFLOWS } from "@/lib/sample-workflows";

export default function WorkflowEditorPage() {
  const params = useParams<{ id: string }>();
  const sample = SAMPLE_WORKFLOWS[params.id];

  const [code, setCode] = useState(sample?.code ?? "");

  const handleCodeChange = useCallback((newCode: string) => {
    setCode(newCode);
  }, []);

  const handleRun = useCallback(() => {
    console.log("Run workflow:", params.id);
  }, [params.id]);

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
        onRun={handleRun}
        aiEnabled={true}
        onAIPrompt={handleAIPrompt}
      />
    </div>
  );
}
