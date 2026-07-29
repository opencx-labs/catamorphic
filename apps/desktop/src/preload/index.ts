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
  onServerChanged: (listener: (info: ServerInfo) => void): (() => void) => {
    const handler = (_event: unknown, info: ServerInfo) => listener(info);
    ipcRenderer.on("catamorphic:server-changed", handler);
    return () =>
      ipcRenderer.removeListener("catamorphic:server-changed", handler);
  },
};

export type CatamorphicDesktopApi = typeof api;

contextBridge.exposeInMainWorld("catamorphicDesktop", api);
