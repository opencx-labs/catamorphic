import { lazy, Suspense, useRef } from "react";
import { personInputCount } from "../lib/app-focus.js";
import type { EditorScreenProps } from "../screens/editor-screen.js";

const EditorScreen = lazy(() =>
  import("../screens/editor-screen.js").then((module) => ({
    default: module.EditorScreen,
  })),
);

/** The opening intent commits before either lazy editor module can suspend. */
export function EditorPane(props: Omit<EditorScreenProps, "autofocusSince">) {
  const { projectId, filePath, line, column, navigation } = props;
  const intent = useRef({
    projectId,
    filePath,
    line,
    column,
    navigation,
    inputs: personInputCount(),
  });
  if (
    intent.current.projectId !== projectId ||
    intent.current.filePath !== filePath ||
    intent.current.line !== line ||
    intent.current.column !== column ||
    intent.current.navigation !== navigation
  ) {
    intent.current = {
      projectId,
      filePath,
      line,
      column,
      navigation,
      inputs: personInputCount(),
    };
  }
  return (
    <Suspense fallback={<div className="flex-1 bg-bg" />}>
      <EditorScreen {...props} autofocusSince={intent.current.inputs} />
    </Suspense>
  );
}
