import { useEffect, useMemo, useRef, useState } from "react";
import type { SidebarSourceSession } from "../../shared/sidebar-source.js";
import { CHIPS_OWNER_ID } from "../../shared/workspace-config.js";
import { chipsSource } from "../sources/chips.js";
import type { SectionSource } from "../sources/contract.js";
import { moduleSource } from "../sources/module.js";
import type { Chip } from "./chips.js";

/** What the rail draws for a chat, and where its chips' actions go. */
export interface ChipsView {
  /** A flat tree: a group's members name it as their parent. */
  chips: readonly Chip[];
  source: SectionSource;
  /** The chat whose chips these are, for their source's actions. */
  session?: SidebarSourceSession;
  /** The chips module failed; its last chips stay beside a Retry. */
  failure?: { message: string; retry: () => void };
}

/**
 * A module's last chips per chat (keyed by both), so a chat shown again
 * draws them at once.
 */
const lastRead = new Map<string, readonly Chip[]>();

/** Groups inside groups go this deep (a subagent's steps in Subagents). */
const GROUP_DEPTH = 2;

/**
 * Every chip of a source, a flat tree: the roots and the members a page
 * names a parent for, and the members of any group it did not, read by
 * their group's id.
 */
export async function readChips({
  source,
  session,
  signal,
}: {
  source: SectionSource;
  session: SidebarSourceSession;
  signal: AbortSignal;
}): Promise<Chip[]> {
  const page = (await source.load({ parentId: null, session, signal })).items;
  const chips: Chip[] = page.map((chip) => ({
    ...chip,
    parentId: chip.parentId ?? null,
  }));
  let groups = chips.filter((chip) => !chip.parentId && chip.hasChildren);
  for (let depth = 0; depth < GROUP_DEPTH && groups.length; depth += 1) {
    const unread = groups.filter(
      (group) => !chips.some((chip) => chip.parentId === group.id),
    );
    const members = await Promise.all(
      unread.map(
        async (group) =>
          (await source.load({ parentId: group.id, session, signal })).items,
      ),
    );
    const found = unread.flatMap((group, index) =>
      (members[index] ?? []).map((chip) => ({ ...chip, parentId: group.id })),
    );
    chips.push(...found);
    const ids = new Set(groups.map((group) => group.id));
    groups = chips.filter(
      (chip) => chip.hasChildren && chip.parentId && ids.has(chip.parentId),
    );
  }
  return chips;
}

/**
 * A chat's chips (ADR 0238): Work's own, or what the project's chips
 * module makes of them. The module reads again when the chat's metadata
 * or Work's chips change (it reads them), and when it says its data did;
 * it pauses while the chat is out of view and keeps what it last read. A
 * module that fails before it ever read leaves Work's chips in place.
 */
export function useChips({
  projectId,
  module,
  enabled,
  session,
  defaults,
}: {
  projectId: string;
  /** The chips module's path, when the project has one and may run it. */
  module: string | undefined;
  /** The chat is in view: the module reads and follows. */
  enabled: boolean;
  session: SidebarSourceSession | undefined;
  /** Work's chips for this chat, as it publishes them. */
  defaults: readonly Chip[];
}): ChipsView {
  const work = useMemo(() => chipsSource(), []);
  const source = useMemo(
    () =>
      module
        ? moduleSource<typeof CHIPS_OWNER_ID>({
            projectId,
            ownerId: CHIPS_OWNER_ID,
            title: "Chips",
            work: {
              // It reads its chat's chips: when they change, it reads again.
              watchReads: (_owner, onRead) => {
                onRead(CHIPS_OWNER_ID);
                return () => {};
              },
              get: () => work,
            },
          })
        : null,
    [projectId, module, work],
  );
  const sessionId = session?.id;
  const sessionRef = useRef(session);
  sessionRef.current = session;
  const [reads, setReads] = useState(0);
  const [state, setState] = useState<{
    key: string;
    chips?: readonly Chip[];
    error?: string;
  }>({ key: "" });
  const key = `${sessionId ?? ""}\u0000${module ?? ""}`;
  // Its own data changed (subscribe), or Work's chips it reads did.
  useEffect(() => {
    if (!source || !sessionId || !enabled) return;
    return source.subscribe?.(() => setReads((count) => count + 1), {
      ...(sessionRef.current ? { session: sessionRef.current } : {}),
      branches: () => [null],
      branchSize: () => 0,
      fail: (error) => {
        if (error) setState((current) => ({ ...current, error }));
      },
    });
  }, [source, sessionId, enabled]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: `reads` and the chat's fields are what ask for another read
  useEffect(() => {
    const current = sessionRef.current;
    if (!source || !current || !enabled) return;
    const controller = new AbortController();
    void readChips({
      source,
      session: current,
      signal: controller.signal,
    }).then(
      (chips) => {
        if (controller.signal.aborted) return;
        lastRead.set(key, chips);
        setState({ key, chips });
      },
      (cause: unknown) => {
        if (controller.signal.aborted) return;
        setState((before) => ({
          key,
          ...(before.key === key && before.chips
            ? { chips: before.chips }
            : {}),
          error: cause instanceof Error ? cause.message : String(cause),
        }));
      },
    );
    return () => controller.abort();
  }, [source, key, reads, session, enabled]);
  if (!source || !session) return { chips: defaults, source: work, session };
  const shown = state.key === key ? state : undefined;
  const read = shown?.chips ?? lastRead.get(key);
  // Failed before it ever read: Work's chips, acted on by Work.
  const fallback = !read && Boolean(shown?.error);
  return {
    chips: read ?? (fallback ? defaults : []),
    source: fallback ? work : source,
    session,
    ...(shown?.error
      ? {
          failure: {
            message: shown.error,
            retry: () => {
              setState((current) => ({ ...current, error: undefined }));
              setReads((count) => count + 1);
            },
          },
        }
      : {}),
  };
}
