import {
  SESSION_CHIP_ID_PATTERN,
  type SessionPullRequest,
  type SessionPullRequestState,
  sessionChips,
} from "@catamorphic/agent-protocol";
import type { PullRequestStatus } from "../../shared/pr-details.js";
import type {
  SidebarBadge,
  SidebarMenuEntry,
  SidebarPreviewMetadata,
  SidebarTone,
} from "../../shared/sidebar.js";
import type { SidebarSourceItem } from "../../shared/sidebar-source.js";
import { sanitizeSidebarSourceItem } from "../../shared/source-rows.js";

/**
 * A chip is a row (ADR 0239): what a source returns, drawn above a chat's
 * composer. Work's own chips and a module's are the same shape, so a module
 * passes Work's through and adds its own.
 */
export type Chip = SidebarSourceItem;

/** Past this many chips of one kind, Work folds them into one group chip. */
export const CHIP_GROUP_THRESHOLD = 3;

/** The kinds Work groups, with the group chip's words and icon. */
const GROUPS: Partial<Record<string, { label: string; icon: string }>> = {
  browser: { label: "Pages", icon: "Globe" },
  terminal: { label: "Terminals", icon: "SquareTerminal" },
  editor: { label: "Files", icon: "FileCode" },
  chat: { label: "Chats", icon: "GitFork" },
  subagent: { label: "Subagents", icon: "Bot" },
  app: { label: "Apps", icon: "LayoutGrid" },
  workflow: { label: "Workflows", icon: "Workflow" },
  mcpapp: { label: "App views", icon: "AppWindow" },
};

/**
 * The ✕ every removable chip of Work's carries: its source takes the chip
 * away (closes its tab, or forgets what the chat recorded).
 */
export const REMOVE_CHIP: SidebarMenuEntry = {
  label: "Remove from chat",
  action: "remove",
  icon: "X",
};

/** The same ✕ on a chip that is a tab of the chat's: it closes the tab. */
export const CLOSE_CHIP: SidebarMenuEntry = {
  label: "Close",
  action: "remove",
  icon: "X",
};

/** Work's verb, drawn as the open-to-the-side button. */
export const OPEN_SIDE_CHIP: SidebarMenuEntry = {
  label: "Open to the side",
  action: "open-side",
  icon: "Columns2",
};

/**
 * A page's favicon as a chip's icon, when it is an image (a page without
 * one reports `data:,`); the globe otherwise.
 */
export const pageIcon = (faviconUrl: string | null | undefined): string =>
  faviconUrl && /^(https?:|data:image\/)/i.test(faviconUrl)
    ? faviconUrl
    : "Globe";

/** The kind a chip says it is in `data.kind`, if it says. */
export function chipKind(chip: Chip): string | undefined {
  const kind = chip.data?.kind;
  return typeof kind === "string" ? kind : undefined;
}

/** How each pull request state looks, on a chip and in a sidebar row. */
export const PULL_REQUEST_LOOKS: Record<
  SessionPullRequestState,
  { icon: string; tone?: SidebarTone; label: string }
> = {
  open: { icon: "GitPullRequest", tone: "success", label: "Open" },
  draft: { icon: "GitPullRequestDraft", label: "Draft" },
  merged: { icon: "GitMerge", tone: "info", label: "Merged" },
  closed: { icon: "GitPullRequestClosed", tone: "danger", label: "Closed" },
};

/** Where a pull request lives: `owner/name` on a forge, else the host. */
export function repositoryOf(url: string): string {
  try {
    const { host, pathname } = new URL(url);
    const [owner, name] = pathname.split("/").filter(Boolean);
    return owner && name ? `${owner}/${name}` : host;
  } catch {
    return url;
  }
}

const count = (value: number) => value.toLocaleString("en-US");

