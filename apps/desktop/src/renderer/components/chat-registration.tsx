import { useEffect, useLayoutEffect, useRef } from "react";
import type { ChatDockProps } from "../../shared/chat.js";
import type { ChatEvent, DockData } from "../../shared/desktop-workspace.js";
import { localPresentations } from "../lib/chat-presentations.js";
import { desktopApi } from "../lib/desktop-api.js";
import { useTheme } from "../lib/theme.js";
import { useWorkspace } from "../lib/workspace-context.js";

/** A project publishes presentation and receives explicitly addressed commands. */
export function ChatRegistration(
  props: ChatDockProps & {
    selected: boolean;
    onReveal: () => void;
    projectName: string;
    icon: string | null;
    fork: boolean;
    unread: boolean;
    attention: boolean;
    menu: DockData["menu"];
    onMenuAction: (entry: DockData["menu"][number]) => void;
  },
) {
  const current = useRef(props);
  current.current = props;
  const theme = useTheme();
  const workspace = useWorkspace();
  const last = useRef("");
  const {
    projectId,
    entry: { localId },
  } = props;
  useLayoutEffect(() => {
    const data: DockData = {
      selected: props.selected,
      projectId,
      entry: props.entry,
      title: props.title,
      projectName: props.projectName,
      icon: props.icon,
      fork: props.fork,
      unread: props.unread,
      attention: props.attention,
      menu: props.menu,
      archived: props.archived,
      inspectRequestNonce: props.inspectRequestNonce,
      runtimeSettingsError: props.runtimeSettingsError,
      theme,
      visible: workspace.visible,
      tabActive: props.tabActive,
      refreshWhileIdle: props.refreshWhileIdle,
      slot: props.slot,
      splitRatio: props.splitRatio,
      splitResizing: props.splitResizing,
      bubbleClearance: props.bubbleClearance,
      backdropTab: props.backdropTab,
      defaultAgentId: props.defaultAgentId,
      paletteTargeted: props.paletteTargeted,
      surfaces: props.surfaces,
      pullSelectionNonce: props.pullSelectionNonce,
    };
    const serialized = JSON.stringify(data);
    if (last.current === serialized) return;
    last.current = serialized;
    localPresentations.publish(data);
    void desktopApi.dockPublish(data);
  });
  useEffect(() => {
    const send = (action: "close" | "minimize" | "send", message?: string) => {
      void desktopApi.dockAction(localId, action, message);
    };
    current.current.registerClose?.(() => {
      current.current.onCloseStarted?.();
      send("close");
    });
    current.current.registerMinimize?.(() => send("minimize"));
    current.current.registerSend?.((message) => send("send", message));
    const invoke = (event: ChatEvent) => {
      const p = current.current;
      switch (event.kind) {
        case "reveal":
          p.onReveal();
          break;
        case "entry":
          p.onEntryChange(event.entry);
          break;
        case "close":
          p.onClose(localId);
          break;
        case "closing":
          p.onCloseStarted?.();
          break;
        case "session":
          p.onSessionCreated(localId, event.sessionId);
          break;
        case "signals":
          p.onSignalsChange(localId, event.signals);
          break;
        case "surface":
          p.onOpenSurface?.(event.key, event.mode);
          break;
        case "removeSurface":
          p.onRemoveSurface?.(event.key);
          break;
        case "mcpApp":
          p.onOpenMcpApp?.(event.view, event.mode);
          break;
        case "link":
          p.onLinkClick?.(event.url, event.modifiers);
          break;
        case "file":
          p.onFileClick?.(event.path, event.modifiers);
          break;
        case "menu":
          p.onMenuAction(event.entry);
          break;
        case "archive":
          p.onArchive?.();
          break;
        case "forkCurrent":
          p.onForkCurrent?.();
          break;
        case "editModel":
          p.onEditModel?.();
          break;
        case "editEffort":
          p.onEditEffort?.();
          break;
        case "fork":
          p.onFork?.(event.messageId);
          break;
        case "parent":
          p.onOpenParent?.();
          break;
        case "focus":
          p.onFocusRequest?.();
          break;
        case "unsplit":
          p.onUnsplit?.();
          break;
        case "escape":
          p.onEscapeToFloating?.(localId);
          break;
      }
    };
    localPresentations.handle(localId, invoke);
    const stop = desktopApi.onWorkspaceEvent((event) => {
      if (
        event.kind === "chat" &&
        event.command.projectId === projectId &&
        event.command.localId === localId
      )
        invoke(event.command.event);
    });
    return () => {
      stop();
      localPresentations.remove(localId);
      last.current = "";
      void desktopApi.dockRemove(projectId, localId);
    };
  }, [projectId, localId]);
  return null;
}
