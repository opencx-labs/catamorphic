import { KeyRound } from "lucide-react";
import {
  type KeyboardEvent,
  type RefObject,
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import {
  originHost,
  PAGE_DIALOG_CREDENTIAL_LIMIT,
  PAGE_DIALOG_MESSAGE_LIMIT,
  type PageDialog,
  type PageDialogAnswer,
  pageDialogAsker,
} from "../../shared/page-dialogs.js";

/**
 * A page's dialog over its own tab (ADR 0226), as Chrome's tab-modal
 * dialogs are: the page under it dims and waits, while the rest of the
 * window (the toolbar, other tabs, the chat) carries on. A tab shows one
 * dialog at a time, in the order its page asked; a tab out of sight keeps
 * its dialog for when it comes back. The page's words are plain text under
 * a heading that names who asks, so a page cannot pass them off as Work's.
 */
export function PageDialogLayer({
  dialogs,
  page,
  active,
  focusRequest,
  onAnswer,
}: {
  /** What the page waits on, oldest first; the first one shows. */
  dialogs: PageDialog[];
  /** The page's element: focus there counts as the page's. */
  page: RefObject<HTMLElement | null>;
  /** The tab is the one in front: a new dialog may take focus. */
  active: boolean;
  /** Bumped when the dialog should take focus (its tab came forward). */
  focusRequest: number;
  /** `hadFocus`: the answer came from inside the dialog. */
  onAnswer: (answer: PageDialogAnswer, hadFocus: boolean) => void;
}) {
  const head = dialogs[0] ?? null;
  const headRef = useRef(head);
  headRef.current = head;
  // The dialog on screen stays through its exit, so a queue's next one
  // arrives after it leaves rather than on top of it.
  const [shown, setShown] = useState<PageDialog | null>(head);
  /** The dialog whose exit has finished, so the next may arrive. */
  const [exited, setExited] = useState<string | null>(null);
  const [mounted, setMounted] = useState(head !== null);
  useEffect(() => {
    if (head) setMounted(true);
  }, [head]);
  useEffect(() => {
    if (!head) return;
    // Nothing on screen, or what was has left: the next one arrives.
    if (!shown || (shown.id !== head.id && exited === shown.id)) setShown(head);
    // The same dialog, changed in place (a second "Leave site?").
    else if (shown.id === head.id && shown !== head) setShown(head);
  }, [head, shown, exited]);
  if (!mounted) return null;
  const leaving = !head || (shown !== null && shown.id !== head.id);
  return (
    <div
      data-testid="page-dialog-layer"
      // Over the page and the agent's hold on it (z-20), so the person can
      // always answer, but under the chat floating over the page (z-30),
      // which a page's question never blocks.
      className={`absolute inset-0 z-[25] grid place-items-center overflow-hidden p-4 ${
        head ? "animate-fade-in" : "pointer-events-none animate-fade-out"
      }`}
      onAnimationEnd={(event) => {
        if (
          event.target === event.currentTarget &&
          event.animationName === "fade-out" &&
          !headRef.current
        ) {
          setMounted(false);
          setShown(null);
          setExited(null);
        }
      }}
    >
      {/* The page waits under it: dimmed, and out of reach of the pointer.
          A press there keeps the keyboard in the dialog. */}
      <div
        aria-hidden
        className="absolute inset-0 bg-black/45"
        onMouseDown={(event) => {
          event.preventDefault();
          const panel = event.currentTarget.parentElement?.querySelector(
            '[data-testid="page-dialog"]:not([inert])',
          );
          if (
            panel instanceof HTMLElement &&
            !panel.contains(document.activeElement)
          )
            panel.focus({ preventScroll: true });
        }}
      />
      {shown && (
        <PageDialogPanel
          key={shown.id}
          dialog={shown}
          leaving={leaving}
          page={page}
          active={active}
          focusRequest={focusRequest}
          onAnswer={onAnswer}
          onExited={() => setExited(shown.id)}
        />
      )}
    </div>
  );
}

function PageDialogPanel({
  dialog,
  leaving,
  page,
  active,
  focusRequest,
  onAnswer,
  onExited,
}: {
  dialog: PageDialog;
  leaving: boolean;
  page: RefObject<HTMLElement | null>;
  active: boolean;
  focusRequest: number;
  onAnswer: (answer: PageDialogAnswer, hadFocus: boolean) => void;
  onExited: () => void;
}) {
  const ids = {
    title: useId(),
    message: useId(),
    username: useId(),
    password: useId(),
    suppress: useId(),
  };
  const panelRef = useRef<HTMLFormElement>(null);
  const firstRef = useRef<HTMLElement | null>(null);
  const messageRef = useRef<HTMLDivElement>(null);
  const [text, setText] = useState(dialog.defaultValue);
  // An agent filling the prompt's field: the person sees it go in.
  useEffect(() => {
    setText(dialog.defaultValue);
  }, [dialog.defaultValue]);
  const [suppress, setSuppress] = useState(false);
  const [username, setUsername] = useState(dialog.auth?.username ?? "");
  const [password, setPassword] = useState("");
  const [scrolls, setScrolls] = useState(false);
  const answered = useRef(false);

  const prompt = dialog.kind === "prompt";
  const focusFirst = useCallback(() => {
    const first = firstRef.current;
    if (!first) return;
    first.focus({ preventScroll: true });
    if (first instanceof HTMLInputElement && prompt) first.select();
  }, [prompt]);
  // Arriving, it takes focus from the page (or from nothing, or from the
  // dialog before it), never from wherever else the person is; whether its
  // tab is in front is read as it arrives.
  const activeRef = useRef(active);
  activeRef.current = active;
  useLayoutEffect(() => {
    const focused = document.activeElement;
    if (
      activeRef.current &&
      (focused === null ||
        focused === document.body ||
        focused === page.current)
    )
      focusFirst();
  }, [focusFirst, page]);
  const lastFocusRequest = useRef(focusRequest);
  useEffect(() => {
    if (focusRequest === lastFocusRequest.current) return;
    lastFocusRequest.current = focusRequest;
    focusFirst();
  }, [focusRequest, focusFirst]);
  // A long message scrolls, and takes keyboard focus to do so.
  useLayoutEffect(() => {
    const message = messageRef.current;
    setScrolls(
      dialog.message !== "" &&
        !!message &&
        message.scrollHeight > message.clientHeight + 1,
    );
  }, [dialog.message]);

  const answer = (accept: boolean, extra: Partial<PageDialogAnswer> = {}) => {
    if (answered.current || leaving) return;
    answered.current = true;
    const hadFocus =
      panelRef.current?.contains(document.activeElement) ?? false;
    onAnswer(
      {
        id: dialog.id,
        accept,
        ...(suppress ? { suppress: true } : {}),
        ...(dialog.kind === "prompt" && accept ? { text } : {}),
        ...(dialog.kind === "auth" && accept && !extra.credentialId
          ? { username, password }
          : {}),
        ...extra,
      },
      hadFocus,
    );
  };

  const onKeyDown = (event: KeyboardEvent<HTMLFormElement>) => {
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      // An alert has only OK.
      answer(dialog.kind === "alert");
      return;
    }
    // Focus on the dialog itself (after a press on its text or the dim
    // page): Enter is still OK.
    if (event.key === "Enter" && event.target === event.currentTarget) {
      event.preventDefault();
      answer(true);
      return;
    }
    if (event.key !== "Tab" || !panelRef.current) return;
    // Tab stays in the dialog, as in the page it covers.
    const focusable = Array.from(
      panelRef.current.querySelectorAll<HTMLElement>(
        'button:not([disabled]), input:not([disabled]), [tabindex="0"]',
      ),
    );
    const first = focusable[0];
    const last = focusable.at(-1);
    if (!first || !last) return;
    if (document.activeElement === panelRef.current) {
      event.preventDefault();
      (event.shiftKey ? last : first).focus();
    } else if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  };

  const host = originHost(dialog.origin);
  const auth = dialog.auth;
  const script =
    dialog.kind === "alert" ||
    dialog.kind === "confirm" ||
    dialog.kind === "prompt";
  const title =
    dialog.kind === "beforeunload"
      ? dialog.reload
        ? "Reload site?"
        : "Leave site?"
      : dialog.kind === "auth"
        ? "Sign in"
        : pageDialogAsker(dialog);
  const accept =
    dialog.kind === "beforeunload"
      ? dialog.reload
        ? "Reload"
        : "Leave"
      : dialog.kind === "auth"
        ? "Sign in"
        : "OK";

  return (
    <form
      ref={panelRef}
      role={prompt || auth ? "dialog" : "alertdialog"}
      aria-labelledby={ids.title}
      aria-describedby={dialog.message ? ids.message : undefined}
      data-testid="page-dialog"
      data-kind={dialog.kind}
      // A press on its text keeps the keyboard here, not in the app.
      tabIndex={-1}
      inert={leaving ? true : undefined}
      onKeyDown={onKeyDown}
      onSubmit={(event) => {
        event.preventDefault();
        answer(true);
      }}
      onAnimationEnd={(event) => {
        if (
          event.target === event.currentTarget &&
          event.animationName === "modal-out"
        )
          onExited();
      }}
      className={`relative flex max-h-full w-[420px] max-w-full flex-col overflow-hidden rounded-xl border border-border bg-bg-raised shadow-2xl outline-none ${
        leaving ? "animate-modal-out" : "animate-modal-in"
      }`}
    >
      <div className="min-h-0 overflow-y-auto overscroll-contain px-5 pt-5">
        <h2
          id={ids.title}
          className="break-words text-sm font-semibold text-fg"
          data-testid="page-dialog-title"
        >
          {title}
        </h2>
        {!script && host && (
          // Wrapped, never cut: the end of a host names the site.
          <p
            className="mt-0.5 text-xs text-fg-muted [overflow-wrap:anywhere]"
            data-testid="page-dialog-origin"
          >
            {auth?.proxy ? `The proxy ${host}` : host}
          </p>
        )}
        {auth && dialog.embedded && (
          <p
            className="mt-0.5 text-xs text-fg-muted"
            data-testid="page-dialog-embedded"
          >
            Asked by a page embedded in this one.
          </p>
        )}
        {script && dialog.message && (
          <div
            ref={messageRef}
            id={ids.message}
            data-testid="page-dialog-message"
            tabIndex={scrolls ? 0 : undefined}
            className="focus-ring-inset mt-2 max-h-[min(40vh,320px)] overflow-y-auto overscroll-contain whitespace-pre-wrap rounded-sm text-[13px] leading-5 text-fg [overflow-wrap:anywhere]"
          >
            {dialog.message}
          </div>
        )}
        {dialog.kind === "beforeunload" && (
          <p className="mt-2 text-[13px] leading-5 text-fg">
            Changes you made may not be saved.
          </p>
        )}
        {prompt && (
          <input
            ref={(node) => {
              firstRef.current = node;
            }}
            aria-labelledby={ids.title}
            aria-describedby={dialog.message ? ids.message : undefined}
            data-testid="page-dialog-input"
            value={text}
            onChange={(event) => setText(event.target.value)}
            maxLength={PAGE_DIALOG_MESSAGE_LIMIT}
            spellCheck={false}
            autoComplete="off"
            className="field mt-3 h-8 w-full rounded-md px-2.5 text-[13px]"
          />
        )}
        {auth && (
          <AuthFields
            auth={auth}
            ids={ids}
            username={username}
            password={password}
            onUsername={setUsername}
            onPassword={setPassword}
            firstRef={firstRef}
            onSaved={(credentialId) => answer(true, { credentialId })}
          />
        )}
        {dialog.canSuppress && (
          <label
            htmlFor={ids.suppress}
            className="mt-3 flex w-fit cursor-pointer items-center gap-2 text-xs text-fg-muted"
          >
            <input
              id={ids.suppress}
              type="checkbox"
              data-testid="page-dialog-suppress"
              checked={suppress}
              onChange={(event) => setSuppress(event.target.checked)}
            />
            Don't let this page show more dialogs
          </label>
        )}
      </div>
      <footer className="mt-4 flex shrink-0 justify-end gap-2 border-t border-border px-5 py-3.5">
        {dialog.kind !== "alert" && (
          <button
            type="button"
            onClick={() => answer(false)}
            className="button-ghost"
            data-testid="page-dialog-cancel"
          >
            Cancel
          </button>
        )}
        <button
          ref={(node) => {
            if (!prompt && !auth) firstRef.current = node;
          }}
          type="submit"
          className="button-primary"
          data-testid="page-dialog-accept"
        >
          {accept}
        </button>
      </footer>
    </form>
  );
}

