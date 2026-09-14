import type { AgentSession } from "@catamorphic/react";
import { createContext, useContext } from "react";
export const WorkspaceContext = createContext<{
  visible: boolean;
  projectId?: string;
  attention?: AgentSession[];
}>({ visible: true });
export const useWorkspace = () => useContext(WorkspaceContext);
