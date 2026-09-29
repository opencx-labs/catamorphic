import { useEffect, useRef } from "react";
import {
  type HistoryProject,
  type HistoryVisit,
  historyIdentity,
} from "../../shared/history.js";
import {
  PALETTE_SURFACE_KINDS,
  surfaceUsageKey,
} from "../../shared/palette.js";
import {
  parseSurfaceLink,
  resolveProjectFileLocation,
} from "../../shared/surface-link.js";
import { tabKey } from "../components/workspace-tabs.js";
import { desktopApi } from "./desktop-api.js";
import {
  browserTabKey,
  chatTabKey,
  editorTabKey,
  type Workspace,
} from "./workspace-state.js";

export const fileNameFromPath = (filePath: string) =>
  filePath.split(/[\\/]/).at(-1) || filePath;

/**
 * What comes to the front is a visit. History (ADR 0154) records pages,
 * project files, chats, apps, workflows, runs and artifacts; palette usage
 * (ADR 0186) counts the app's own surfaces (Settings, Usage, Sites, ...),
 * however they were opened. Incognito chats never reach either.
 */
export function useVisitRecording({
  visible,
  ready,
  workspace,
  focusedChat,
  projectId,
  projects,
  projectRoot,
  sessionsById,
  appMetadata,
}: {
  visible: boolean;
  ready: boolean;
  workspace: Workspace;
  focusedChat: Workspace["chats"][number] | undefined;
  projectId: string | undefined;
  projects: ReadonlyArray<{ id: string; name: string }>;
  projectRoot: string | null;
  sessionsById: ReadonlyMap<string, { title?: string | null }>;
  appMetadata: ReadonlyMap<string, { title?: string | null }>;
}) {
  // Surfaces the palette offers count a visit whenever they come to the
  // front, however they were opened (ADR 0186).
  const lastSurfaceVisit = useRef<string | null>(null);
  const frontTabKey = workspace.floatingKey ?? workspace.activeTabKey;
  const frontSurface = workspace.tabs.find(
    (item) => tabKey(item) === frontTabKey,
  )?.kind;
  useEffect(() => {
    const kind = PALETTE_SURFACE_KINDS.find((item) => item === frontSurface);
    const visit = visible && ready && kind ? `${frontTabKey}` : null;
    if (visit === lastSurfaceVisit.current) return;
    lastSurfaceVisit.current = visit;
    if (visit && kind)
      void desktopApi
        .paletteRecord({
          key: surfaceUsageKey(kind),
          visit: true,
          ...(projectId ? { projectId } : {}),
        })
        .catch(() => {});
  }, [visible, ready, frontTabKey, frontSurface, projectId]);
  const lastHistoryVisit = useRef<HistoryVisit | null>(null);
  useEffect(() => {
    if (!visible || !ready) {
      lastHistoryVisit.current = null;
      return;
    }
    const projectName = projectId
      ? projects.find((item) => item.id === projectId)?.name
      : undefined;
    // The project list is still loading: this visit records once it lands.
    if (projectId && projectName === undefined) return;
    const project: HistoryProject | undefined =
      projectId && projectName !== undefined
        ? { id: projectId, name: projectName }
        : undefined;
    const key =
      workspace.floatingKey ??
      (focusedChat?.mode === "partial"
        ? chatTabKey(focusedChat.localId)
        : workspace.activeTabKey);
    const tab = workspace.tabs.find((item) => tabKey(item) === key);
    const editor = workspace.editors.find(
      (item) => editorTabKey(item.localId) === key,
    );
    const chat = workspace.chats.find(
      (item) => chatTabKey(item.localId) === key,
    );
    const browser = workspace.browsers.find(
      (item) => browserTabKey(item.localId) === key,
    );
    const browserUrl = browser?.url || browser?.initialUrl;
    const fileSurface = browserUrl?.startsWith("file://")
      ? parseSurfaceLink(browserUrl)
      : null;
    // A file:// tab is one of the project's files when it lives under
    // the project root; anything else is a file on this machine. Until
    // the root is known the tab waits rather than recording as loose.
    if (fileSurface?.kind === "file" && project && !projectRoot) return;
    const fileLocation =
      fileSurface?.kind === "file" && project && projectRoot
        ? resolveProjectFileLocation(projectRoot, fileSurface.path)
        : null;
    const visit: HistoryVisit | null =
      fileSurface?.kind === "file"
        ? {
            target:
              project &&
              fileLocation &&
              fileLocation.relativePath !== fileLocation.absolutePath
                ? {
                    kind: "file",
                    projectId: project.id,
                    resource: fileLocation.relativePath,
                  }
                : { kind: "local", path: fileSurface.path },
            title: browser?.title || fileNameFromPath(fileSurface.path),
            project,
          }
        : !project
          ? null
          : editor?.filePath
            ? {
                target: {
                  kind: "file",
                  projectId: project.id,
                  resource: editor.filePath,
                },
                title: fileNameFromPath(editor.filePath),
                project,
              }
            : chat?.sessionId && !chat.incognito
              ? {
                  target: {
                    kind: "chat",
                    projectId: project.id,
                    resource: chat.sessionId,
                  },
                  title: sessionsById.get(chat.sessionId)?.title ?? "Chat",
                  project,
                }
              : tab &&
                  (tab.kind === "app" ||
                    tab.kind === "workflow" ||
                    tab.kind === "run" ||
                    tab.kind === "artifact")
                ? {
                    target: {
                      kind: tab.kind,
                      projectId: project.id,
                      resource: tab.name,
                    },
                    title:
                      (tab.kind === "app"
                        ? appMetadata.get(tab.name)?.title
                        : null) ??
                      tab.label ??
                      tab.name,
                    project,
                  }
                : null;
    if (!visit) {
      lastHistoryVisit.current = null;
      return;
    }
    const previous = lastHistoryVisit.current;
    const revisit =
      !previous ||
      historyIdentity(previous.target) !== historyIdentity(visit.target);
    if (
      !revisit &&
      previous?.title === visit.title &&
      previous.project?.name === visit.project?.name
    )
      return;
    lastHistoryVisit.current = visit;
    if (visit.target.kind === "chat") {
      void desktopApi
        .sessionIsIncognito(visit.target.resource)
        .then((incognito) => {
          if (!incognito) return desktopApi.historyRecord({ visit, revisit });
        })
        .catch(() => {});
    } else void desktopApi.historyRecord({ visit, revisit }).catch(() => {});
  }, [
    visible,
    projectId,
    projectRoot,
    ready,
    workspace,
    focusedChat,
    projects,
    sessionsById,
    appMetadata,
  ]);
}
