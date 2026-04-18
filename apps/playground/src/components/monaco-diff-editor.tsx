"use client";

import dynamic from "next/dynamic";

const DiffEditor = dynamic(
  () => import("@monaco-editor/react").then((m) => m.DiffEditor),
  { ssr: false },
);

interface MonacoDiffEditorProps {
  original: string;
  modified: string;
  language?: string;
  height?: number | string;
}

export function MonacoDiffEditor({
  original,
  modified,
  language = "typescript",
  height = 420,
}: MonacoDiffEditorProps) {
  return (
    <DiffEditor
      height={height}
      language={language}
      theme="catamorphic-dark"
      original={original}
      modified={modified}
      options={{
        readOnly: true,
        renderSideBySide: true,
        renderIndicators: true,
        minimap: { enabled: false },
        fontSize: 12,
        fontFamily: '"Fira Code", "SF Mono", "JetBrains Mono", monospace',
        scrollBeyondLastLine: false,
        automaticLayout: true,
      }}
      loading={
        <div style={{ padding: 20, color: "#525252", fontSize: 13 }}>
          Loading diff...
        </div>
      }
    />
  );
}
