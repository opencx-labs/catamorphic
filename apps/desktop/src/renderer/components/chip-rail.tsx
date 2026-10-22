import * as icons from "lucide-react";
import {
  ChevronUp,
  CircleAlert,
  LoaderCircle,
  RotateCw,
  SlidersHorizontal,
} from "lucide-react";
import {
  type FocusEvent,
  type KeyboardEvent,
  type MouseEvent,
  memo,
  type RefObject,
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { parseChatIcon } from "../../shared/chat-icons.js";
import {
  dangerLast,
  type MenuSeparator,
  menuGroups,
} from "../../shared/menu.js";
import {
  OPEN_ACTIONS,
  type OpenMode,
  openModeForAction,
  openModeFromEvent,
} from "../../shared/open-mode.js";
import type {
  SidebarActionInput,
  SidebarBadge,
  SidebarMenuEntry,
} from "../../shared/sidebar.js";
import type { SidebarSourceSession } from "../../shared/sidebar-source.js";
import { shownChipCount } from "../lib/chip-layout.js";
import type { Chip } from "../lib/chips.js";
import { keyMovedFocus } from "../lib/focus-modality.js";
import { lucideIcon } from "../lib/lucide-icon.js";
import { EASE_STANDARD, motionMs } from "../lib/motion.js";
import { usePopoverDismiss } from "../lib/popover-dismiss.js";
import { TONE_TEXT } from "../lib/tones.js";
import type { SectionSource } from "../sources/contract.js";
import { runRowAction } from "../sources/run.js";
import { ActionInputDialog } from "./action-input-dialog.js";
import { AnimatedTitle } from "./animated-title.js";
import { ChatGlyph } from "./chat-icon.js";
import { SignalBadge, SignalGlyph } from "./chat-signals.js";
import { ChipPreview } from "./chip-preview.js";
import { HarnessIcon } from "./harness-icon.js";
import {
  type ContextMenuEntry,
  type MenuAt,
  MenuPortal,
  menuAtControl,
  menuAtPointer,
} from "./menu.js";
import { PopPanel } from "./pop-panel.js";
import { ResourceInspector } from "./resource-inspector.js";
import { ShortcutHint } from "./shortcut-hint.js";
import { SiteFavicon } from "./site-favicon.js";
import { Sparkline } from "./sparkline.js";

/** Lines the rail shows before the rest fold behind "N more". */
const MAX_LINES = 3;
/** The gap between chips (gap-1.5), which the line packing counts. */
const GAP = 6;
/** The fold's own control, kept apart from any chip's id. */
const FOLD_ID = "\u0000fold";
/** The flow's own horizontal padding (px-px), which lines cannot use. */
const FLOW_PADDING = 2;
/** How long an action's sentence stays beside the rail. */
const MESSAGE_MS = 6000;

/** The right-click entry every chip and the rail itself offer. */
const CUSTOMIZE: ContextMenuEntry = {
  label: "Customize chips",
  action: "customize-chips",
  icon: "SlidersHorizontal",
};

/** What the rail hands its chat for the focus-chips shortcut. */
export interface ChipRailHandle {
  /** Focus the first chip, unfolding the rail; false when there is none. */
  focus: () => boolean;
}

const isImage = (icon: string) => /^(https?:|data:image\/)/i.test(icon);

/**
 * A chip's icon in its tone: a Lucide name, a chat glyph or an image; with
 * none, its address picks one (a page's favicon, a chat's glyph).
 */
function ToneIcon({ chip, className }: { chip: Chip; className: string }) {
  const icon = chip.icon;
  const tone = chip.tone ? TONE_TEXT[chip.tone] : "";
  // Subsessions carry the same harness/provider identity as their status
  // popup. A module's explicit icon override still takes precedence.
  if (chip.data?.kind === "subagent" && icon === "Bot")
    return (
      <HarnessIcon
        harness={
          typeof chip.data.harness === "string" ? chip.data.harness : undefined
        }
        provider={
          typeof chip.data.provider === "string"
            ? chip.data.provider
            : undefined
        }
        className={`${className} ${tone}`}
      />
    );
  if (icon && isImage(icon))
    return (
      <SiteFavicon
        url={chip.url && /^https?:/i.test(chip.url) ? chip.url : icon}
        faviconUrl={icon}
        className={className}
      />
    );
  if (icon && parseChatIcon(icon))
    return <ChatGlyph icon={icon} className={`${className} shrink-0`} />;
  const Named =
    lucideIcon(icon) ??
    (chip.url && /^https?:/i.test(chip.url) ? undefined : icons.Circle);
  if (!Named && chip.url)
    return <SiteFavicon url={chip.url} className={className} />;
  const Shown = Named ?? icons.Circle;
  return (
    <Shown
      aria-hidden="true"
      className={`${className} shrink-0 transition-colors duration-150 ${tone}`}
    />
  );
}

/**
 * A chip's icon: a new icon (a pull request merged) cross-fades in over
 * the one it replaces, a working chip spins, and one that waits for the
 * person (or was not read) carries its dot. A folded chip is still: no
 * loop runs where nobody can see it.
 */
function ChipGlyph({
  chip,
  wide,
  still = false,
}: {
  chip: Chip;
  wide: boolean;
  still?: boolean;
}) {
  const size = wide ? "size-3.5" : "size-3";
  const look = JSON.stringify([
    chip.icon,
    chip.url,
    chip.data?.harness,
    chip.data?.provider,
  ]);
  const previous = useRef({ look, chip });
  const [leaving, setLeaving] = useState<Chip | null>(null);
  // Before paint: the replaced icon is drawn under the new one from the
  // first frame of the change.
  useLayoutEffect(() => {
    if (previous.current.look !== look) setLeaving(previous.current.chip);
    previous.current = { look, chip };
  });
  const leavingRef = useRef<HTMLSpanElement>(null);
  const enteringRef = useRef<HTMLSpanElement>(null);
  useLayoutEffect(() => {
    if (!leaving) return;
    const duration = motionMs(150);
    const done = () => setLeaving(null);
    if (!duration) {
      done();
      return;
    }
    enteringRef.current?.animate(
      [
        { opacity: 0, transform: "scale(0.6)" },
        { opacity: 1, transform: "scale(1)" },
      ],
      { duration, easing: EASE_STANDARD },
    );
    const out = leavingRef.current?.animate(
      [
        { opacity: 1, transform: "scale(1)" },
        { opacity: 0, transform: "scale(0.6)" },
      ],
      { duration, easing: EASE_STANDARD, fill: "forwards" },
    );
    if (!out) {
      done();
      return;
    }
    out.onfinish = done;
    return () => {
      out.onfinish = null;
    };
  }, [leaving]);
  const dot =
    !still && (chip.signal === "attention" || chip.signal === "unread");
  const mark = still
    ? undefined
    : (chip.activity ?? (chip.signal === "working" ? "working" : undefined));
  return (
    <span className={`relative grid shrink-0 place-items-center ${size}`}>
      <SignalGlyph activity={mark} className={size}>
        <span className="grid size-full place-items-center">
          {leaving && (
            <span
              ref={leavingRef}
              aria-hidden="true"
              className="col-start-1 row-start-1 grid place-items-center"
            >
              <ToneIcon chip={leaving} className={size} />
            </span>
          )}
          <span
            ref={enteringRef}
            className="col-start-1 row-start-1 grid place-items-center"
          >
            <ToneIcon chip={chip} className={size} />
          </span>
        </span>
      </SignalGlyph>
      {dot && (
        <span
          className="absolute -right-1 -top-1 grid place-items-center"
          data-signal={chip.signal}
        >
          <SignalBadge
            signals={{
              attention: chip.signal === "attention",
              unread: chip.signal === "unread",
            }}
            size="sm"
          />
        </span>
      )}
    </span>
  );
}

function ChipBadge({
  badge,
  wide,
}: {
  badge: string | SidebarBadge;
  wide: boolean;
}) {
  const label = typeof badge === "string" ? badge : badge.label;
  const tone = typeof badge === "string" ? undefined : badge.tone;
  const Icon = typeof badge === "string" ? undefined : lucideIcon(badge.icon);
  return (
    <span
      data-chip-badge
      data-tone={tone}
      className={`flex max-w-28 shrink-0 items-center gap-1 rounded bg-bg-inset tabular-nums transition-colors duration-150 ${
        wide ? "h-5 px-1.5 text-[11px]" : "px-1 text-[10px]"
      } ${tone ? TONE_TEXT[tone] : "text-fg-muted"}`}
    >
      {Icon && <Icon aria-hidden="true" className="size-3 shrink-0" />}
      <span className="truncate">{label}</span>
    </span>
  );
}

/** One of a chip's buttons: a verb of Work's or of the chip's source. */
function ChipButton({
  chip,
  entry,
  pending,
  tabIndex,
  onRun,
}: {
  chip: Chip;
  entry: SidebarMenuEntry;
  pending: boolean;
  tabIndex: number;
  onRun: (entry: SidebarMenuEntry) => void;
}) {
  const Icon = lucideIcon(entry.icon) ?? icons.Circle;
  return (
    <ShortcutHint label={entry.disabledReason ?? entry.label}>
      <button
        type="button"
        tabIndex={tabIndex}
        data-chip-button={entry.action}
        aria-label={`${entry.label}: ${chip.label}`}
        aria-busy={pending || undefined}
        disabled={Boolean(entry.disabledReason)}
        data-disabled-reason={entry.disabledReason}
        onClick={(event) => {
          event.stopPropagation();
          onRun(entry);
        }}
        className="focus-ring-inset grid size-6 shrink-0 cursor-pointer place-items-center rounded text-fg-faint transition-colors duration-100 hover:bg-bg-overlay hover:text-fg disabled:cursor-default disabled:opacity-40"
      >
        {pending ? (
          <LoaderCircle
            aria-hidden="true"
            className="size-3 animate-spin motion-reduce:animate-none"
          />
        ) : (
          <Icon aria-hidden="true" className="size-3" />
        )}
      </button>
    </ShortcutHint>
  );
}

/** A group chip as it is read out: its words and how many it holds. */
function groupLabel(chip: Chip): string {
  const badge = chip.badges?.[0];
  const count = typeof badge === "string" ? badge : badge?.label;
  return count ? `${chip.label}, ${count}` : chip.label;
}

interface ChipViewProps {
  chip: Chip;
  /** Folded away: laid out (for its width) but neither seen nor reached. */
  hidden?: boolean;
  /** A copy fading out where a chip just stood; nothing on it works. */
  ghost?: boolean;
  current: boolean;
  groupOpen: boolean;
  /** The open group's panel, which the group chip controls. */
  groupPanelId?: string;
  pendingAction?: string;
  failure?: string;
  onActivate: (chip: Chip, mode: OpenMode) => void;
  onRun: (chip: Chip, entry: SidebarMenuEntry) => void;
  onMenu: (chip: Chip, at: MenuAt, element: HTMLElement) => void;
}

/**
 * One chip: compact (an icon and a label, its buttons over its end under
 * the pointer or keyboard focus) or wide (the composer's width, its
 * description, badges and buttons in view). A chip with members opens
 * them upward instead of opening an address.
 */
function ChipView({
  chip,
  hidden = false,
  ghost = false,
  current,
  groupOpen,
  groupPanelId,
  pendingAction,
  failure,
  onActivate,
  onRun,
  onMenu,
}: ChipViewProps) {
  const wide = chip.wide === true;
  const reachable = current && !hidden && !ghost;
  const tabIndex = reachable ? 0 : -1;
  const actions = chip.actions ?? [];
  const failureId = useId();
  const badges = (chip.badges ?? []).map((badge, index) => (
    <ChipBadge
      // biome-ignore lint/suspicious/noArrayIndexKey: a badge's place is its identity; its words change in place
      key={index}
      badge={badge}
      wide={wide}
    />
  ));
  const face = (
    <>
      <ChipGlyph chip={chip} wide={wide} still={hidden || ghost} />
      <AnimatedTitle
        text={chip.label}
        className={
          wide ? "min-w-0 max-w-[60%] shrink font-medium text-fg" : "max-w-36"
        }
      />
      {wide && (
        <span className="min-w-0 flex-1 truncate text-fg-faint">
          {chip.description}
        </span>
      )}
      {!wide && badges}
      {wide && (
        <span className="flex shrink-0 items-center gap-1">{badges}</span>
      )}
      {chip.trend && <Sparkline trend={chip.trend} />}
      {chip.hasChildren && (
        <ChevronUp
          aria-hidden="true"
          className={`size-3 shrink-0 text-fg-faint transition-transform duration-150 ${
            groupOpen ? "rotate-180" : ""
          }`}
        />
      )}
      {failure && (
        <CircleAlert
          aria-hidden="true"
          className="size-3 shrink-0 text-danger"
        />
      )}
    </>
  );
  const buttons = actions.map((entry) => (
    <ChipButton
      key={`${entry.action}:${entry.label}`}
      chip={chip}
      entry={entry}
      pending={pendingAction === entry.action}
      tabIndex={tabIndex}
      onRun={(picked) => onRun(chip, picked)}
    />
  ));
  return (
    <div
      data-testid={ghost ? undefined : "chip"}
      data-chip-id={ghost ? undefined : chip.id}
      data-chip-root={ghost ? undefined : chip.id}
      data-kind={
        typeof chip.data?.kind === "string" ? chip.data.kind : undefined
      }
      data-wide={wide || undefined}
      data-tone={chip.tone}
      data-signal={chip.signal}
      data-group={chip.hasChildren || undefined}
      data-hidden={hidden || undefined}
      data-failed={failure ? "true" : undefined}
      // An agent points at its chips as "chip:<id>" (point_at); one folded
      // away unfolds the rail when it is pointed at.
      data-point-key={ghost ? undefined : `chip:${chip.id}`}
      aria-hidden={hidden || ghost || undefined}
      inert={hidden || ghost || undefined}
      onContextMenu={(event) => {
        if (ghost || hidden) return;
        event.preventDefault();
        event.stopPropagation();
        onMenu(chip, menuAtPointer(event), event.currentTarget);
      }}
      className={`group/chip flex items-center overflow-hidden border text-fg-muted transition-colors duration-150 ${
        wide
          ? "h-8 w-full basis-full gap-1 rounded-lg pr-1 text-[12px]"
          : "h-6 max-w-full shrink-0 rounded-md text-[11px]"
      } ${
        groupOpen
          ? "border-border-strong bg-bg-overlay text-fg"
          : "border-border bg-bg-raised hover:bg-bg-overlay focus-within:bg-bg-overlay"
      } ${
        // Folded away, it is laid out out of flow for its width alone.
        hidden
          ? "pointer-events-none invisible absolute left-0 top-0"
          : "relative"
      }`}
    >
      <ResourceInspector
        label={`Preview ${chip.label}`}
        placement="above"
        // A group shows its members on click, not a card on hover.
        disabled={
          ghost || hidden || chip.hasChildren === true || chip.preview === false
        }
        content={<ChipPreview chip={chip} />}
      >
        {({ onClick: dismissPreview, ...trigger }) => (
          <button
            {...trigger}
            type="button"
            tabIndex={tabIndex}
            data-chip-main
            aria-expanded={chip.hasChildren ? groupOpen : undefined}
            aria-controls={
              chip.hasChildren && groupOpen ? groupPanelId : undefined
            }
            aria-label={chip.hasChildren ? groupLabel(chip) : undefined}
            aria-describedby={failure ? failureId : undefined}
            onClick={(event) => {
              dismissPreview();
              onActivate(
                chip,
                openModeFromEvent(event, chip.open ?? "replace"),
              );
            }}
            onKeyDown={(event) => {
              if (event.key !== "Enter" || event.defaultPrevented) return;
              event.preventDefault();
              dismissPreview();
              onActivate(
                chip,
                openModeFromEvent(event, chip.open ?? "replace"),
              );
            }}
            className={`flex h-full min-w-0 cursor-pointer items-center overflow-hidden text-left transition-colors duration-100 hover:text-fg ${
              wide ? "flex-1 gap-2 pl-2.5 pr-1" : "gap-1.5 px-2"
            }`}
          >
            {face}
          </button>
        )}
      </ResourceInspector>
      {failure && (
        <span id={failureId} className="sr-only">
          {failure}
        </span>
      )}
      {buttons.length > 0 &&
        (wide ? (
          <span className="flex shrink-0 items-center">{buttons}</span>
        ) : (
          // A compact chip's buttons come over its end, under the pointer
          // or keyboard focus, instead of widening every chip for good.
          <span className="pointer-events-none absolute inset-y-0 right-0 flex items-center bg-gradient-to-l from-bg-overlay from-70% to-transparent pl-3 pr-0.5 opacity-0 transition-opacity duration-100 group-focus-within/chip:pointer-events-auto group-focus-within/chip:opacity-100 group-hover/chip:pointer-events-auto group-hover/chip:opacity-100">
            {buttons}
          </span>
        ))}
    </div>
  );
}

/** The chips inside a group, opened upward from it. */
function GroupMembers({
  members,
  pendingAction,
  onActivate,
  onRun,
  onMenu,
  onClose,
}: {
  members: readonly Chip[];
  pendingAction: (chip: Chip) => string | undefined;
  onActivate: (chip: Chip, mode: OpenMode) => void;
  onRun: (chip: Chip, entry: SidebarMenuEntry) => void;
  onMenu: (chip: Chip, at: MenuAt, element: HTMLElement) => void;
  onClose: () => void;
}) {
  const listRef = useRef<HTMLDivElement>(null);
  const move = (event: KeyboardEvent<HTMLDivElement>) => {
    const rows = [
      ...(listRef.current?.querySelectorAll<HTMLElement>(
        "[data-member-main]",
      ) ?? []),
    ];
    const index = rows.findIndex((row) =>
      row.closest("[data-member]")?.contains(document.activeElement),
    );
    const go = (next: number) => {
      event.preventDefault();
      rows[Math.max(0, Math.min(rows.length - 1, next))]?.focus();
    };
    if (event.key === "ArrowDown") go(index + 1);
    else if (event.key === "ArrowUp") go(index - 1);
    else if (event.key === "Home") go(0);
    else if (event.key === "End") go(rows.length - 1);
    else if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      onClose();
    }
  };
  if (members.length === 0)
    return (
      <p className="px-2 py-1.5 text-[11px] text-fg-faint">Nothing here yet.</p>
    );
  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: arrow keys move between the member buttons inside
    <div ref={listRef} className="flex flex-col" onKeyDown={move}>
      {members.map((member) => (
        // biome-ignore lint/a11y/noStaticElementInteractions: right-click mirrors the member's keyboard menu
        <div
          key={member.id}
          data-member={member.id}
          data-testid="chip-member"
          data-point-key={`chip:${member.id}`}
          data-kind={
            typeof member.data?.kind === "string" ? member.data.kind : undefined
          }
          onContextMenu={(event) => {
            event.preventDefault();
            onMenu(member, menuAtPointer(event), event.currentTarget);
          }}
          className="group/member flex items-center rounded-md text-[12px] text-fg-muted transition-colors duration-100 hover:bg-bg-overlay focus-within:bg-bg-overlay"
        >
          <ResourceInspector
            label={`Preview ${member.label}`}
            disabled={member.preview === false}
            content={<ChipPreview chip={member} />}
          >
            {({ onClick: dismissPreview, ...trigger }) => (
              <button
                {...trigger}
                type="button"
                data-member-main
                aria-expanded={member.hasChildren ? false : undefined}
                onClick={(event) => {
                  dismissPreview();
                  onActivate(
                    member,
                    openModeFromEvent(event, member.open ?? "replace"),
                  );
                }}
                className="flex min-w-0 flex-1 cursor-pointer items-center gap-2 px-2 py-1.5 text-left hover:text-fg"
              >
                <ChipGlyph chip={member} wide />
                <span className="truncate">{member.label}</span>
                {member.description && (
                  <span className="min-w-0 truncate text-[11px] text-fg-faint">
                    {member.description}
                  </span>
                )}
                {member.trend && (
                  <span className="ml-auto flex shrink-0 pl-1">
                    <Sparkline trend={member.trend} />
                  </span>
                )}
              </button>
            )}
          </ResourceInspector>
          {(member.actions?.length ?? 0) > 0 && (
            <span className="mr-1 flex shrink-0 items-center opacity-0 transition-opacity duration-100 group-focus-within/member:opacity-100 group-hover/member:opacity-100">
              {member.actions?.map((entry) => (
                <ChipButton
                  key={`${entry.action}:${entry.label}`}
                  chip={member}
                  entry={entry}
                  pending={pendingAction(member) === entry.action}
                  tabIndex={0}
                  onRun={(picked) => onRun(member, picked)}
                />
              ))}
            </span>
          )}
        </div>
      ))}
    </div>
  );
}

