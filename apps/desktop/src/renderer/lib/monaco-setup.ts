import { loader } from "@monaco-editor/react";
import * as monaco from "monaco-editor";
import editorWorker from "monaco-editor/editor/editor.worker?worker";
import tsWorker from "monaco-editor/language/typescript/ts.worker?worker";

/**
 * Self-host Monaco: the packaged app has no network and the CSP blocks
 * the default CDN loader.
 *
 * Imported ONLY from the screens that actually render an editor (editor
 * tabs, workflow surfaces), which are themselves lazy-loaded — monaco is
 * ~half of the renderer bundle, and pulling it into the startup chunk
 * cost every launch a multi-hundred-ms parse for a feature many
 * sessions never open.
 */
self.MonacoEnvironment = {
  getWorker: (_workerId: string, label: string) =>
    label === "typescript" || label === "javascript"
      ? new tsWorker()
      : new editorWorker(),
};
loader.config({ monaco });
