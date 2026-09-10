import { GripVertical } from "lucide-react";
import {
  type CSSProperties,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import type { ChatSignals } from "../../shared/chat.js";
import type {
  ChatEvent,
  DockData,
  DockSnapshot,
} from "../../shared/desktop-workspace.js";
import { localPresentations } from "../lib/chat-presentations.js";
import { desktopApi } from "../lib/desktop-api.js";
import { matchesBinding, useKeybindings } from "../lib/keybindings.js";
import {
  applyTheme,
  ThemeScope,
  themeStyle,
  useProjectTheme,
} from "../lib/theme.js";
import { ChatBubbles } from "./chat-bubbles.js";
import { ChatDock } from "./chat-dock.js";
import { DockDialogs } from "./dock-dialogs.js";
import { ShortcutHint } from "./shortcut-hint.js";

const EMPTY: DockSnapshot = {
  chats: [],
  detached: false,
  multiProject: false,
  side: "right",
};

/** One presentation vocabulary, mounted in a workspace or in the native dock. */
export function DockHost({
  activeProjectId,
  detachedWindow = false,
}: {
  activeProjectId?: string;
  detachedWindow?: boolean;
}) {
  const keybindings = useKeybindings();
  const [remoteSnapshot, setSnapshot] = useState(EMPTY);
  const local = useSyncExternalStore(
    localPresentations.subscribe,
    localPresentations.getSnapshot,
  );
  const snapshot = {
    ...remoteSnapshot,
    chats: [
      ...remoteSnapshot.chats.filter((chat) => !chat.local),
      ...local.chats,
    ],
    activeChatId: local.pendingActivation ?? remoteSnapshot.activeChatId,
  };
  useEffect(
    () => localPresentations.acknowledge(remoteSnapshot.activeChatId),
    [remoteSnapshot.activeChatId],
  );
  const [signals, setSignals] = useState<Record<string, ChatSignals>>({});
  const dragStart = useRef<{ x: number; middle: number } | null>(null);
  const [dragOffset, setDragOffset] = useState(0);
  const [collapsed, setCollapsed] = useState(false);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [region, setRegion] = useState<CSSProperties>({ inset: 0 });
  const actions = useRef(
    new Map<
      string,
      {
        close?: () => void;
        minimize?: () => void;
        send?: (message: string) => void;
      }
    >(),
  );
  const showing = useRef(new Set<string>());
  const currentProjectId = activeProjectId ?? snapshot.activeProjectId;
  const currentTheme = useProjectTheme(currentProjectId);
  useEffect(() => {
    if (currentTheme) applyTheme(currentTheme);
  }, [currentTheme]);
  const isPresentation = detachedWindow
    ? snapshot.detached
    : !snapshot.detached;
  useEffect(() => {
    void desktopApi.dockSnapshot().then(setSnapshot);
    return desktopApi.onDockSnapshot(setSnapshot);
  }, []);
  useLayoutEffect(() => {
    if (detachedWindow || !activeProjectId) return;
    const target = document.querySelector(
      `[data-project-runtime="${CSS.escape(activeProjectId)}"] [data-workspace-chat-region]`,
    );
    if (!(target instanceof HTMLElement)) return;
    const measure = () => {
      const bounds = target.getBoundingClientRect();
      setRegion((previous) =>
        previous.left === bounds.left &&
        previous.top === bounds.top &&
        previous.width === bounds.width &&
        previous.height === bounds.height
          ? previous
          : {
              left: bounds.left,
              top: bounds.top,
              width: bounds.width,
              height: bounds.height,
            },
      );
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(target);
    window.addEventListener("resize", measure);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", measure);
    };
  }, [activeProjectId, detachedWindow]);
  useEffect(
    () =>
      desktopApi.onWorkspaceEvent((event) => {
        if (event.kind !== "dockAction" || !showing.current.has(event.localId))
          return;
        const action = actions.current.get(event.localId);
        if (event.action === "send" && event.message)
          action?.send?.(event.message);
        else if (event.action === "close") action?.close?.();
        else if (event.action === "minimize") action?.minimize?.();
      }),
    [],
  );
  const scoped = snapshot.chats.filter(
    (chat) => snapshot.multiProject || chat.projectId === currentProjectId,
  );
  const active =
    scoped.find((chat) => chat.entry.localId === snapshot.activeChatId) ??
    (!snapshot.multiProject
      ? scoped.find((chat) => chat.selected && chat.entry.mode === "partial")
      : undefined);
  const tabbed = snapshot.chats.find(
    (chat) =>
      chat.projectId === currentProjectId &&
      chat.entry.mode === "tab" &&
      chat.tabActive,
  );
  const expanded = isPresentation && active && active.entry.mode === "partial";
  const railWidth = collapsed
    ? 100
    : Math.min(
        780,
        scoped.filter((chat) => chat.entry.mode !== "tab").length * 42 + 132,
      );
  useEffect(() => {
    if (detachedWindow)
      void desktopApi.dockResize({
        width: expanded || dialogOpen ? 780 : railWidth,
        height: expanded || dialogOpen ? 560 : 76,
      });
  }, [detachedWindow, expanded, dialogOpen, railWidth]);

  const invoke = (chat: DockData, event: ChatEvent) => {
    if (chat.local) {
      if (
        ["surface", "mcpApp", "link", "file", "focus", "unsplit"].includes(
          event.kind,
        ) ||
        (event.kind === "entry" && event.entry.mode === "tab")
      )
        void desktopApi.workspaceNavigate(chat.projectId);
      if (localPresentations.invoke(chat.entry.localId, event)) return;
    }
    void desktopApi.dockCommand({
      projectId: chat.projectId,
      localId: chat.entry.localId,
      event,
    });
  };
  const toggle = (id: string) => {
    const chat = snapshot.chats.find((item) => item.entry.localId === id);
    if (!chat) return;
    if (active?.entry.localId === id && chat.entry.mode === "partial") {
      actions.current.get(id)?.minimize?.();
      return;
    }
    void desktopApi.dockActivate(id);
    invoke(chat, { kind: "reveal" });
  };
  const lastActive = useRef<string | undefined>(undefined);
  if (active) lastActive.current = active.entry.localId;
  const keyboard = useRef<(event: KeyboardEvent) => void>(() => {});
  keyboard.current = (event) => {
    if (!isPresentation || event.defaultPrevented) return;
    const chat =
      active ??
      scoped.find((chat) => chat.entry.localId === lastActive.current);
    const foreign =
      detachedWindow || (chat && chat.projectId !== currentProjectId);
    if (snapshot.multiProject || detachedWindow) {
      const direction = matchesBinding(event, keybindings["next-chat"])
        ? 1
        : matchesBinding(event, keybindings["prev-chat"])
          ? -1
          : 0;
      if (direction) {
        event.preventDefault();
        event.stopImmediatePropagation();
        const entries = scoped.filter((chat) => chat.entry.mode !== "tab");
        const index = entries.findIndex(
          (item) => item.entry.localId === chat?.entry.localId,
        );
        const next =
          entries[
            (Math.max(index, 0) + direction + entries.length) % entries.length
          ];
        if (next && (next !== active || next.entry.mode !== "partial"))
          toggle(next.entry.localId);
        return;
      }
    }
    if (!foreign) return;
    if (matchesBinding(event, keybindings["new-floating-chat"])) {
      event.preventDefault();
      event.stopImmediatePropagation();
      void desktopApi.dockNewChat();
      return;
    }
    if (!chat) return;
    if (matchesBinding(event, keybindings["toggle-chat-minimized"])) {
      event.preventDefault();
      event.stopImmediatePropagation();
      toggle(chat.entry.localId);
    } else if (matchesBinding(event, keybindings["chat-to-tab"])) {
      event.preventDefault();
      event.stopImmediatePropagation();
      invoke(chat, { kind: "entry", entry: { ...chat.entry, mode: "tab" } });
    } else if (
      matchesBinding(event, keybindings["close-tab"]) &&
      document.activeElement?.closest("[data-dock-host]")
    ) {
      event.preventDefault();
      event.stopImmediatePropagation();
      actions.current.get(chat.entry.localId)?.close?.();
    }
  };
  useEffect(() => {
    const handle = (event: KeyboardEvent) => keyboard.current(event);
    window.addEventListener("keydown", handle, true);
    return () => window.removeEventListener("keydown", handle, true);
  }, []);
  const closeFromMenu = useRef(() => {});
  closeFromMenu.current = () => {
    if (
      !isPresentation ||
      !active ||
      (!detachedWindow && active.projectId === currentProjectId)
    )
      return;
    if (detachedWindow || document.activeElement?.closest("[data-dock-host]"))
      actions.current.get(active.entry.localId)?.close?.();
  };
  useEffect(() => desktopApi.onCloseSurface(() => closeFromMenu.current()), []);
  showing.current = new Set();
  return (
    <div
      data-dock-host
      data-dock-native={detachedWindow || undefined}
      data-dock-side={snapshot.side}
      className={`pointer-events-none absolute ${detachedWindow ? "inset-0" : ""}`}
      style={{ ...themeStyle(currentTheme), ...(detachedWindow ? {} : region) }}
    >
      {detachedWindow && <DockDialogs onOpenChange={setDialogOpen} />}
      {snapshot.chats.map((chat) => {
        const isTab =
          !detachedWindow &&
          chat.projectId === currentProjectId &&
          chat.entry.mode === "tab";
        const visible =
          (isTab && chat.tabActive) ||
          (isPresentation && chat === active && chat.entry.mode === "partial");
        // The owning workspace keeps a headless/minimized surface mounted for
        // signals and queued sends; other projects are ordinary session subscribers.
        const entry = {
          ...chat.entry,
          mode: visible
            ? isTab
              ? ("tab" as const)
              : ("partial" as const)
            : ("min" as const),
          pendingMessage:
            detachedWindow || !chat.local
              ? undefined
              : chat.entry.pendingMessage,
        };
        if (visible) showing.current.add(entry.localId);
        const register = (patch: {
          close?: () => void;
          minimize?: () => void;
          send?: (message: string) => void;
        }) =>
          actions.current.set(entry.localId, {
            ...actions.current.get(entry.localId),
            ...patch,
          });
        return (
          <ThemeScope key={entry.localId} theme={chat.theme}>
            <div
              className="absolute inset-0 pointer-events-none"
              data-theme={chat.theme?.appearance}
              style={{
                ...themeStyle(chat.theme),
                transform: isTab ? undefined : `translateX(${dragOffset}px)`,
              }}
            >
              <ChatDock
                {...chat}
                entry={entry}
                refreshWhileIdle={visible}
                tabActive={isTab && chat.tabActive}
                bubbleClearance={collapsed ? "corner" : "strip"}
                backdropTab={!detachedWindow && chat.backdropTab}
                onEntryChange={(next) => {
                  invoke(chat, {
                    kind: "entry",
                    entry: {
                      ...next,
                      pendingMessage:
                        chat.local && !detachedWindow
                          ? next.pendingMessage
                          : chat.entry.pendingMessage,
                    },
                  });
                }}
                onClose={() => invoke(chat, { kind: "close" })}
                onCloseStarted={() => invoke(chat, { kind: "closing" })}
                onSessionCreated={(_id, sessionId) =>
                  invoke(chat, { kind: "session", sessionId })
                }
                onSignalsChange={(_id, next) => {
                  setSignals((old) =>
                    JSON.stringify(old[entry.localId]) === JSON.stringify(next)
                      ? old
                      : { ...old, [entry.localId]: next },
                  );
                  if (chat.local && !detachedWindow)
                    invoke(chat, { kind: "signals", signals: next });
                }}
                onOpenSurface={(key, mode) =>
                  invoke(chat, { kind: "surface", key, mode })
                }
                onRemoveSurface={(key) =>
                  invoke(chat, { kind: "removeSurface", key })
                }
                onOpenMcpApp={(view, mode) =>
                  invoke(chat, { kind: "mcpApp", view, mode })
                }
                onLinkClick={(url, modifiers) =>
                  invoke(chat, { kind: "link", url, modifiers })
                }
                onFileClick={(path, modifiers) =>
                  invoke(chat, { kind: "file", path, modifiers })
                }
                onFork={(messageId) =>
                  invoke(chat, { kind: "fork", messageId })
                }
                onForkCurrent={() => invoke(chat, { kind: "forkCurrent" })}
                onArchive={() => invoke(chat, { kind: "archive" })}
                onEditModel={() => invoke(chat, { kind: "editModel" })}
                onEditEffort={() => invoke(chat, { kind: "editEffort" })}
                onOpenParent={
                  chat.fork ? () => invoke(chat, { kind: "parent" }) : undefined
                }
                onFocusRequest={
                  isTab ? () => invoke(chat, { kind: "focus" }) : undefined
                }
                onUnsplit={
                  isTab && chat.slot !== "full"
                    ? () => invoke(chat, { kind: "unsplit" })
                    : undefined
                }
                onEscapeToFloating={() => invoke(chat, { kind: "escape" })}
                registerClose={(close) => register({ close })}
                registerMinimize={(minimize) => register({ minimize })}
                registerSend={(send) => register({ send })}
              />
            </div>
          </ThemeScope>
        );
      })}
      {isPresentation && (currentProjectId || scoped.length > 0) && (
        <>
          <ChatBubbles
            attention={Object.fromEntries(
              scoped.map((chat) => [chat.entry.localId, chat.attention]),
            )}
            menus={Object.fromEntries(
              scoped.map((chat) => [chat.entry.localId, chat.menu]),
            )}
            onMenuAction={(id, entry) => {
              const chat = scoped.find((chat) => chat.entry.localId === id);
              if (chat) invoke(chat, { kind: "menu", entry });
            }}
            dragOffset={dragOffset}
            newChatProjectName={
              snapshot.chats.find((chat) => chat.projectId === currentProjectId)
                ?.projectName
            }
            entries={scoped.map((chat) => chat.entry)}
            labels={Object.fromEntries(
              scoped.map((chat) => [
                chat.entry.localId,
                `${chat.title} · ${chat.projectName}`,
              ]),
            )}
            icons={Object.fromEntries(
              scoped.map((chat) => [chat.entry.localId, chat.icon]),
            )}
            forks={Object.fromEntries(
              scoped.map((chat) => [chat.entry.localId, chat.fork]),
            )}
            signals={signals}
            unread={Object.fromEntries(
              scoped.map((chat) => [chat.entry.localId, chat.unread]),
            )}
            themes={Object.fromEntries(
              scoped.map((chat) => [
                chat.entry.localId,
                themeStyle(chat.theme),
              ]),
            )}
            side={snapshot.side}
            activeLocalId={active?.entry.localId}
            autoCollapse={Boolean(tabbed)}
            onCollapsedChange={setCollapsed}
            onToggle={toggle}
            onClose={(id) => actions.current.get(id)?.close?.()}
            onNewChat={() => {
              void desktopApi.dockNewChat();
            }}
            onCollapse={() => {
              if (active)
                actions.current.get(active.entry.localId)?.minimize?.();
            }}
          />
          <ShortcutHint label="Drag dock to either edge">
            <button
              type="button"
              aria-label="Move chat dock"
              className={`pointer-events-auto absolute bottom-5 z-50 grid size-6 cursor-grab place-items-center rounded text-fg-faint hover:text-fg ${snapshot.side === "left" ? "left-0" : "right-0"}`}
              data-native-drag={detachedWindow || undefined}
              style={{ transform: `translateX(${dragOffset}px)` }}
              onPointerDown={(event) => {
                if (detachedWindow) return;
                const bounds = event.currentTarget
                  .closest("[data-dock-host]")
                  ?.getBoundingClientRect();
                dragStart.current = {
                  x: event.clientX,
                  middle: bounds
                    ? bounds.left + bounds.width / 2
                    : innerWidth / 2,
                };
                event.currentTarget.setPointerCapture(event.pointerId);
              }}
              onPointerMove={(event) => {
                if (
                  dragStart.current &&
                  event.currentTarget.hasPointerCapture(event.pointerId)
                )
                  setDragOffset(event.clientX - dragStart.current.x);
              }}
              onPointerCancel={() => {
                dragStart.current = null;
                setDragOffset(0);
              }}
              onPointerUp={(event) => {
                const start = dragStart.current;
                if (
                  detachedWindow ||
                  !start ||
                  !event.currentTarget.hasPointerCapture(event.pointerId)
                )
                  return;
                event.currentTarget.releasePointerCapture(event.pointerId);
                dragStart.current = null;
                const side = event.clientX < start.middle ? "left" : "right";
                void desktopApi.setPrefs({ dockSide: side }).then(() => {
                  setSnapshot((snapshot) => ({ ...snapshot, side }));
                  setDragOffset(0);
                });
              }}
              onKeyDown={(event) => {
                if (event.key !== "ArrowLeft" && event.key !== "ArrowRight")
                  return;
                event.preventDefault();
                void desktopApi.setPrefs({
                  dockSide: event.key === "ArrowLeft" ? "left" : "right",
                });
              }}
            >
              <GripVertical className="size-3.5" />
            </button>
          </ShortcutHint>
        </>
      )}
    </div>
  );
}
