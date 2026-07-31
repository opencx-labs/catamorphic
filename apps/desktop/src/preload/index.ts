import { contextBridge, ipcRenderer } from "electron";

export interface ServerInfo {
  url: string | null;
  hasCodingAgent: boolean;
}

const api = {
  getServerState: (): Promise<ServerInfo> =>
    ipcRenderer.invoke("catamorphic:server-state"),
  getSettings: () => ipcRenderer.invoke("catamorphic:settings-get"),
  setSettings: (input: unknown) =>
    ipcRenderer.invoke("catamorphic:settings-set", input),
  devWindow: (action: string, width?: number, height?: number) =>
    ipcRenderer.invoke("catamorphic:dev-window", action, width, height),
  defaultProjectsDir: (): Promise<string> =>
    ipcRenderer.invoke("catamorphic:default-projects-dir"),
  pickFolder: (opts?: {
    title?: string;
    defaultPath?: string;
  }): Promise<string | null> =>
    ipcRenderer.invoke("catamorphic:pick-folder", opts),
  createProject: (input: {
    name: string;
    rootPath: string;
    templateId?: string;
    importExisting?: boolean;
  }): Promise<{ id: string; name: string }> =>
    ipcRenderer.invoke("catamorphic:project-create", input),
  deleteProject: (input: {
    projectId: string;
    trashFolder?: boolean;
  }): Promise<void> => ipcRenderer.invoke("catamorphic:project-delete", input),
  projectRoot: (projectId: string): Promise<string | null> =>
    ipcRenderer.invoke("catamorphic:project-root", projectId),
  revealFolder: (folderPath: string): Promise<void> =>
    ipcRenderer.invoke("catamorphic:reveal-folder", folderPath),
  onServerChanged: (listener: (info: ServerInfo) => void): (() => void) => {
    const handler = (_event: unknown, info: ServerInfo) => listener(info);
    ipcRenderer.on("catamorphic:server-changed", handler);
    return () =>
      ipcRenderer.removeListener("catamorphic:server-changed", handler);
  },
};

export type CatamorphicDesktopApi = typeof api;

contextBridge.exposeInMainWorld("catamorphicDesktop", api);