/** A pull request's number as its address says it (`…/pull/12`). */
function numberInAddress(url: string): number | undefined {
  const match = /\/pull\/(\d+)(?:[/?#]|$)/.exec(url);
  const number = Number(match?.[1]);
  return Number.isSafeInteger(number) && number > 0 ? number : undefined;
}

const plural = (value: number, word: string) =>
  `${count(value)} ${word}${value === 1 ? "" : "s"}`;

function checksBadge(checks: NonNullable<PullRequestStatus["checks"]>) {
  return checks.state === "failure"
    ? { label: "Checks", icon: "CircleX", tone: "danger" as const }
    : checks.state === "pending"
      ? { label: "Checks", icon: "CircleDashed", tone: "warning" as const }
      : { label: "Checks", icon: "CircleCheck", tone: "success" as const };
}

function checksSummary(checks: NonNullable<PullRequestStatus["checks"]>) {
  return [
    checks.failed ? `${count(checks.failed)} failing` : "",
    checks.pending ? `${count(checks.pending)} running` : "",
    checks.passed ? `${count(checks.passed)} passed` : "",
  ]
    .filter(Boolean)
    .join(", ");
}

/**
 * A pull request the chat recorded (`pull_requests`, ADR 0226), as a wide
 * chip: its state as icon and color, its size, comments and checks once
 * its host says where it stands, and what the chat recorded until then.
 */
export function pullRequestChip({
  pr,
  status,
}: {
  pr: SessionPullRequest;
  status?: PullRequestStatus | null;
}): Chip {
  const state = status?.state ?? pr.state ?? "open";
  const looks = PULL_REQUEST_LOOKS[state];
  // Its number from its address when the chat recorded none, so the label
  // reads the same before and after its host answers.
  const number = status?.number ?? pr.number ?? numberInAddress(pr.url);
  const title = status?.title ?? pr.title;
  const repository = status?.repository ?? repositoryOf(pr.url);
  const badges: SidebarBadge[] = status
    ? [
        { label: `+${count(status.additions)}`, tone: "success" },
        { label: `−${count(status.deletions)}`, tone: "danger" },
        ...(status.comments
          ? [{ label: count(status.comments), icon: "MessageSquare" }]
          : []),
        ...(status.checks ? [checksBadge(status.checks)] : []),
      ]
    : [];
  const facts: SidebarPreviewMetadata[] = [
    { label: "State", value: looks.label },
    ...(status
      ? [
          { label: "Author", value: status.author },
          { label: "Branch", value: `${status.head} → ${status.base}` },
          {
            label: "Changes",
            value: `+${count(status.additions)} −${count(status.deletions)} in ${plural(status.changedFiles, "file")}`,
          },
          ...(status.comments
            ? [{ label: "Comments", value: count(status.comments) }]
            : []),
          ...(status.checks
            ? [{ label: "Checks", value: checksSummary(status.checks) }]
            : []),
        ]
      : []),
  ];
  return {
    id: pr.url,
    label: number
      ? `#${number}`
      : (title ?? pr.url.replace(/^https?:\/\//i, "")),
    description: number ? (title ?? repository) : repository,
    icon: looks.icon,
    ...(looks.tone ? { tone: looks.tone } : {}),
    wide: true,
    url: pr.url,
    ...(badges.length ? { badges } : {}),
    actions: [REMOVE_CHIP],
    preview: {
      title: title ?? (number ? `Pull request #${number}` : pr.url),
      description: number ? `${repository} #${number}` : repository,
      metadata: facts.slice(0, 6),
    },
    data: {
      kind: "pull-request",
      url: pr.url,
      state,
      repository,
      ...(number ? { number } : {}),
      ...(title ? { title } : {}),
      ...(status ? { status: { ...status } } : {}),
    },
  };
}

/**
 * True for a chip an agent attached under its session's `chips`: its id is
 * a short lowercase name, while Work's own chips are addressed by something
 * with a colon (a tab key, a pull request's address), so the two never meet.
 */
export const isAttachedChipId = (id: string) =>
  SESSION_CHIP_ID_PATTERN.test(id);

/**
 * The chips the chat's agent attached (`chips` in its session's metadata):
 * each held to what a row may be, at the root (an agent's chip is never in
 * a group), with open to the side when it opens something and no buttons
 * of its own, and always its ✕, so the person can take off whatever an
 * agent pinned. Its kind is `attached` unless its data names one.
 */
export function attachedChips(metadata: unknown): Chip[] {
  return sessionChips(metadata).flatMap((entry): Chip[] => {
    try {
      const row = sanitizeSidebarSourceItem(entry);
      const kind = typeof row.data?.kind === "string" ? row.data.kind : null;
      return [
        {
          ...row,
          parentId: null,
          hasChildren: false,
          actions: [
            ...(row.actions ?? (row.url ? [OPEN_SIDE_CHIP] : [])).filter(
              (entry) => entry.action !== REMOVE_CHIP.action,
            ),
            REMOVE_CHIP,
          ],
          data: { ...row.data, kind: kind ?? "attached" },
        },
      ];
    } catch {
      // An entry a row cannot hold shows nothing rather than breaking the
      // chips beside it.
      return [];
    }
  });
}

/**
 * Work's grouping: past {@link CHIP_GROUP_THRESHOLD} chips of one kind,
 * they fold into one group chip where the first of them stood, and open
 * upward from it. A tree of chips, flat: members name the group as their
 * parent.
 */
export function groupChips(chips: readonly Chip[]): Chip[] {
  const roots = chips.filter((chip) => !chip.parentId);
  const sizes = new Map<string, number>();
  for (const chip of roots) {
    const kind = chipKind(chip);
    if (kind && GROUPS[kind]) sizes.set(kind, (sizes.get(kind) ?? 0) + 1);
  }
  const out: Chip[] = [];
  const placed = new Set<string>();
  for (const chip of chips) {
    const kind = chipKind(chip);
    const group = kind ? GROUPS[kind] : undefined;
    if (
      !kind ||
      !group ||
      chip.parentId ||
      (sizes.get(kind) ?? 0) <= CHIP_GROUP_THRESHOLD
    ) {
      out.push(chip);
      continue;
    }
    const id = `group:${kind}`;
    if (!placed.has(id)) {
      placed.add(id);
      const members = roots.filter((member) => chipKind(member) === kind);
      const signal = members.some((member) => member.signal === "attention")
        ? ("attention" as const)
        : members.some((member) => member.signal === "working")
          ? ("working" as const)
          : undefined;
      out.push({
        id,
        label: group.label,
        icon: group.icon,
        parentId: null,
        hasChildren: true,
        badges: [count(members.length)],
        ...(signal ? { signal } : {}),
        data: { kind: "group", of: kind },
      });
    }
    out.push({ ...chip, parentId: id });
  }
  return out;
}

/**
 * The chips Work gives a chat (`work:chips`): what it holds (its forks and
 * subagents, the tabs it opened, the app views its tools showed), grouped
 * past three of a kind, then the pull requests it recorded, then what its
 * agent attached. Compact chips come first, packed in lines; wide ones
 * stack under them, against the composer, and fold first.
 */
export function workChips({
  pullRequests,
  statuses,
  metadata,
  held,
}: {
  pullRequests: readonly SessionPullRequest[];
  statuses: ReadonlyMap<string, PullRequestStatus | null>;
  metadata: unknown;
  held: readonly Chip[];
}): Chip[] {
  const chips = groupChips([
    ...held,
    ...pullRequests.map((pr) =>
      pullRequestChip({ pr, status: statuses.get(pr.url) }),
    ),
    ...attachedChips(metadata),
  ]);
  return [
    ...chips.filter((chip) => !chip.wide),
    ...chips.filter((chip) => chip.wide),
  ];
}