function AuthFields({
  auth,
  ids,
  username,
  password,
  onUsername,
  onPassword,
  firstRef,
  onSaved,
}: {
  auth: NonNullable<PageDialog["auth"]>;
  ids: { username: string; password: string };
  username: string;
  password: string;
  onUsername: (value: string) => void;
  onPassword: (value: string) => void;
  firstRef: RefObject<HTMLElement | null>;
  onSaved: (credentialId: string) => void;
}) {
  const takeFirst = (field: "username" | "password") =>
    field === (auth.username ? "password" : "username")
      ? (node: HTMLInputElement | null) => {
          firstRef.current = node;
        }
      : undefined;
  return (
    <>
      {auth.realm && (
        <p
          className="mt-2 break-words text-[13px] leading-5 text-fg"
          data-testid="page-dialog-realm"
        >
          {auth.proxy ? "The proxy says" : "The site says"} “{auth.realm}”
        </p>
      )}
      {auth.insecure && (
        <p className="mt-1 text-xs text-fg-muted">
          Your connection to this site is not private.
        </p>
      )}
      {auth.retry && (
        <p className="mt-1 text-xs text-danger" role="alert">
          That username and password were not accepted.
        </p>
      )}
      {auth.saved.length > 0 && (
        <div className="mt-3" data-testid="page-dialog-saved">
          <p className="mb-1 text-[11px] text-fg-muted">Saved sign-ins</p>
          <div className="flex flex-col">
            {auth.saved.map((login) => (
              <button
                key={login.id}
                type="button"
                onClick={() => onSaved(login.id)}
                className="focus-ring-inset flex h-8 w-full cursor-pointer items-center gap-2 rounded-md px-2 text-left text-[13px] text-fg transition-colors duration-150 hover:bg-bg-overlay"
              >
                <KeyRound className="size-3.5 shrink-0 text-fg-faint" />
                <span className="truncate">
                  {login.username || "No username"}
                </span>
              </button>
            ))}
          </div>
        </div>
      )}
      <div className="mt-3 space-y-3">
        <label className="block" htmlFor={ids.username}>
          <span className="mb-1 block text-[11px] text-fg-muted">Username</span>
          <input
            ref={takeFirst("username")}
            id={ids.username}
            data-testid="page-dialog-username"
            value={username}
            onChange={(event) => onUsername(event.target.value)}
            maxLength={PAGE_DIALOG_CREDENTIAL_LIMIT}
            autoComplete="off"
            spellCheck={false}
            className="field h-8 w-full rounded-md px-2.5 text-[13px]"
          />
        </label>
        <label className="block" htmlFor={ids.password}>
          <span className="mb-1 block text-[11px] text-fg-muted">Password</span>
          <input
            ref={takeFirst("password")}
            id={ids.password}
            type="password"
            data-testid="page-dialog-password"
            value={password}
            onChange={(event) => onPassword(event.target.value)}
            maxLength={PAGE_DIALOG_CREDENTIAL_LIMIT}
            autoComplete="off"
            spellCheck={false}
            className="field h-8 w-full rounded-md px-2.5 text-[13px]"
          />
        </label>
      </div>
    </>
  );
}
