import type { AgentSession } from "@catamorphic/react";
import { createContext, useContext } from "react";
import type { WorkspaceNavigation } from "../../shared/desktop-workspace.js";
export const WorkspaceContext = createContext<{
  navigation?: WorkspaceNavigation["surface"];
  visible: boolean;
  projectId?: string;
  attention?: AgentSession[];
}>({ visible: true });
export const useWorkspace = () => useContext(WorkspaceContext);