/**
 * The fold's own chip: "3 more" folded, "Show less" unfolded. One
 * element both ways, so focus stays on it as it turns.
 */
function FoldChip({
  label,
  expanded,
  current = false,
  ghost = false,
  onPress,
}: {
  label: string;
  expanded?: boolean;
  current?: boolean;
  ghost?: boolean;
  onPress?: () => void;
}) {
  return (
    <button
      type="button"
      data-testid={ghost ? undefined : "chip-fold"}
      data-chip-root={ghost ? undefined : FOLD_ID}
      data-chip-main={ghost ? undefined : ""}
      tabIndex={current && !ghost ? 0 : -1}
      aria-expanded={ghost ? undefined : expanded}
      aria-label={
        ghost ? undefined : expanded ? "Show fewer chips" : `${label} chips`
      }
      aria-hidden={ghost || undefined}
      inert={ghost || undefined}
      onClick={onPress}
      className="focus-ring-inset flex h-6 shrink-0 cursor-pointer items-center rounded-md border border-dashed border-border px-2 text-[11px] text-fg-muted transition-colors duration-100 hover:border-border-strong hover:bg-bg-overlay hover:text-fg"
    >
      {label}
    </button>
  );
}

interface Ghost {
  id: string;
  chip?: Chip;
  label?: string;
  left: number;
  top: number;
  width: number;
}

