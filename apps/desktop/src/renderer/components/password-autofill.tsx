import { KeyRound, WandSparkles } from "lucide-react";
import {
  type ReactNode,
  type RefObject,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import type { LoginFieldKind } from "../../shared/login-fields.js";
import { desktopApi, type SavedCredential } from "../lib/desktop-api.js";
import { MaskedPassword } from "./password-editor.js";
import { SiteFavicon } from "./site-favicon.js";

/** The slice of the <webview> element suggestions need. */
export interface AutofillGuest {
  focus: () => void;
  getURL: () => string;
  getWebContentsId: () => number;
  getZoomFactor?: () => number;
  send: (channel: string, payload: unknown) => void;
}

interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

type Item =
  | { kind: "credential"; credential: SavedCredential }
  | { kind: "generated"; password: string };

interface Suggestions {
  fieldId: string;
  kind: LoginFieldKind;
  origin: string;
  /** The field, in the page container's coordinates. */
  field: Rect;
  items: Item[];
  /** What the field holds; filters usernames as the user types. */
  value: string;
}

const MIN_WIDTH = 260;
const MAX_WIDTH = 380;
const GAP = 4;

function isRect(value: unknown): value is Rect {
  if (!value || typeof value !== "object") return false;
  const rect = value as Record<string, unknown>;
  return ["x", "y", "width", "height"].every(
    (key) => typeof rect[key] === "number",
  );
}

function httpOrigin(url: string): string | null {
  try {
    const parsed = new URL(url);
    return parsed.protocol === "http:" || parsed.protocol === "https:"
      ? parsed.origin
      : null;
  } catch {
    return null;
  }
}

function visibleItems(suggestions: Suggestions): Item[] {
  if (suggestions.kind !== "username" || !suggestions.value) {
    return suggestions.items;
  }
  const typed = suggestions.value.toLocaleLowerCase();
  return suggestions.items.filter(
    (item) =>
      item.kind !== "credential" ||
      item.credential.username.toLocaleLowerCase().startsWith(typed),
  );
}

/**
 * Chrome's autofill dropdown for a browser tab: saved logins under a
 * username or password field when the user clicks it, a generated
 * password under a new-password field. The guest page reports the field
 * and forwards the keys the list owns (arrows, Enter on a highlighted
 * row, Escape); main fills the chosen login, so secrets never pass
 * through here, except the suggested password shown to be read.
 */
export function usePasswordAutofill({
  profileId,
  guestRef,
  containerRef,
  faviconUrl,
  onManage,
}: {
  profileId: string;
  guestRef: RefObject<AutofillGuest | null>;
  containerRef: RefObject<HTMLElement | null>;
  faviconUrl: string | null;
  onManage?: () => void;
}): {
  /** Routes a guest `ipc-message`; true when it was an autofill message. */
  handleGuestMessage: (channel: string, args: unknown[]) => boolean;
  close: () => void;
  overlay: ReactNode;
} {
  const [suggestions, setSuggestions] = useState<Suggestions | null>(null);
  const [open, setOpen] = useState(false);
  const [highlight, setHighlight] = useState(-1);
  const sequence = useRef(0);
  const suggestionsRef = useRef(suggestions);
  suggestionsRef.current = suggestions;
  const openRef = useRef(open);
  openRef.current = open;
  const highlightRef = useRef(highlight);
  highlightRef.current = highlight;
  // Pressing the list moves focus out of the page, which blurs its field
  // before the click lands; that blur must not close the list.
  const pressingList = useRef(false);

  const close = useCallback(() => {
    sequence.current++;
    setOpen(false);
    setHighlight(-1);
  }, []);

  // The page owns its keys again once the list closes, and Enter only
  // while a row is highlighted (otherwise Enter submits the form).
  useEffect(() => {
    try {
      guestRef.current?.send("catamorphic:autofill-open", {
        open,
        highlighted: open && highlight >= 0,
      });
    } catch {
      // Guest detached; its next page starts closed.
    }
  }, [open, highlight, guestRef]);

  const show = useCallback(
    async (payload: Record<string, unknown>) => {
      const guest = guestRef.current;
      const { fieldId, kind, rect, value } = payload;
      if (
        !guest ||
        typeof fieldId !== "string" ||
        (kind !== "username" &&
          kind !== "current-password" &&
          kind !== "new-password") ||
        !isRect(rect)
      )
        return;
      const origin = httpOrigin(guest.getURL());
      if (!origin) return;
      const zoom = guest.getZoomFactor?.() ?? 1;
      const field = {
        x: rect.x * zoom,
        y: rect.y * zoom,
        width: rect.width * zoom,
        height: rect.height * zoom,
      };
      const current = ++sequence.current;
      let items: Item[];
      if (kind === "new-password") {
        // Offer a password only while the field is empty.
        if (typeof value === "string" && value) return close();
        const suggestion = await desktopApi.browserPasswordSuggest({
          profileId,
          guestId: guest.getWebContentsId(),
        });
        items = suggestion
          ? [{ kind: "generated", password: suggestion.password }]
          : [];
      } else {
        const credentials = await desktopApi.vaultList({ profileId, origin });
        items = credentials.map((credential) => ({
          kind: "credential",
          credential,
        }));
      }
      if (current !== sequence.current) return;
      const next: Suggestions = {
        fieldId,
        kind,
        origin,
        field,
        items,
        value: typeof value === "string" ? value : "",
      };
      if (visibleItems(next).length === 0) return close();
      setSuggestions(next);
      setHighlight(-1);
      setOpen(true);
    },
    [profileId, guestRef, close],
  );

  // A press anywhere else in the app closes the list, as a press in the
  // page does (the page reports its field's blur).
  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      if (
        !(event.target instanceof Element) ||
        !event.target.closest('[data-testid="password-suggestions"]')
      )
        close();
    };
    document.addEventListener("pointerdown", onPointerDown, true);
    return () =>
      document.removeEventListener("pointerdown", onPointerDown, true);
  }, [open, close]);

  const pick = useCallback(
    (item: Item) => {
      const guest = guestRef.current;
      const current = suggestionsRef.current;
      close();
      if (!guest || !current) return;
      // Typing continues in the page, as after any autofill.
      guest.focus();
      const guestId = guest.getWebContentsId();
      if (item.kind === "generated") {
        void desktopApi.browserPasswordUseSuggested({
          profileId,
          guestId,
          fieldId: current.fieldId,
        });
        return;
      }
      void desktopApi.browserCredentialFill({
        profileId,
        guestId,
        credentialId: item.credential.id,
        fieldId: current.fieldId,
        origin: current.origin,
      });
    },
    [profileId, guestRef, close],
  );

  const handleGuestMessage = useCallback(
    (channel: string, args: unknown[]) => {
      const payload =
        args[0] && typeof args[0] === "object"
          ? (args[0] as Record<string, unknown>)
          : {};
      switch (channel) {
        case "catamorphic:autofill-show":
          void show(payload).catch(() => close());
          return true;
        case "catamorphic:autofill-hide":
          if (payload.reason !== "blur" || !pressingList.current) close();
          return true;
        case "catamorphic:autofill-input": {
          const current = suggestionsRef.current;
          if (!current || payload.fieldId !== current.fieldId) return true;
          const value = typeof payload.value === "string" ? payload.value : "";
          if (current.kind === "new-password" && value) {
            close();
            return true;
          }
          const next = { ...current, value };
          setSuggestions(next);
          setHighlight(-1);
          if (visibleItems(next).length === 0) close();
          else if (current.kind === "username") setOpen(true);
          return true;
        }
        case "catamorphic:autofill-key": {
          const current = suggestionsRef.current;
          if (!current || !openRef.current) return true;
          const items = visibleItems(current);
          if (payload.key === "ArrowDown")
            setHighlight((index) => (index + 1) % items.length);
          else if (payload.key === "ArrowUp")
            setHighlight((index) =>
              index <= 0 ? items.length - 1 : index - 1,
            );
          else if (payload.key === "Escape") close();
          else if (payload.key === "Enter") {
            const item = items[highlightRef.current];
            if (item) pick(item);
            else close();
          }
          return true;
        }
        default:
          return false;
      }
    },
    [show, close, pick],
  );

  const overlay = suggestions ? (
    <SuggestionList
      suggestions={suggestions}
      open={open}
      highlight={highlight}
      containerRef={containerRef}
      faviconUrl={faviconUrl}
      onHighlight={setHighlight}
      onPick={pick}
      onPress={(pressing) => {
        pressingList.current = pressing;
      }}
      onManage={
        onManage
          ? () => {
              close();
              onManage();
            }
          : undefined
      }
      onExited={() => setSuggestions(null)}
    />
  ) : null;

  return { handleGuestMessage, close, overlay };
}

