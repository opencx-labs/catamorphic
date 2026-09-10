import { createContext, useContext } from "react";
export const WorkspaceContext = createContext<{
  visible: boolean;
  projectId?: string;
}>({ visible: true });
export const useWorkspace = () => useContext(WorkspaceContext);