interface Position {
  left: number;
  top: number;
  width: number;
}

/** A finished frame after the first paint: motion may begin. */
function useFirstFrames(): RefObject<boolean> {
  const painted = useRef(false);
  useEffect(() => {
    let second = 0;
    const first = requestAnimationFrame(() => {
      second = requestAnimationFrame(() => {
        painted.current = true;
      });
    });
    return () => {
      cancelAnimationFrame(first);
      cancelAnimationFrame(second);
    };
  }, []);
  return painted;
}

/**
 * The chips above a chat's composer (ADR 0239). Compact chips flow in
 * lines and wide ones take a line each; nothing scrolls sideways. Past
 * three lines the rest fold behind "N more". Chips enter and leave in
 * place, the ones that stay slide to where they now stand, and the rail's
 * height follows on the same curve. Arrow keys move between chips, Tab
 * between one chip's buttons, Escape back to the composer.
 */
export const ChipRail = memo(function ChipRail({
  chips,
  source,
  session,
  failure,
  onOpen,
  onCustomize,
  onLeave,
  register,
}: {
  /** A flat tree: a group's members name it as their parent. */
  chips: readonly Chip[];
  /** Where a chip's own actions go: the chips' source. */
  source: SectionSource;
  session?: SidebarSourceSession;
  /** The chips module failed: its message, and a way to read it again. */
  failure?: { message: string; retry: () => void };
  /** Open an address as the chat opens its links and tabs. */
  onOpen: (url: string, mode: OpenMode) => void;
  onCustomize: () => void;
  /** Hand focus back to the composer. */
  onLeave: () => void;
  register?: (handle: ChipRailHandle) => void;
}) {
  const roots = chips.filter((chip) => !chip.parentId);
  const membersOf = (id: string) =>
    chips.filter((chip) => chip.parentId === id);
  const railRef = useRef<HTMLDivElement>(null);
  const sizerRef = useRef<HTMLDivElement>(null);
  const flowRef = useRef<HTMLDivElement>(null);
  const measureMoreRef = useRef<HTMLSpanElement>(null);
  const groupPanelId = useId();
  // "pointer": the person (or an agent pointing at a folded chip) asked for
  // every chip; "keyboard": the shortcut did, and the rail folds again when
  // focus leaves it.
  const [unfolded, setUnfolded] = useState<"pointer" | "keyboard" | null>(null);
  // How many chips show folded; null while every chip fits.
  const [cut, setCut] = useState<number | null>(null);
  const [width, setWidth] = useState(0);
  const [openGroup, setOpenGroup] = useState<string | null>(null);
  const [currentId, setCurrentId] = useState<string | null>(null);
  const [menu, setMenu] = useState<{
    at: MenuAt;
    chip?: Chip;
    anchor: RefObject<Element | null>;
  } | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const pickedRef = useRef<ContextMenuEntry | null>(null);
  const [pending, setPending] = useState<{ id: string; action: string } | null>(
    null,
  );
  const [failures, setFailures] = useState<Record<string, string>>({});
  const [message, setMessage] = useState<string | null>(null);
  const [inputRequest, setInputRequest] = useState<{
    label: string;
    input: SidebarActionInput;
    run: (values: Record<string, string>) => Promise<unknown>;
  } | null>(null);
  const [ghosts, setGhosts] = useState<Ghost[]>([]);
  const focusFirstRef = useRef(false);
  const painted = useFirstFrames();

  const overflowing = cut !== null && cut < roots.length;
  const folded = unfolded === null && overflowing;
  const visibleRoots = folded ? roots.slice(0, cut ?? roots.length) : roots;
  const foldLabel = folded
    ? `${roots.length - (cut ?? roots.length)} more`
    : "Show less";
  const order = [
    ...visibleRoots.map((chip) => chip.id),
    ...(overflowing ? [FOLD_ID] : []),
  ];
  const current =
    currentId && order.includes(currentId) ? currentId : (order[0] ?? null);
  const failuresKey = Object.keys(failures).sort().join("\u0000");
  const rootsKey = roots
    .map((chip) =>
      [
        chip.id,
        chip.label,
        chip.wide ? 1 : 0,
        chip.icon ?? "",
        JSON.stringify(chip.badges ?? []),
        // A trend's width is fixed; whether it has a reading beside it is not.
        chip.trend ? (chip.trend.label === undefined ? 1 : 2) : 0,
        chip.hasChildren ? 1 : 0,
        (chip.actions ?? []).length,
      ].join("\u0001"),
    )
    .join("\u0000");

  // The rail's width, as it changes: lines break again.
  useLayoutEffect(() => {
    const flow = flowRef.current;
    if (!flow) return;
    setWidth(flow.clientWidth);
    const observer = new ResizeObserver(() => setWidth(flow.clientWidth));
    observer.observe(flow);
    return () => observer.disconnect();
  }, []);

  // How many chips fit in three lines with "N more" after them, measured
  // from every chip's natural width (folded ones are laid out unseen). A
  // commit whose fold is about to change is never painted, so motion
  // waits for the one that settles it.
  const settlingRef = useRef(false);
  // biome-ignore lint/correctness/useExhaustiveDependencies: the chips' words and sizes are what move lines; rootsKey and failuresKey carry them
  useLayoutEffect(() => {
    const flow = flowRef.current;
    if (!flow) return;
    const boxes = roots.map((chip) => {
      const element = flow.querySelector<HTMLElement>(
        `[data-chip-root="${CSS.escape(chip.id)}"]`,
      );
      // Layout widths, which no motion in flight changes; a pixel more
      // each, so rounding never puts a fourth line on screen.
      return {
        width: element ? element.offsetWidth + 1 : 0,
        wide: chip.wide === true,
      };
    });
    const count = shownChipCount({
      boxes,
      width: flow.clientWidth - FLOW_PADDING,
      gap: GAP,
      maxLines: MAX_LINES,
      moreWidth: (measureMoreRef.current?.offsetWidth ?? 64) + 1,
    });
    const next = count >= roots.length ? null : count;
    settlingRef.current = next !== cut;
    if (next !== cut) setCut(next);
    // Everything fits again: an unfolding for the overflow is over.
    if (next === null && unfolded === "pointer") setUnfolded(null);
  }, [rootsKey, failuresKey, width]);

  // The rail's height follows its lines on the standard curve: chips
  // arriving on a new line, the fold opening and closing. Unfolded, it
  // stops at two fifths of the window and scrolls (up and down only) past
  // that, so a long list never covers the chat. Nothing moves on load.
  const unfoldedRef = useRef(unfolded);
  unfoldedRef.current = unfolded;
  const fitRef = useRef<() => void>(() => {});
  useLayoutEffect(() => {
    const sizer = sizerRef.current;
    const flow = flowRef.current;
    if (!sizer || !flow) return;
    const apply = () => {
      const content = flow.offsetHeight;
      const limit = unfoldedRef.current
        ? Math.round(window.innerHeight * 0.4)
        : Number.POSITIVE_INFINITY;
      const height = Math.min(content, limit);
      sizer.style.overflowY = content > height ? "auto" : "hidden";
      if (!painted.current || !motionMs(200)) {
        sizer.style.transition = "none";
        sizer.style.height = `${height}px`;
        void sizer.offsetHeight;
        sizer.style.transition = "";
        return;
      }
      sizer.style.height = `${height}px`;
    };
    fitRef.current = apply;
    apply();
    const observer = new ResizeObserver(apply);
    observer.observe(flow);
    window.addEventListener("resize", apply);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", apply);
    };
  }, [painted]);

  // Motion for what changed since the last painted layout: chips that stay
  // slide from where they stood, new ones rise in, and ones that left (or
  // folded away) fade where they were. A width change alone reflows in
  // place: dragging a divider moves nothing on its own.
  const positionsRef = useRef(new Map<string, Position>());
  const lastChipsRef = useRef(new Map<string, Chip>());
  const lastFoldLabelRef = useRef(foldLabel);
  const lastOrderKeyRef = useRef("");
  const lastChipsKeyRef = useRef("");
  const orderKey = order.join("\u0000");
  const chipsKey = `${rootsKey}\u0002${unfolded ?? ""}`;
  // biome-ignore lint/correctness/useExhaustiveDependencies: motion is keyed on what is shown and where; chips are read for the ghosts they leave
  useLayoutEffect(() => {
    const flow = flowRef.current;
    if (!flow || settlingRef.current) return;
    fitRef.current();
    const before = positionsRef.current;
    const animate =
      painted.current &&
      (lastOrderKeyRef.current !== orderKey ||
        lastChipsKeyRef.current !== chipsKey);
    lastOrderKeyRef.current = orderKey;
    lastChipsKeyRef.current = chipsKey;
    const now = new Map<string, Position>();
    const moving: { element: HTMLElement; dx: number; dy: number }[] = [];
    const entering: HTMLElement[] = [];
    for (const element of flow.querySelectorAll<HTMLElement>(
      "[data-chip-root]:not([data-hidden])",
    )) {
      const id = element.dataset.chipRoot;
      if (!id) continue;
      // Where layout puts it, whatever motion is in flight.
      const position = {
        left: element.offsetLeft,
        top: element.offsetTop,
        width: element.offsetWidth,
      };
      now.set(id, position);
      if (!animate) continue;
      const previous = before.get(id);
      if (!previous) {
        entering.push(element);
        continue;
      }
      // An arriving chip keeps its arrival; a sliding one continues from
      // where its slide has it now.
      const animations = element.getAnimations();
      if (animations.some((animation) => animation.id === "chip-enter"))
        continue;
      const transform = new DOMMatrixReadOnly(
        getComputedStyle(element).transform,
      );
      const dx = Math.round(previous.left - position.left + transform.m41);
      const dy = Math.round(previous.top - position.top + transform.m42);
      if (!dx && !dy) continue;
      for (const animation of animations)
        if (animation.id === "chip-move") animation.cancel();
      moving.push({ element, dx, dy });
    }
    const left: Ghost[] = [];
    if (animate)
      for (const [id, position] of before) {
        if (now.has(id)) continue;
        const chip = lastChipsRef.current.get(id);
        left.push({
          id: `${id}\u0000${performance.now()}`,
          ...(chip ? { chip } : { label: lastFoldLabelRef.current }),
          ...position,
        });
      }
    positionsRef.current = now;
    lastChipsRef.current = new Map(chips.map((chip) => [chip.id, chip]));
    lastFoldLabelRef.current = foldLabel;
    if (left.length) setGhosts((current) => [...current, ...left]);
    const duration = motionMs(200);
    if (!duration) return;
    for (const { element, dx, dy } of moving)
      element.animate(
        [
          { transform: `translate(${dx}px, ${dy}px)` },
          { transform: "translate(0, 0)" },
        ],
        { duration, easing: EASE_STANDARD, id: "chip-move" },
      );
    for (const element of entering)
      element.animate(
        [
          { opacity: 0, transform: "translateY(4px) scale(0.96)" },
          { opacity: 1, transform: "translateY(0) scale(1)" },
        ],
        { duration, easing: EASE_STANDARD, id: "chip-enter" },
      );
  }, [orderKey, chipsKey, width]);

  // Focus never falls out of the rail with what held it (a chip removed by
  // its own X or by its agent): the chip now current takes it. Focus that
  // moved anywhere else is left where it went.
  const lastFocusedRef = useRef<Element | null>(null);
  const currentRef = useRef(current);
  currentRef.current = current;
  const focusCurrent = useCallback(() => {
    const flow = flowRef.current;
    const id = currentRef.current;
    const root = flow?.querySelector<HTMLElement>(
      id
        ? `[data-chip-root="${CSS.escape(id)}"]`
        : "[data-chip-root]:not([data-hidden])",
    );
    const main = root?.matches("[data-chip-main]")
      ? root
      : root?.querySelector<HTMLElement>("[data-chip-main]");
    main?.focus();
  }, []);
  const focusLost = () => {
    const lost = lastFocusedRef.current;
    return (
      lost !== null &&
      !lost.isConnected &&
      (document.activeElement === document.body ||
        document.activeElement === null)
    );
  };
  useLayoutEffect(() => {
    if (focusLost()) focusCurrent();
  });

  // The shortcut: unfold if folded, then focus the first chip; when focus
  // cannot land there (the rail is inert), the unfolding is taken back.
  useLayoutEffect(() => {
    if (!focusFirstRef.current) return;
    focusFirstRef.current = false;
    const main = flowRef.current?.querySelector<HTMLElement>(
      "[data-chip-root]:not([data-hidden]) [data-chip-main]",
    );
    main?.focus();
    if (!main || document.activeElement !== main)
      setUnfolded((state) => (state === "keyboard" ? null : state));
  });
  const registerRef = useRef(register);
  registerRef.current = register;
  const rootsCount = roots.length;
  const foldedNow = folded;
  useEffect(() => {
    registerRef.current?.({
      focus: () => {
        const flow = flowRef.current;
        if (rootsCount === 0 || !flow || flow.closest("[inert]")) return false;
        // The shortcut leads with the keyboard: the ring shows at once.
        keyMovedFocus();
        setCurrentId(null);
        if (foldedNow) {
          setUnfolded("keyboard");
          focusFirstRef.current = true;
          return true;
        }
        flow
          .querySelector<HTMLElement>(
            "[data-chip-root]:not([data-hidden]) [data-chip-main]",
          )
          ?.focus();
        return flow.contains(document.activeElement);
      },
    });
  }, [rootsCount, foldedNow]);

  // An agent pointing at a chip folded away unfolds the rail to show it.
  useEffect(() => {
    const flow = flowRef.current;
    if (!flow) return;
    const observer = new MutationObserver(() => {
      if (flow.querySelector("[data-hidden].agent-pointer"))
        setUnfolded((state) => state ?? "pointer");
    });
    observer.observe(flow, {
      subtree: true,
      attributes: true,
      attributeFilter: ["class"],
    });
    return () => observer.disconnect();
  }, []);

  // A press elsewhere or Escape closes an open group.
  usePopoverDismiss({
    open: openGroup !== null,
    within: [railRef],
    onDismiss: () => setOpenGroup(null),
  });
  useEffect(() => {
    if (openGroup && !chips.some((chip) => chip.id === openGroup))
      setOpenGroup(null);
  }, [chips, openGroup]);
  useEffect(() => {
    if (!message) return;
    const timer = setTimeout(() => setMessage(null), MESSAGE_MS);
    return () => clearTimeout(timer);
  }, [message]);

  const runEntry = useCallback(
    async (
      chip: Chip,
      entry: SidebarMenuEntry | ContextMenuEntry,
      values?: Record<string, string>,
    ) => {
      if (entry.action === CUSTOMIZE.action) {
        onCustomize();
        return;
      }
      const mode = openModeForAction(entry.action);
      if (entry.url) {
        onOpen(entry.url, mode ?? chip.open ?? "replace");
        return;
      }
      if ("input" in entry && entry.input && !values) {
        const input = entry.input;
        setInputRequest({
          label: entry.label,
          input,
          run: (typed) => runEntry(chip, entry, typed),
        });
        return;
      }
      setPending({ id: chip.id, action: entry.action });
      setFailures(({ [chip.id]: _gone, ...rest }) => rest);
      try {
        const effect = await runRowAction({
          source,
          row: chip,
          itemId: chip.id,
          action: entry.action,
          ...(values ? { values } : {}),
          ...(session ? { session } : {}),
          signal: new AbortController().signal,
          open: onOpen,
        });
        if (effect?.message) setMessage(effect.message);
      } catch (cause) {
        const text = cause instanceof Error ? cause.message : String(cause);
        if (values) throw cause;
        setFailures((all) => ({ ...all, [chip.id]: text }));
      } finally {
        setPending(null);
      }
    },
    [onCustomize, onOpen, session, source],
  );

  /** The root a chip sits under (itself, or its group's root). */
  const rootOf = (id: string): string => {
    const seen = new Set([id]);
    let at = id;
    let parent = chips.find((chip) => chip.id === at)?.parentId;
    while (parent && !seen.has(parent)) {
      seen.add(parent);
      at = parent;
      parent = chips.find((chip) => chip.id === at)?.parentId;
    }
    return at;
  };

  const activate = (chip: Chip, mode: OpenMode) => {
    setCurrentId(rootOf(chip.id));
    if (chip.hasChildren) {
      setOpenGroup((open) => (open === chip.id ? null : chip.id));
      // Opened from the keyboard, focus goes to its first member.
      if (document.documentElement.dataset.focusModality === "keyboard")
        requestAnimationFrame(() =>
          railRef.current
            ?.querySelector<HTMLElement>("[data-member-main]")
            ?.focus(),
        );
      return;
    }
    if (chip.parentId) setOpenGroup(null);
    if (chip.url) {
      onOpen(chip.url, mode);
      return;
    }
    // Without an address, its source opens it.
    void runEntry(chip, {
      label: "Open",
      action:
        mode === "replace"
          ? "open"
          : (OPEN_ACTIONS.find((entry) => entry.mode === mode)?.action ??
            "open"),
    });
  };

  const menuFor = (chip?: Chip): (ContextMenuEntry | MenuSeparator)[] => {
    if (!chip) return [CUSTOMIZE];
    const own = dangerLast<ContextMenuEntry>([
      ...(chip.contextMenu ?? chip.menu ?? []),
      ...(chip.actions ?? []).filter(
        (entry) =>
          !openModeForAction(entry.action) &&
          !(chip.contextMenu ?? chip.menu ?? []).some(
            (other) => other.action === entry.action,
          ),
      ),
    ]);
    return menuGroups<ContextMenuEntry>(
      chip.url ? OPEN_ACTIONS : [],
      chip.url && /^https?:/i.test(chip.url)
        ? [{ label: "Copy link", action: "copy-url", icon: "Link" }]
        : [],
      own,
      [CUSTOMIZE],
    );
  };
  const showMenu = (
    chip: Chip | undefined,
    at: MenuAt,
    element: Element | null,
  ) => {
    pickedRef.current = null;
    // The menu belongs to the chip it opened for, and goes when it does.
    setMenu({ at, ...(chip ? { chip } : {}), anchor: { current: element } });
    setMenuOpen(true);
  };

  // Arrow keys move between chips; Up and Down between lines, and Down
  // past the last line back to the composer; Escape returns there too.
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const flow = flowRef.current;
    if (!flow || event.defaultPrevented) return;
    const mains = [
      ...flow.querySelectorAll<HTMLElement>(
        "[data-chip-root]:not([data-hidden])",
      ),
    ];
    const index = mains.findIndex((root) =>
      root.contains(document.activeElement),
    );
    if (index < 0) return;
    const focusAt = (next: number) => {
      const root = mains[Math.max(0, Math.min(mains.length - 1, next))];
      const main = root?.matches("[data-chip-main]")
        ? root
        : root?.querySelector<HTMLElement>("[data-chip-main]");
      if (!main) return;
      event.preventDefault();
      setCurrentId(root?.dataset.chipRoot ?? null);
      main.focus();
    };
    const vertical = (direction: 1 | -1) => {
      const here = mains[index]?.getBoundingClientRect();
      if (!here) return;
      const center = here.left + here.width / 2;
      const candidates = mains
        .map((root, at) => ({ at, rect: root.getBoundingClientRect() }))
        .filter(({ rect }) =>
          direction > 0 ? rect.top > here.top + 2 : rect.top < here.top - 2,
        );
      if (candidates.length === 0) {
        if (direction > 0) {
          event.preventDefault();
          onLeave();
        }
        return;
      }
      const line =
        direction > 0
          ? Math.min(...candidates.map(({ rect }) => rect.top))
          : Math.max(...candidates.map(({ rect }) => rect.top));
      const nearest = candidates
        .filter(({ rect }) => Math.abs(rect.top - line) < 2)
        .sort(
          (a, b) =>
            Math.abs(a.rect.left + a.rect.width / 2 - center) -
            Math.abs(b.rect.left + b.rect.width / 2 - center),
        )[0];
      if (nearest) focusAt(nearest.at);
    };
    switch (event.key) {
      case "ArrowRight":
        focusAt(index + 1);
        break;
      case "ArrowLeft":
        focusAt(index - 1);
        break;
      case "Home":
        focusAt(0);
        break;
      case "End":
        focusAt(mains.length - 1);
        break;
      case "ArrowDown":
        vertical(1);
        break;
      case "ArrowUp":
        vertical(-1);
        break;
      case "Escape":
        event.preventDefault();
        event.stopPropagation();
        // An open group closes first; then focus goes back to the composer.
        if (openGroup) setOpenGroup(null);
        else onLeave();
        break;
      case "ContextMenu":
      case "F10": {
        if (event.key === "F10" && !event.shiftKey) return;
        const root = mains[index];
        const chip = roots.find(
          (candidate) => candidate.id === root?.dataset.chipRoot,
        );
        if (!root || !chip) return;
        event.preventDefault();
        showMenu(chip, menuAtControl(root), root);
        break;
      }
    }
  };

  // The shortcut's unfolding lasts while focus stays among the chips (the
  // group's members and the chips' menu and dialog included).
  const onRailBlur = (event: FocusEvent<HTMLDivElement>) => {
    const next = event.relatedTarget;
    if (next instanceof Node && railRef.current?.contains(next)) return;
    // Settled a frame later: focus lost with a removed chip comes back.
    requestAnimationFrame(() => {
      const rail = railRef.current;
      if (!rail || rail.contains(document.activeElement)) return;
      if (focusLost()) {
        focusCurrent();
        return;
      }
      lastFocusedRef.current = null;
      if (unfoldedRef.current === "keyboard" && !menuOpen && !inputRequest)
        setUnfolded(null);
    });
  };

  const openMembers = openGroup ? membersOf(openGroup) : [];
  const pendingFor = (chip: Chip) =>
    pending?.id === chip.id ? pending.action : undefined;
  const runFromChip = (target: Chip, entry: SidebarMenuEntry) =>
    void runEntry(target, entry);

  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: focus bookkeeping only; the chips inside are the controls
    <div
      ref={railRef}
      className="relative mx-3"
      data-testid="chip-rail"
      data-unfolded={unfolded ?? undefined}
      onFocus={(event) => {
        lastFocusedRef.current = event.target;
      }}
      onBlur={onRailBlur}
    >
      <PopPanel
        id={groupPanelId}
        role="group"
        aria-label={
          chips.find((chip) => chip.id === openGroup)?.label ?? "Chips"
        }
        open={openGroup !== null}
        className="absolute bottom-full left-0 z-20 mb-1.5 max-h-64 w-80 overflow-y-auto rounded-lg border border-border bg-bg-raised p-1 shadow-2xl"
        testId="chip-group-members"
      >
        <GroupMembers
          members={openMembers}
          pendingAction={pendingFor}
          onActivate={activate}
          onRun={runFromChip}
          onMenu={showMenu}
          onClose={() => {
            const group = openGroup;
            setOpenGroup(null);
            if (group)
              flowRef.current
                ?.querySelector<HTMLElement>(
                  `[data-chip-root="${CSS.escape(rootOf(group))}"] [data-chip-main]`,
                )
                ?.focus();
          }}
        />
      </PopPanel>
      <div
        ref={sizerRef}
        className="overflow-x-hidden overflow-y-hidden transition-[height] duration-200 ease-standard [scrollbar-width:thin]"
      >
        <div
          ref={flowRef}
          role="toolbar"
          aria-label="Chips"
          aria-orientation="horizontal"
          onKeyDown={onKeyDown}
          onFocus={(event) => {
            const root =
              event.target instanceof Element
                ? event.target.closest<HTMLElement>("[data-chip-root]")
                : null;
            if (root?.dataset.chipRoot) setCurrentId(root.dataset.chipRoot);
          }}
          onContextMenu={(event: MouseEvent<HTMLDivElement>) => {
            if (
              event.target instanceof Element &&
              event.target.closest("[data-chip-root]")
            )
              return;
            event.preventDefault();
            showMenu(undefined, menuAtPointer(event), flowRef.current);
          }}
          className={`relative flex flex-wrap items-center gap-1.5 px-px ${
            roots.length ? "pb-px pt-1" : ""
          }`}
        >
          {roots.map((chip, index) => (
            <ChipView
              key={chip.id}
              chip={chip}
              hidden={folded && index >= (cut ?? roots.length)}
              current={current === chip.id}
              groupOpen={openGroup === chip.id}
              groupPanelId={groupPanelId}
              pendingAction={pendingFor(chip)}
              failure={failures[chip.id]}
              onActivate={activate}
              onRun={runFromChip}
              onMenu={showMenu}
            />
          ))}
          {overflowing && (
            <FoldChip
              key={FOLD_ID}
              label={foldLabel}
              expanded={!folded}
              current={current === FOLD_ID}
              onPress={() => {
                if (folded) setUnfolded("pointer");
                else {
                  setCurrentId(null);
                  setUnfolded(null);
                }
              }}
            />
          )}
          {/* The fold's widest words, measured unseen for the line math. */}
          <span
            ref={measureMoreRef}
            aria-hidden="true"
            className="pointer-events-none invisible absolute left-0 top-0 flex h-6 items-center border border-dashed px-2 text-[11px]"
          >
            {`${Math.max(roots.length, 10)} more`}
          </span>
          {ghosts.map((ghost) => (
            <div
              key={ghost.id}
              aria-hidden="true"
              inert
              className="pointer-events-none absolute"
              style={{ left: ghost.left, top: ghost.top, width: ghost.width }}
              ref={(element) => {
                if (!element || element.dataset.leaving) return;
                element.dataset.leaving = "true";
                const duration = motionMs(180);
                const finish = () =>
                  setGhosts((all) =>
                    all.filter((item) => item.id !== ghost.id),
                  );
                if (!duration) {
                  finish();
                  return;
                }
                element.animate(
                  [
                    { opacity: 1, transform: "scale(1)" },
                    { opacity: 0, transform: "translateY(4px) scale(0.96)" },
                  ],
                  { duration, easing: EASE_STANDARD, fill: "forwards" },
                ).onfinish = finish;
              }}
            >
              {ghost.chip ? (
                <ChipView
                  chip={ghost.chip}
                  ghost
                  current={false}
                  groupOpen={false}
                  onActivate={() => {}}
                  onRun={() => {}}
                  onMenu={() => {}}
                />
              ) : (
                <FoldChip label={ghost.label ?? ""} ghost />
              )}
            </div>
          ))}
        </div>
      </div>
      {failure && (
        <div
          role="alert"
          data-testid="chip-rail-failure"
          className="mt-1 flex h-6 w-fit max-w-full items-center gap-1.5 rounded-md border border-danger/30 bg-danger/5 pl-2 pr-0.5 text-[11px] text-danger"
        >
          <CircleAlert aria-hidden="true" className="size-3 shrink-0" />
          <span className="min-w-0 truncate">
            Chips failed: {failure.message}
          </span>
          <ShortcutHint label="Read the chips again">
            <button
              type="button"
              onClick={failure.retry}
              aria-label="Retry chips"
              className="focus-ring-inset grid size-5 shrink-0 cursor-pointer place-items-center rounded text-danger hover:bg-danger/10"
            >
              <RotateCw aria-hidden="true" className="size-3" />
            </button>
          </ShortcutHint>
          <ShortcutHint label="Customize chips">
            <button
              type="button"
              onClick={onCustomize}
              aria-label="Customize chips"
              className="focus-ring-inset grid size-5 shrink-0 cursor-pointer place-items-center rounded text-danger hover:bg-danger/10"
            >
              <SlidersHorizontal aria-hidden="true" className="size-3" />
            </button>
          </ShortcutHint>
        </div>
      )}
      {/* Always mounted, so a sentence an action reports is announced. */}
      <p
        role="status"
        className={
          message ? "mt-1 truncate px-1 text-[11px] text-fg-muted" : "sr-only"
        }
      >
        {message ?? ""}
      </p>
      {menu && (
        <MenuPortal
          open={menuOpen}
          at={menu.at}
          anchor={menu.anchor}
          label={menu.chip ? `Actions for ${menu.chip.label}` : "Chips"}
          entries={menuFor(menu.chip)}
          onDismiss={() => setMenuOpen(false)}
          onPick={(entry) => {
            pickedRef.current = entry;
            setMenuOpen(false);
          }}
          onExited={() => {
            const picked = pickedRef.current;
            const chip = menu.chip;
            pickedRef.current = null;
            setMenu(null);
            if (!picked) return;
            if (picked.action === CUSTOMIZE.action) onCustomize();
            else if (chip) void runEntry(chip, picked);
          }}
        />
      )}
      <ActionInputDialog
        request={inputRequest}
        onClose={() => setInputRequest(null)}
      />
    </div>
  );
});
