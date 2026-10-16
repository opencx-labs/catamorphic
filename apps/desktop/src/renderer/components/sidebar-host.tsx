import type { AgentSession } from "@catamorphic/react/types";
import { createContext, type ReactNode, useContext } from "react";
import type { ChatSessionAction } from "../../shared/chat-session-actions.js";
import type { AgentsData } from "../lib/desktop-api.js";
import type { TabDragPayload } from "../lib/tab-drag.js";
import type { SessionCommand } from "./sidebar-session-inspector.js";

/**
 * What the window lends every section's rows (ADR 0234): what Work knows
 * about the targets rows name (a chat's agent and commands), and which of
 * its commands are on offer here. Rows get it by their address, never by
 * which source wrote them.
 */
export interface SidebarHost {
  projectId: string;
  agentsData: AgentsData | null;
  defaultAgentId: string | null;
  projectAgentNames: Record<string, string>;
  onSessionCommand: (session: AgentSession, command: SessionCommand) => void;
  onSessionAction: (sessionId: string, action: ChatSessionAction) => void;
  /** False for a command not on offer here (the palette's rule). */
  commandAvailable: (id: string) => boolean;
  /**
   * The open tab an address is, if it is one, as the tab strip drags it: a
   * row standing for a tab drags and drops exactly like the tab.
   */
  openTab: (url: string) => TabDragPayload | undefined;
  /** A row standing for a tab is being dragged (null when it ends). */
  onTabDrag: (key: string | null) => void;
}

const Context = createContext<SidebarHost | null>(null);

export function SidebarHostProvider({
  value,
  children,
}: {
  value: SidebarHost;
  children: ReactNode;
}) {
  return <Context.Provider value={value}>{children}</Context.Provider>;
}

export function useSidebarHost() {
  return useContext(Context);
}