function SuggestionList({
  suggestions,
  open,
  highlight,
  containerRef,
  faviconUrl,
  onHighlight,
  onPick,
  onPress,
  onManage,
  onExited,
}: {
  suggestions: Suggestions;
  open: boolean;
  highlight: number;
  containerRef: RefObject<HTMLElement | null>;
  faviconUrl: string | null;
  onHighlight: (index: number) => void;
  onPick: (item: Item) => void;
  onPress: (pressing: boolean) => void;
  onManage?: () => void;
  onExited: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const items = visibleItems(suggestions);
  const { field } = suggestions;
  const width = Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, field.width));
  const [position, setPosition] = useState({
    left: field.x,
    top: field.y + field.height + GAP,
    above: false,
  });

  // Under the field, kept inside the page; above it when the page has
  // no room below (a sign-in form at the bottom of the window).
  useLayoutEffect(() => {
    const container = containerRef.current?.getBoundingClientRect();
    const height = ref.current?.offsetHeight ?? 0;
    if (!container) return;
    const left = Math.max(8, Math.min(field.x, container.width - width - 8));
    const below = field.y + field.height + GAP;
    const above = below + height > container.height - 8 && field.y > height;
    setPosition({
      left,
      top: above ? field.y - GAP - height : below,
      above,
    });
  }, [field, width, containerRef]);

  return (
    <div
      ref={ref}
      role="listbox"
      aria-label="Password suggestions"
      data-testid="password-suggestions"
      data-open={open}
      // The page keeps focus: its field still owns typing and the keys.
      onMouseDown={(event) => event.preventDefault()}
      onPointerDown={() => onPress(true)}
      onPointerUp={() => onPress(false)}
      onPointerLeave={() => onPress(false)}
      onAnimationEnd={(event) => {
        if (event.animationName === "pop-out" && !open) onExited();
      }}
      style={{ left: position.left, top: position.top, width }}
      className={`absolute z-30 overflow-hidden rounded-lg border border-border bg-bg-overlay p-1 shadow-2xl ${
        position.above ? "origin-bottom" : "origin-top"
      } ${open ? "animate-pop-in" : "pointer-events-none animate-pop-out"}`}
    >
      {items.map((item, index) => {
        const active = index === highlight;
        return (
          <div
            key={item.kind === "credential" ? item.credential.id : "generated"}
            role="option"
            tabIndex={-1}
            aria-selected={active}
            data-testid={
              item.kind === "credential"
                ? "password-suggestion"
                : "password-suggestion-generated"
            }
            onMouseEnter={() => onHighlight(index)}
            onMouseLeave={() => onHighlight(-1)}
            onClick={() => onPick(item)}
            onKeyDown={() => undefined}
            className={`flex cursor-pointer items-center gap-2.5 rounded-md px-2 py-1.5 transition-colors duration-150 ${
              active ? "bg-bg-raised" : ""
            }`}
          >
            {item.kind === "credential" ? (
              <>
                <SiteFavicon
                  url={item.credential.origin}
                  faviconUrl={faviconUrl}
                  className="size-4"
                />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[13px] text-fg">
                    {item.credential.username || "No username"}
                  </span>
                  <MaskedPassword className="mt-1 text-fg-faint" />
                </span>
              </>
            ) : (
              <>
                <WandSparkles className="size-4 shrink-0 text-accent" />
                <span className="min-w-0 flex-1">
                  <span className="block text-[13px] text-fg">
                    Use suggested password
                  </span>
                  <span
                    className="block truncate font-mono text-[12px] leading-5 text-fg-muted"
                    data-testid="suggested-password"
                  >
                    {item.password}
                  </span>
                </span>
              </>
            )}
          </div>
        );
      })}
      {items[0]?.kind === "generated" && (
        <p className="px-2 pb-1.5 pt-0.5 text-[11px] leading-4 text-fg-faint">
          Saved to your passwords when you continue.
        </p>
      )}
      {onManage && (
        <>
          <div className="-mx-1 my-1 border-t border-border" />
          <button
            type="button"
            tabIndex={-1}
            onClick={onManage}
            className="flex h-7 w-full cursor-pointer items-center gap-2.5 rounded-md px-2 text-left text-[12px] text-fg-muted transition-colors duration-150 hover:bg-bg-raised hover:text-fg"
          >
            <KeyRound className="size-3.5 shrink-0" />
            Manage passwords
          </button>
        </>
      )}
    </div>
  );
}
