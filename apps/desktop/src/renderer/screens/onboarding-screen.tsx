import type { ItemCommon, TimelineTurn } from "@catamorphic/react";
import {
  ArrowLeft,
  ArrowUp,
  Check,
  ChevronDown,
  Folder,
  Globe,
  Keyboard,
  MessageSquare,
  MousePointer2,
  PanelLeft,
  PanelRight,
  Plus,
  Search,
  Settings,
  Sparkles,
  Star,
} from "lucide-react";
import {
  type ReactNode,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { BrowserImportDialog } from "../components/browser-import.js";
import { ChatTimeline } from "../components/catamorphic/chat-timeline.js";
import { ChatBubbles } from "../components/chat-bubbles.js";
import { ChatGlyph } from "../components/chat-icon.js";
import { ComposerInput } from "../components/composer-input.js";
import { DefaultBrowserButton } from "../components/default-browser.js";
import { OpenResourceButton } from "../components/open-resource-button.js";
import { PaletteSurface } from "../components/palette-surface.js";
import { PendingButton } from "../components/pending-button.js";
import { SidebarItemRow } from "../components/sidebar-item-row.js";
import {
  type WorkspaceTab,
  WorkspaceTabBar,
} from "../components/workspace-tabs.js";
import { formatBinding, useKeybindings } from "../lib/keybindings.js";

export const ONBOARDING_STEPS = [
  "Welcome",
  "Theme",
  "AI agents",
  "The dock",
  "Keyboard shortcuts",
  "Palette",
  "Sidebars",
  "Browser setup",
];

export function OnboardingScreen({
  active = true,
  step,
  onStepChange,
  onChooseTheme,
  onConfigureAgent,
  canConfigureAgent,
  onFinish,
  profileId,
  importCompleted,
  hasAgents,
}: {
  active?: boolean;
  step: number;
  onStepChange: (step: number) => void;
  onChooseTheme: () => void;
  onConfigureAgent: () => void;
  canConfigureAgent: boolean;
  onFinish: () => void;
  profileId?: string;
  importCompleted: boolean;
  hasAgents: boolean;
}) {
  const current = Math.max(0, Math.min(step, ONBOARDING_STEPS.length - 1));
  const [previous, setPrevious] = useState<number | null>(null);
  const [importOpen, setImportOpen] = useState(false);
  const [justImported, setJustImported] = useState(false);
  const bindings = useKeybindings();
  const navigate = (next: number) => {
    setPrevious(current);
    onStepChange(next);
  };
  const hints: ReactNode[] = [
    <>
      You can skip this tutorial by closing this tab. Whenever you want to come
      back to it, just{" "}
      {bindings["new-tab"] ? (
        <>
          hit <kbd>{formatBinding(bindings["new-tab"])}</kbd>
        </>
      ) : (
        <>open a new tab</>
      )}{" "}
      and search for “Tutorial”.
    </>,
    "You can always change your theme later.",
    null,
    null,
    "You can see all bindings in Settings.",
    null,
    null,
    "You can do this later in Settings or from the palette.",
  ];
  const pages: ReactNode[] = [
    <div key="welcome" className="onboarding-welcome">
      <h1>Welcome to Work</h1>
      <p>The place to get things done and build your dreams.</p>
      <button
        type="button"
        className="button-primary onboarding-explore"
        onClick={() => navigate(1)}
      >
        Explore Work
      </button>
    </div>,
    <Step
      key="theme"
      heading="Make the app yours"
      description="Start by choosing a theme."
    >
      <WorkspacePreview />
      <button
        type="button"
        className="button-secondary mt-5"
        onClick={onChooseTheme}
        data-testid="onboarding-choose-theme"
      >
        Choose a theme
      </button>
    </Step>,
    <Step
      key="agents"
      heading="Where AI agents can do wonders"
      description="Configure your agents in Work, and let them do the heavy lifting. Once configured, your agents will be able to fully customize the workspace for you; all you need to do is ask."
    >
      <div className="onboarding-browser-mark">
        <Sparkles strokeWidth={1} />
      </div>
      <PendingButton
        type="button"
        pending={false}
        pendingLabel="Opening agent setup…"
        done={hasAgents}
        doneLabel={
          <span className="inline-flex items-center gap-2">
            <Check className="size-3.5" />
            Agent configured
          </span>
        }
        onClick={onConfigureAgent}
        disabled={!canConfigureAgent}
        data-disabled-reason="Preparing your workspace"
        className="button-primary mt-6"
        data-testid="onboarding-setup-agent"
      >
        Configure an agent
      </PendingButton>
    </Step>,
    <Step
      key="dock"
      heading="Keep your chats handy"
      detail={
        <>
          You can detach the dock to make it float independently of the Work
          window. Right click on the dock bubble and select “Float dock in its
          own window”.
        </>
      }
      description={
        <>
          The dock is where you keep AI conversations for quick access. Expand
          the dock and click the <PlusIcon /> button to create a new chat with
          your agent
          {bindings["new-floating-chat"] && (
            <>
              , or press{" "}
              <kbd>{formatBinding(bindings["new-floating-chat"])}</kbd>
            </>
          )}
          . Expand a floating chat into a workspace tab, or bring it back to the
          dock.
        </>
      }
    >
      <DockPreview active={active} />
    </Step>,
    <Step
      key="shortcuts"
      heading="Move at the speed of thought"
      description="Work allows you to fully customize keyboard shortcuts. You can hover on buttons to see what shortcut can do the same action, or ask your agent to set a key binding."
    >
      <div className="onboarding-browser-mark">
        <Keyboard strokeWidth={1} />
      </div>
    </Step>,
    <Step
      key="palette"
      heading="The way to find everything"
      description={
        <>
          Open the palette by opening a new tab using the <PlusIcon /> icon
          {bindings["new-tab"] && (
            <>
              {" "}
              or <kbd>{formatBinding(bindings["new-tab"])}</kbd>
            </>
          )}
          , or
          {bindings["command-palette"] ? (
            <>
              {" "}
              pressing <kbd>{formatBinding(bindings["command-palette"])}</kbd>
            </>
          ) : (
            <> using the app menu</>
          )}
          .
          <br />
          Quickly find your tabs, bookmarks, frequently used items, and more.
        </>
      }
      detail={
        <>
          The palette is very versatile. Try searching for “history” and enter
          that mode. Palettes let you search and access anything, and they’re
          completely customizable. Just ask your agent to create a new mode for
          you.
        </>
      }
    >
      <PalettePreview />
    </Step>,
    <Step
      key="sidebars"
      heading="Sidebars that show exactly what you want"
      description="Sidebars are completely customizable. Just ask your agent to modify or add completely new sections, no matter how detailed."
    >
      <WorkspacePreview animateSidebars active={active} />
    </Step>,
    <Step
      key="import"
      heading="Browse the web from Work"
      description="Work is a fully-featured browser. Import your bookmarks, passwords, signed-in accounts, and history."
    >
      <div className="onboarding-browser-mark">
        <Globe strokeWidth={1} />
      </div>
      <div className="onboarding-browser-actions">
        <PendingButton
          type="button"
          pending={false}
          done={importCompleted || justImported}
          doneLabel={
            <span className="inline-flex items-center gap-2">
              <Check className="size-3.5" />
              Browser import complete
            </span>
          }
          onClick={() => setImportOpen(true)}
          disabled={!profileId}
          data-disabled-reason="Loading this profile"
          data-testid="onboarding-browser-import"
          className="button-primary browser-setup-action"
        >
          Import from a browser
        </PendingButton>
        <DefaultBrowserButton showAvailabilityReason={false} />
      </div>
    </Step>,
  ];
  return (
    <section
      className="onboarding"
      data-testid="onboarding"
      data-onboarding-step={current}
      aria-label="Tutorial"
    >
      <p className="sr-only" role="status">
        Step {current + 1} of {ONBOARDING_STEPS.length}:{" "}
        {ONBOARDING_STEPS[current]}
      </p>
      <div className="onboarding-viewport">
        <div
          className="onboarding-track"
          style={{ transform: `translateX(-${current * 100}%)` }}
          onTransitionEnd={(event) => {
            if (event.target === event.currentTarget) setPrevious(null);
          }}
        >
          {pages.map((page, index) => (
            <div
              key={ONBOARDING_STEPS[index]}
              className="onboarding-page"
              inert={index !== current}
              aria-hidden={index !== current}
            >
              {(index === current || index === previous) && page}
            </div>
          ))}
        </div>
      </div>
      <footer className="onboarding-footer">
        <div className="onboarding-hint">
          {hints[current] && <small key={current}>{hints[current]}</small>}
        </div>
        <div className="onboarding-navigation">
          <button
            type="button"
            className={`button-ghost ${current === 0 ? "invisible" : ""}`}
            onClick={() => navigate(current - 1)}
            disabled={current === 0}
          >
            <ArrowLeft className="size-3.5" />
            Back
          </button>
          <nav aria-label="Tutorial steps" className="onboarding-progress">
            {ONBOARDING_STEPS.map((label, index) => (
              <button
                type="button"
                key={label}
                aria-label={label}
                aria-current={current === index ? "step" : undefined}
                onClick={() => navigate(index)}
              >
                <span className="onboarding-progress-dot" />
              </button>
            ))}
          </nav>
          <button
            type="button"
            className={`button-ghost ${current === 0 ? "invisible" : ""}`}
            onClick={() =>
              current === ONBOARDING_STEPS.length - 1
                ? onFinish()
                : navigate(current + 1)
            }
            disabled={current === 0}
            data-testid="onboarding-next"
          >
            {current === ONBOARDING_STEPS.length - 1 ? "Done" : "Next"}
          </button>
        </div>
      </footer>
      {profileId && (
        <BrowserImportDialog
          open={importOpen}
          profileId={profileId}
          onClose={() => setImportOpen(false)}
          onComplete={() => setJustImported(true)}
        />
      )}
    </section>
  );
}

function Step({
  heading,
  description,
  detail,
  children,
}: {
  heading: string;
  description: ReactNode;
  detail?: ReactNode;
  children: ReactNode;
}) {
  const items = Array.isArray(children) ? children : [children];
  return (
    <div className="onboarding-step">
      <div className="onboarding-centerpiece">{items[0]}</div>
      <div className="onboarding-copy">
        <h1>{heading}</h1>
        <p>{description}</p>
        {detail && <p>{detail}</p>}
        {items.slice(1)}
      </div>
    </div>
  );
}

function PlusIcon() {
  return (
    <Plus className="onboarding-inline-icon" role="img" aria-label="plus" />
  );
}

/** The real dock, driven by a local demonstration instead of workspace state. */
function DockPreview({ active }: { active: boolean }) {
  const frame = useRef<HTMLDivElement>(null);
  const cursorAnimation = useRef<Animation | null>(null);
  const clickAnimation = useRef<Animation | null>(null);
  const targets = useRef<{
    expand?: { x: number; y: number };
    new?: { x: number; y: number };
    collapse?: { x: number; y: number };
  }>({});
  const [playing, setPlaying] = useState(false);
  const [expanded, setExpanded] = useState(false);
  useLayoutEffect(() => {
    const root = frame.current;
    if (!root) return;
    let stale = false;
    const measure = async () => {
      const rail = root.querySelector("[data-dock-rail]");
      if (!rail) return;
      // Flush style, then measure the controls once their own motion settles.
      // The SVG pointer's tip is at (4, 4) in its 24px view box.
      rail.getBoundingClientRect();
      await Promise.allSettled(
        rail
          .getAnimations({ subtree: true })
          .filter(
            (animation) =>
              animation.effect?.getTiming().iterations !== Infinity,
          )
          .map((animation) => animation.finished),
      );
      if (stale) return;
      const bounds = root.getBoundingClientRect();
      const controls = expanded
        ? [
            { name: "collapse", selector: "[data-dock-arrows]" },
            { name: "new", selector: 'button[aria-label="New chat"]' },
          ]
        : [
            {
              name: "expand",
              selector: 'button[aria-label="Expand chat bubbles"]',
            },
          ];
      for (const target of controls) {
        const button = root.querySelector(target.selector);
        if (!button) continue;
        const rect = button.getBoundingClientRect();
        const point = {
          x: rect.x + rect.width / 2 - bounds.x - 4,
          y: rect.y + rect.height / 2 - bounds.y - 4,
        };
        if (target.name === "expand") targets.current.expand = point;
        else if (target.name === "new") targets.current.new = point;
        else targets.current.collapse = point;
      }
      const cursor = root.querySelector(".onboarding-demo-cursor");
      const click = root.querySelector(".onboarding-demo-click");
      const expand = targets.current.expand;
      if (!cursor || !click || !expand) return;
      const translate = ({ x, y }: { x: number; y: number }) =>
        `translate(${x}px, ${y}px)`;
      const home = translate({ x: expand.x + 54, y: expand.y - 64 });
      const collapse = translate(targets.current.collapse ?? expand);
      const open = translate(expand);
      const newChat = translate(targets.current.new ?? expand);
      const easing = getComputedStyle(root)
        .getPropertyValue("--ease-standard")
        .trim();
      // Give the compositor concrete coordinates. CSS keyframes that reference
      // targets discovered mid-animation can keep rendering their initial,
      // unresolved transform even while computed style reports the right path.
      const keyframes = [
        { offset: 0, transform: home, opacity: 0 },
        { offset: 0.12, transform: open, opacity: 1 },
        { offset: 0.18, transform: `${open} scale(0.86)`, opacity: 1 },
        { offset: 0.21, transform: open, opacity: 1 },
        { offset: 0.28, transform: open, opacity: 1 },
        { offset: 0.35, transform: newChat, opacity: 1 },
        { offset: 0.52, transform: newChat, opacity: 1 },
        { offset: 0.62, transform: collapse, opacity: 1 },
        { offset: 0.65, transform: `${collapse} scale(0.86)`, opacity: 1 },
        { offset: 0.68, transform: collapse, opacity: 1 },
        { offset: 0.8, transform: open, opacity: 1 },
        { offset: 0.92, transform: home, opacity: 0 },
        { offset: 1, transform: home, opacity: 0 },
      ].map((keyframe) => ({ ...keyframe, easing }));
      const effect = cursorAnimation.current?.effect;
      if (effect instanceof KeyframeEffect) effect.setKeyframes(keyframes);
      else {
        const options = { duration: 7200, iterations: Infinity };
        const animation = cursor.animate(keyframes, options);
        cursorAnimation.current = animation;
        const pulse = click.animate(
          [
            { offset: 0, opacity: 0, transform: "scale(0.5)" },
            { offset: 0.17, opacity: 0, transform: "scale(0.5)" },
            { offset: 0.19, opacity: 0.6, transform: "scale(1)" },
            { offset: 0.25, opacity: 0, transform: "scale(1.8)" },
            { offset: 0.62, opacity: 0, transform: "scale(0.5)" },
            { offset: 0.65, opacity: 0.6, transform: "scale(1)" },
            { offset: 0.71, opacity: 0, transform: "scale(1.8)" },
            { offset: 1, opacity: 0, transform: "scale(0.5)" },
          ].map((keyframe) => ({ ...keyframe, easing })),
          options,
        );
        pulse.startTime = animation.startTime;
        clickAnimation.current = pulse;
        if (
          !active ||
          document.hidden ||
          window.matchMedia("(prefers-reduced-motion: reduce)").matches
        ) {
          animation.pause();
          pulse.pause();
        }
      }
    };
    void measure();
    const observer = new ResizeObserver(() => {
      void measure();
    });
    observer.observe(root);
    return () => {
      stale = true;
      observer.disconnect();
    };
  }, [expanded, active]);
  useEffect(
    () => () => {
      cursorAnimation.current?.cancel();
      clickAnimation.current?.cancel();
      cursorAnimation.current = null;
      clickAnimation.current = null;
    },
    [],
  );
  useEffect(() => {
    const media = window.matchMedia("(prefers-reduced-motion: reduce)");
    let frameId = 0;
    let previousPhase: boolean | undefined;
    const tick = () => {
      const time = cursorAnimation.current?.currentTime;
      if (typeof time === "number") {
        // One timeline owns both the pointer and the real dock.
        const phase = time % 7200;
        const next = phase >= 1400 && phase < 4800;
        if (next !== previousPhase) {
          previousPhase = next;
          setExpanded(next);
        }
      }
      frameId = requestAnimationFrame(tick);
    };
    const update = () => {
      cancelAnimationFrame(frameId);
      previousPhase = undefined;
      const animate = active && !media.matches && !document.hidden;
      setPlaying(animate);
      for (const animation of [
        cursorAnimation.current,
        clickAnimation.current,
      ]) {
        if (animate) animation?.play();
        else animation?.pause();
      }
      if (animate) {
        if (!cursorAnimation.current) setExpanded(false);
        frameId = requestAnimationFrame(tick);
      } else setExpanded(true);
    };
    update();
    media.addEventListener("change", update);
    document.addEventListener("visibilitychange", update);
    return () => {
      cancelAnimationFrame(frameId);
      media.removeEventListener("change", update);
      document.removeEventListener("visibilitychange", update);
    };
  }, [active]);
  return (
    <div
      ref={frame}
      className="onboarding-dock-preview"
      data-animated={playing}
      role="img"
      aria-label="A cursor expands the dock to reveal conversations and the new chat button, then collapses it"
    >
      <div className="absolute inset-0" inert aria-hidden="true">
        <ChatBubbles
          entries={[
            { localId: "ideas", mode: "min" },
            { localId: "plans", mode: "min" },
            { localId: "notes", mode: "min" },
          ]}
          labels={{
            ideas: "A new idea",
            plans: "Weekend plans",
            notes: "My notes",
          }}
          icons={{ ideas: "sparkles", plans: "calendar", notes: "book" }}
          forks={{}}
          signals={{}}
          unread={{}}
          attention={{}}
          menus={{}}
          side="right"
          placement="center"
          collapsed={!expanded}
          onFoldedChange={noop}
          onToggle={noop}
          onClose={noop}
          onMenuAction={noop}
          onNewChat={noop}
        />
        <span className="onboarding-demo-cursor">
          <MousePointer2 fill="var(--color-fg)" stroke="var(--color-bg)" />
          <span className="onboarding-demo-click" />
        </span>
      </div>
    </div>
  );
}

const PREVIEW_TABS: WorkspaceTab[] = [
  { kind: "chat", name: "ideas", label: "A new idea" },
  { kind: "app", name: "notes", label: "My notes" },
  { kind: "browser", name: "inspiration", label: "Inspiration" },
];
const PREVIEW_ITEM: ItemCommon = {
  id: "preview",
  sessionId: "preview",
  turnId: null,
  attemptId: null,
  parentItemId: null,
  position: 0,
  status: "completed",
  nativeRef: null,
  createdAt: "2026-11-06T12:00:00.000Z",
  updatedAt: "2026-11-06T12:00:00.000Z",
  startedAt: null,
  endedAt: null,
};
const PREVIEW_TIMELINE: TimelineTurn[] = [
  {
    key: "preview",
    turn: null,
    entries: [
      {
        kind: "input",
        item: {
          ...PREVIEW_ITEM,
          id: "hello",
          kind: "user_message",
          author: { kind: "user", externalUserId: "preview" },
          text: "I have an idea. Can you help me bring it to life?",
          attachments: [],
          dispatch: "queue",
          attention: null,
          idempotencyKey: null,
          deliveredBy: null,
          causation: [],
        },
      },
      {
        kind: "reply",
        item: {
          ...PREVIEW_ITEM,
          id: "reply",
          position: 1,
          kind: "assistant_message",
          text: "Of course. Tell me what you have in mind, and we’ll make it happen.",
          agentId: null,
        },
        steps: [],
      },
    ],
  },
];
const noop = () => {};

/** Real tab, sidebar, chat timeline, and composer components, with local example data. */
export function WorkspacePreview({
  animateSidebars = false,
  active = true,
}: {
  animateSidebars?: boolean;
  active?: boolean;
}) {
  const frame = useRef<HTMLDivElement>(null);
  const [scale, setScale] = useState(1);
  useLayoutEffect(() => {
    const element = frame.current;
    if (!element) return;
    const observer = new ResizeObserver(([entry]) => {
      if (entry) setScale(entry.contentRect.width / 880);
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  return (
    <div
      ref={frame}
      className="onboarding-workspace-preview"
      data-preview-sidebars={animateSidebars || undefined}
      data-preview-active={active}
      aria-label={
        animateSidebars
          ? "A centered chat with both sidebars expanding and collapsing"
          : "Workspace theme preview"
      }
      role="img"
    >
      <div
        className="onboarding-workspace-model"
        style={{ transform: `scale(${scale})` }}
        inert
        aria-hidden="true"
      >
        <aside className="onboarding-preview-sidebar">
          <div className="onboarding-preview-project">
            <Folder className="size-4" />
            <span>My workspace</span>
            <ChevronDown className="ml-auto size-3" />
          </div>
          <div className="onboarding-preview-section">Favorites</div>
          <SidebarItemRow
            label="My notes"
            icon="NotebookPen"
            onOpen={noop}
            onAction={noop}
          />
          <SidebarItemRow
            label="Inspiration"
            icon="Globe"
            onOpen={noop}
            onAction={noop}
          />
          <div className="onboarding-preview-section">Chats</div>
          <SidebarItemRow
            label="A new idea"
            icon="MessageSquare"
            active
            onOpen={noop}
            onAction={noop}
          />
          <SidebarItemRow
            label="Weekend plans"
            icon="Calendar"
            onOpen={noop}
            onAction={noop}
          />
          <div className="mt-auto flex items-center gap-2 px-2 pb-2 text-fg-muted">
            <Settings className="size-3.5" />
            <span>Personal</span>
            <PanelLeft className="ml-auto size-3.5" />
          </div>
        </aside>
        <div className="onboarding-preview-main">
          <div className="flex h-10 shrink-0 items-center px-1">
            <WorkspaceTabBar
              tabs={PREVIEW_TABS}
              activeKey="chat:ideas"
              onSelect={noop}
              onClose={noop}
              onNew={noop}
            />
          </div>
          <ChatTimeline
            timeline={PREVIEW_TIMELINE}
            className="min-h-0 flex-1"
          />
          <div className="mx-5 mb-5 rounded-xl border border-border bg-bg-inset p-3">
            <ComposerInput
              placeholder="Ask anything…"
              ariaLabel="Example message"
              onChange={noop}
              className="min-h-10 text-[13px]"
            />
            <div className="mt-3 flex items-center gap-1.5 text-xs text-fg-faint">
              <Plus className="size-3.5" />
              <span>Agent</span>
              <ChevronDown className="size-3" />
              <span className="button-primary ml-auto grid size-6 place-items-center rounded-full p-0">
                <ArrowUp className="size-3.5" />
              </span>
            </div>
          </div>
        </div>
        <aside className="onboarding-preview-sidebar onboarding-preview-right">
          <div className="onboarding-preview-project">
            <span>In this workspace</span>
            <PanelRight className="ml-auto size-3.5" />
          </div>
          <div className="onboarding-preview-section">Files</div>
          <SidebarItemRow
            label="Ideas"
            icon="Folder"
            onOpen={noop}
            onAction={noop}
          />
          <SidebarItemRow
            label="Notes.md"
            icon="FileText"
            onOpen={noop}
            onAction={noop}
          />
          <div className="onboarding-preview-section">Apps</div>
          <SidebarItemRow
            label="My notes"
            icon="NotebookPen"
            onOpen={noop}
            onAction={noop}
          />
        </aside>
        <div className="onboarding-preview-dock">
          <span className="grid size-8 place-items-center rounded-full bg-bg-overlay text-accent">
            <ChatGlyph />
          </span>
          <span className="grid size-8 place-items-center">
            <Plus className="size-4 text-fg-faint" />
          </span>
        </div>
      </div>
    </div>
  );
}

function PalettePreview() {
  const bindings = useKeybindings();
  return (
    <div
      className="onboarding-palette-preview"
      inert
      role="img"
      aria-label="The command palette finds tabs, bookmarks, and commands"
    >
      <PaletteSurface
        input={
          <div className="flex h-14 w-full items-center gap-3 px-1 text-sm text-fg-faint">
            <Search className="size-4" />
            <span>Search or ask anything…</span>
          </div>
        }
      >
        <div className="p-2">
          {[
            { icon: MessageSquare, label: "A new idea", detail: "Open tab" },
            { icon: Star, label: "Inspiration", detail: "Bookmark" },
            {
              icon: Sparkles,
              label: "New chat",
              detail: formatBinding(bindings["new-floating-chat"]),
            },
          ].map((item, index) => (
            <OpenResourceButton
              key={item.label}
              isResource={false}
              onOpen={noop}
              className={`flex h-11 w-full items-center gap-3 rounded-lg px-3 text-left text-[13px] ${index === 0 ? "bg-bg-overlay text-fg" : "text-fg-muted"}`}
            >
              <item.icon className="size-4 text-fg-faint" />
              <span>{item.label}</span>
              <span className="ml-auto text-xs text-fg-faint">
                {item.detail}
              </span>
            </OpenResourceButton>
          ))}
        </div>
        <footer className="flex items-center gap-4 border-t border-border px-4 py-2 text-[11px] text-fg-faint">
          <span>@ modes</span>
          <span>&gt; commands</span>
          <span className="ml-auto">↵ open</span>
        </footer>
      </PaletteSurface>
    </div>
  );
}
