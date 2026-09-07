import { useQuery } from "@tanstack/react-query";
import { desktopApi } from "./desktop-api.js";

/** The desktop's working copy, including its permitted remote document mirror. */
export function useLocalProjectFiles(projectId: string) {
  return useQuery({
    queryKey: ["desktop", "local-files", projectId],
    queryFn: () => desktopApi.projectLocalFiles(projectId),
    refetchOnMount: "always",
  });
}

export async function localEditorPath(projectId: string, filePath: string) {
  if (filePath.startsWith("/")) return filePath;
  const root = await desktopApi.projectRoot(projectId);
  if (!root) throw new Error("The project working copy is unavailable");
  return `${root.replace(/\/+$/, "")}/${filePath}`;
}
