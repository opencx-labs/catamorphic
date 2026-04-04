import { useSetAtom } from "jotai";
import { useCallback, useRef, useState } from "react";
import { aiLoadingAtom, codeAtom } from "./atoms.js";

export interface AIBarProps {
  onAIPrompt?: (prompt: string) => Promise<string>;
  enabled?: boolean;
}

export function AIBar({ onAIPrompt, enabled = true }: AIBarProps) {
  const [prompt, setPrompt] = useState("");
  const setCode = useSetAtom(codeAtom);
  const setLoading = useSetAtom(aiLoadingAtom);
  const [loading, setLocalLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const handleSubmit = useCallback(
    async (e: React.FormEvent) => {
      e.preventDefault();
      if (!prompt.trim() || !onAIPrompt || loading) return;

      setLoading(true);
      setLocalLoading(true);
      setError(null);

      try {
        const updatedCode = await onAIPrompt(prompt);
        setCode(updatedCode);
        setPrompt("");
      } catch (err) {
        setError(err instanceof Error ? err.message : "AI request failed");
      } finally {
        setLoading(false);
        setLocalLoading(false);
      }
    },
    [prompt, onAIPrompt, loading, setLoading, setCode],
  );

  if (!enabled || !onAIPrompt) return null;

  return (
    <div className="catamorphic-ai-bar">
      <form
        onSubmit={handleSubmit}
        style={{ display: "flex", flex: 1, gap: 8 }}
      >
        <input
          ref={inputRef}
          type="text"
          className="catamorphic-ai-input"
          placeholder="Ask AI to create or edit workflows..."
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          disabled={loading}
        />
        <button
          type="submit"
          className="catamorphic-ai-send"
          disabled={loading || !prompt.trim()}
        >
          {loading ? "..." : "Send"}
        </button>
      </form>
      {error && (
        <div style={{ color: "#ef4444", fontSize: 12, marginLeft: 8 }}>
          {error}
        </div>
      )}
    </div>
  );
}
