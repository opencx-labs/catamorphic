import { contextBridge, ipcRenderer, webFrame } from "electron";
import { matchesShortcut } from "../shared/keybindings.js";
import {
  classifyPasswordField,
  type FieldDescriptor,
  isStandaloneUsername,
  isUsernameCandidate,
} from "../shared/login-fields.js";
import { openModeFromEvent } from "../shared/open-mode.js";
import { fieldKeepsKey } from "../shared/text-field.js";
import { installPageDialogs } from "./page-dialogs.js";

/**
 * Guest preload for browser-tab webviews. Runs inside untrusted pages with
 * context isolation, in every frame of the page (main/browser.ts turns on
 * subframes for tabs) so that each frame asks through Work's dialogs
 * (page-dialogs.ts, ADR 0227); everything else is the top frame's.
 * Credential secrets travel directly between this guest and the trusted
 * main process; the embedding renderer receives metadata and status only.
 * (Chrome's client-hint brands and passkeys come from the browsing
 * session's preload, session.ts, which a tab's sign-in popups run too.)
 * Jobs, all Chrome-like:
 *  - place password suggestions under login fields and report submitted
 *    logins (offer-to-save, auto-save of generated passwords),
 *  - fill saved or generated passwords on command.
 */

const topFrame = window.top === window;
installPageDialogs({ top: topFrame });
// The host sees no input inside the page, so every frame tells it of the
// person's presses: a press in the page, an embedded frame's included, is a
// press outside the floating chat, a popover or a hover card. Presses the
// page's own scripts synthesize are not the person's.
window.addEventListener(
  "pointerdown",
  (event) => {
    if (event.isTrusted) ipcRenderer.sendToHost("catamorphic:page-press");
  },
  { capture: true, passive: true },
);
if (topFrame) installTopFrame();

function installTopFrame(): void {
  /**
   * Page notifications go through the main process so macOS shows the site
   * under the title, as Chrome does, and so the site's own notification
   * permission (site settings) is what decides. The page keeps the standard
   * `Notification` surface: permission reads the site's real state
   * (default / granted / denied), requestPermission prompts through the
   * browser, and click/show/close events reach the page. Service-worker
   * notifications are outside this path.
   */
  type NotificationPermissionState = "default" | "granted" | "denied";
  interface GuestNotificationEvent {
    id: number;
    type: "show" | "click" | "close" | "error";
  }
  const notificationListeners = new Set<
    (event: GuestNotificationEvent) => void
  >();
  ipcRenderer.on(
    "catamorphic:guest-notification-event",
    (_event, payload: GuestNotificationEvent) => {
      for (const listener of notificationListeners) listener(payload);
    },
  );
  contextBridge.exposeInMainWorld("__workNotifications", {
    permission: (): NotificationPermissionState =>
      ipcRenderer.sendSync("catamorphic:guest-notification-permission"),
    show: (input: {
      title: string;
      body: string;
      tag: string;
      silent: boolean;
    }): Promise<number | null> =>
      ipcRenderer.invoke("catamorphic:guest-notification-show", input),
    close: (id: number): void => {
      ipcRenderer.send("catamorphic:guest-notification-close", id);
    },
    subscribe: (listener: (event: GuestNotificationEvent) => void): void => {
      notificationListeners.add(listener);
    },
  });
  if (typeof contextBridge.executeInMainWorld === "function") {
    contextBridge.executeInMainWorld({
      func: () => {
        interface Bridge {
          permission: () => NotificationPermissionState;
          show: (input: {
            title: string;
            body: string;
            tag: string;
            silent: boolean;
          }) => Promise<number | null>;
          close: (id: number) => void;
          subscribe: (
            listener: (event: GuestNotificationEvent) => void,
          ) => void;
        }
        const exposed = (window as Window & { __workNotifications?: Bridge })
          .__workNotifications;
        const Native = window.Notification;
        if (!exposed || !Native) return;
        const bridge: Bridge = exposed;
        const registry = new Map<number, WorkNotification>();
        type Handler = ((event: Event) => void) | null;
        class WorkNotification extends EventTarget {
          readonly title: string;
          readonly body: string;
          readonly tag: string;
          readonly icon: string;
          readonly badge = "";
          readonly image = "";
          readonly dir = "auto";
          readonly lang = "";
          readonly data: unknown;
          readonly silent: boolean | null;
          readonly requireInteraction: boolean;
          readonly timestamp = Date.now();
          onclick: Handler = null;
          onshow: Handler = null;
          onclose: Handler = null;
          onerror: Handler = null;
          private id: number | null = null;
          private closed = false;
          constructor(title: string, options: NotificationOptions = {}) {
            super();
            this.title = String(title);
            this.body = options.body ?? "";
            this.tag = options.tag ?? "";
            this.icon = options.icon ?? "";
            this.data = options.data;
            this.silent = options.silent ?? null;
            this.requireInteraction = options.requireInteraction ?? false;
            void bridge
              .show({
                title: this.title,
                body: this.body,
                tag: this.tag,
                silent: this.silent === true,
              })
              .then((id) => {
                if (id === null) {
                  this.fire("error");
                  return;
                }
                this.id = id;
                registry.set(id, this);
                // Closed before the id arrived: close it now.
                if (this.closed) bridge.close(id);
              });
          }
          fire(type: "show" | "click" | "close" | "error"): void {
            const event = new Event(type);
            this.dispatchEvent(event);
            const handler = this[`on${type}` as const];
            if (typeof handler === "function") handler.call(this, event);
          }
          close(): void {
            this.closed = true;
            if (this.id !== null) bridge.close(this.id);
          }
          static get permission(): NotificationPermissionState {
            return bridge.permission();
          }
          static get maxActions(): number {
            return 0;
          }
          static requestPermission(
            callback?: (permission: NotificationPermissionState) => void,
          ): Promise<NotificationPermissionState> {
            const request = Native.requestPermission().then(() =>
              bridge.permission(),
            );
            if (callback) void request.then(callback);
            return request;
          }
        }
        bridge.subscribe(({ id, type }) => {
          const notification = registry.get(id);
          if (!notification) return;
          notification.fire(type);
          if (type === "close" || type === "error") registry.delete(id);
        });
        Object.defineProperty(window, "Notification", {
          value: WorkNotification,
          configurable: true,
          writable: true,
        });
      },
      args: [],
    });
  }

  // Electron's BrowserWindow `app-command` event covers browser mouse buttons
  // on Windows/Linux. macOS delivers the auxiliary buttons to the guest page,
  // so forward them to the trusted host instead of leaving them inert.
  if (process.platform === "darwin") {
    window.addEventListener(
      "mouseup",
      (event) => {
        const direction =
          event.button === 3 ? "back" : event.button === 4 ? "forward" : null;
        if (!direction) return;
        event.preventDefault();
        ipcRenderer.sendToHost("catamorphic:browser-mouse-history", {
          direction,
        });
      },
      { capture: true },
    );
  }

  /**
   * Two-finger history swipe, as Chrome does it: horizontal trackpad scroll
   * that nothing under the pointer can consume accumulates toward a
   * threshold; crossing it navigates. The host draws the arrow that grows
   * with the gesture. macOS delivers two-finger swipes as wheel events with
   * pixel deltas (three-finger swipes arrive as the window's `swipe` event
   * and are handled by the main process).
   */
  const SWIPE_THRESHOLD_PX = 220;
  const SWIPE_IDLE_MS = 200;
  let swipeSum = 0;
  let swipeArmed = true;
  let swipeTimer: ReturnType<typeof setTimeout> | undefined;
  let swipeShown: "back" | "forward" | null = null;

  const reportSwipe = (
    direction: "back" | "forward" | null,
    progress: number,
  ) => {
    if (direction === null && swipeShown === null) return;
    swipeShown = direction;
    ipcRenderer.sendToHost("catamorphic:browser-swipe", {
      direction,
      progress,
    });
  };

  const resetSwipe = () => {
    clearTimeout(swipeTimer);
    swipeTimer = undefined;
    swipeSum = 0;
    swipeArmed = true;
    reportSwipe(null, 0);
  };

  /** Can anything from the target up to the document scroll horizontally that way? */
  const scrollableToward = (target: EventTarget | null, deltaX: number) => {
    let node = target instanceof Element ? target : null;
    while (node) {
      const style = getComputedStyle(node);
      const overflow = style.overflowX;
      const scrolls =
        node === document.documentElement ||
        node === document.body ||
        overflow === "auto" ||
        overflow === "scroll" ||
        overflow === "overlay";
      if (scrolls && node.scrollWidth > node.clientWidth + 1) {
        if (deltaX < 0 && node.scrollLeft > 0) return true;
        if (
          deltaX > 0 &&
          node.scrollLeft + node.clientWidth < node.scrollWidth - 1
        )
          return true;
      }
      node = node.parentElement;
    }
    return false;
  };

  window.addEventListener(
    "wheel",
    (event) => {
      if (event.deltaMode !== WheelEvent.DOM_DELTA_PIXEL) return;
      const { deltaX, deltaY } = event;
      // A vertical scroll, or a mixed one, is not a history gesture.
      if (Math.abs(deltaX) < 2 || Math.abs(deltaX) < Math.abs(deltaY) * 2) {
        if (swipeSum !== 0) resetSwipe();
        return;
      }
      if (scrollableToward(event.target, deltaX)) {
        if (swipeSum !== 0) resetSwipe();
        return;
      }
      clearTimeout(swipeTimer);
      swipeTimer = setTimeout(resetSwipe, SWIPE_IDLE_MS);
      // A change of direction mid-gesture starts over.
      if (swipeSum !== 0 && Math.sign(swipeSum) !== Math.sign(deltaX))
        swipeSum = 0;
      swipeSum += deltaX;
      // Fingers moving right (negative deltaX) pull the previous page in.
      const direction = swipeSum < 0 ? "back" : "forward";
      const progress = Math.min(1, Math.abs(swipeSum) / SWIPE_THRESHOLD_PX);
      if (!swipeArmed) return;
      reportSwipe(direction, progress);
      if (progress >= 1) {
        swipeArmed = false;
        // The navigation replaces this page (and its idle timer): clear the
        // arrow now rather than leaving it to a world that is going away.
        reportSwipe(null, 0);
        ipcRenderer.sendToHost("catamorphic:browser-mouse-history", {
          direction,
        });
      }
    },
    { capture: true, passive: true },
  );

  /**
   * Passwords. The page tells the host where a login field is when the
   * user clicks it (or tabs into a new-password field), so the host can
   * draw suggestions under it; keys the suggestions own while open come
   * back to the host. Submitted logins go to the trusted main process, and
   * so does every report of the page's password forms, which is how main
   * decides whether a sign-in worked. Secrets arrive only from main, to be
   * written into the fields.
   */
  type LoginFieldKind = "username" | "current-password" | "new-password";

  interface LoginGroup {
    /** The form, or the document for formless (script-driven) sign-ins. */
    scope: ParentNode;
    username: HTMLInputElement | null;
    passwords: HTMLInputElement[];
  }

  const fieldIds = new WeakMap<HTMLInputElement, string>();
  const fieldsById = new Map<string, WeakRef<HTMLInputElement>>();
  let nextFieldId = 1;
  function fieldId(input: HTMLInputElement): string {
    let id = fieldIds.get(input);
    if (!id) {
      id = `login-field-${nextFieldId++}`;
      fieldIds.set(input, id);
      fieldsById.set(id, new WeakRef(input));
    }
    return id;
  }
  function fieldById(id: unknown): HTMLInputElement | null {
    if (typeof id !== "string") return null;
    const input = fieldsById.get(id)?.deref();
    return input?.isConnected ? input : null;
  }

  function visible(el: HTMLElement): boolean {
    const rect = el.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  }
  function editable(input: HTMLInputElement): boolean {
    return visible(input) && !input.disabled && !input.readOnly;
  }

  // "Show password" toggles turn a password field into a text field; it is
  // still the password field (and must not read as the form going away).
  const passwordFields = new WeakSet<HTMLInputElement>();
  function isPasswordField(input: HTMLInputElement): boolean {
    if (input.type === "password") passwordFields.add(input);
    return input.type === "password" || passwordFields.has(input);
  }

  function describe(input: HTMLInputElement): FieldDescriptor {
    const labels = [...(input.labels ?? [])].map((label) => label.textContent);
    return {
      type: input.type,
      autocomplete: input.getAttribute("autocomplete") ?? "",
      hints: [
        input.name,
        input.id,
        input.placeholder,
        input.getAttribute("aria-label"),
        ...labels,
      ]
        .filter(Boolean)
        .join(" "),
    };
  }

  function formHints(scope: ParentNode): string {
    if (!(scope instanceof HTMLFormElement)) return document.title;
    const submit = scope.querySelector<HTMLElement>(
      'button:not([type="button"]):not([type="reset"]), input[type="submit"]',
    );
    return [
      scope.id,
      scope.getAttribute("action"),
      scope.getAttribute("aria-label"),
      submit?.textContent,
      submit instanceof HTMLInputElement ? submit.value : "",
    ]
      .filter(Boolean)
      .join(" ");
  }

  function loginGroups(): LoginGroup[] {
    const groups = new Map<ParentNode, HTMLInputElement[]>();
    for (const input of document.querySelectorAll<HTMLInputElement>("input")) {
      if (!isPasswordField(input) || !editable(input)) continue;
      const scope = input.form ?? document;
      groups.set(scope, [...(groups.get(scope) ?? []), input]);
    }
    return [...groups].map(([scope, passwords]) => ({
      scope,
      passwords,
      username: usernameBefore(scope, passwords[0]),
    }));
  }

  /** The closest account-like field above the first password field. */
  function usernameBefore(
    scope: ParentNode,
    password: HTMLInputElement | undefined,
  ): HTMLInputElement | null {
    if (!password) return null;
    return (
      [...scope.querySelectorAll<HTMLInputElement>("input")]
        .filter(
          (input) =>
            !isPasswordField(input) &&
            editable(input) &&
            input.compareDocumentPosition(password) &
              Node.DOCUMENT_POSITION_FOLLOWING &&
            isUsernameCandidate(describe(input)),
        )
        .at(-1) ?? null
    );
  }

  function kindOf(input: HTMLInputElement): LoginFieldKind | null {
    if (!editable(input)) return null;
    const group = loginGroups().find(
      (candidate) =>
        candidate.passwords.includes(input) || candidate.username === input,
    );
    if (group) {
      if (group.username === input) return "username";
      return classifyPasswordField({
        field: describe(input),
        index: group.passwords.indexOf(input),
        count: group.passwords.length,
        formHints: formHints(group.scope),
      });
    }
    return !isPasswordField(input) && isStandaloneUsername(describe(input))
      ? "username"
      : null;
  }

  // --- suggestions under a field ---
  let shownField: HTMLInputElement | null = null;
  let suggestionsOpen = false;
  /** Enter picks a row only while one is highlighted; otherwise it submits. */
  let suggestionHighlighted = false;
  /** Where a context-menu fill lands when no field id comes with it. */
  let lastFocusedField: HTMLInputElement | null = null;

  /** A field whose site offers passkeys in autofill (`autocomplete` "webauthn"). */
  function wantsPasskeys(input: HTMLInputElement): boolean {
    return /(^|\s)webauthn(\s|$)/i.test(
      input.getAttribute("autocomplete") ?? "",
    );
  }

  function showSuggestions(input: HTMLInputElement): void {
    const webauthn = wantsPasskeys(input) && editable(input);
    const kind = kindOf(input) ?? (webauthn ? "username" : null);
    if (!kind) return;
    shownField = input;
    const rect = input.getBoundingClientRect();
    ipcRenderer.sendToHost("catamorphic:autofill-show", {
      fieldId: fieldId(input),
      kind,
      webauthn,
      value: input.value,
      rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
    });
  }
  function hideSuggestions(reason: "blur" | "other" = "other"): void {
    if (!shownField) return;
    shownField = null;
    // A press on the list itself blurs the page first; the host knows
    // whether that is what happened.
    ipcRenderer.sendToHost("catamorphic:autofill-hide", { reason });
  }

  window.addEventListener(
    "click",
    (event) => {
      const input = event.target;
      if (input instanceof HTMLInputElement && event.isTrusted)
        showSuggestions(input);
    },
    { capture: true },
  );
  // Chrome offers a generated password as soon as a new-password field
  // takes focus; sign-in suggestions wait for a click or ArrowDown.
  window.addEventListener(
    "focusin",
    (event) => {
      const input = event.target;
      if (!(input instanceof HTMLInputElement)) return;
      lastFocusedField = input;
      if (kindOf(input) === "new-password" && !input.value)
        showSuggestions(input);
    },
    { capture: true },
  );
  window.addEventListener(
    "focusout",
    (event) => {
      if (event.target === shownField) hideSuggestions("blur");
    },
    { capture: true },
  );
  window.addEventListener(
    "input",
    (event) => {
      if (event.target !== shownField || !shownField) return;
      ipcRenderer.sendToHost("catamorphic:autofill-input", {
        fieldId: fieldId(shownField),
        value: shownField.value,
      });
    },
    { capture: true },
  );
  window.addEventListener("scroll", () => hideSuggestions(), {
    capture: true,
    passive: true,
  });
  window.addEventListener("resize", () => hideSuggestions());
  ipcRenderer.on("catamorphic:autofill-open", (_event, state: unknown) => {
    const { open, highlighted } =
      state && typeof state === "object"
        ? (state as { open?: unknown; highlighted?: unknown })
        : {};
    suggestionsOpen = open === true;
    suggestionHighlighted = highlighted === true;
  });
  const SUGGESTION_KEYS = new Set(["ArrowDown", "ArrowUp", "Enter", "Escape"]);
  window.addEventListener(
    "keydown",
    (event) => {
      const input = event.target;
      if (!(input instanceof HTMLInputElement)) return;
      if (suggestionsOpen && input === shownField) {
        if (event.key === "Tab") {
          hideSuggestions();
          return;
        }
        const owned =
          SUGGESTION_KEYS.has(event.key) &&
          !event.isComposing &&
          (event.key !== "Enter" || suggestionHighlighted);
        if (owned) {
          event.preventDefault();
          event.stopImmediatePropagation();
          ipcRenderer.sendToHost("catamorphic:autofill-key", {
            key: event.key,
          });
          return;
        }
      }
      if (event.key === "ArrowDown" && !event.altKey && !event.metaKey) {
        if (kindOf(input) || wantsPasskeys(input)) {
          event.preventDefault();
          showSuggestions(input);
        }
        return;
      }
      // Enter in a login field submits it, often without a submit event.
      if (event.key === "Enter") {
        hideSuggestions();
        captureSubmission(input);
      }
    },
    { capture: true },
  );

  // --- form reports: main decides from these whether a sign-in worked ---
  let reportedPasswordForms = -1;
  function reportForms(load: boolean): void {
    const passwordForms = loginGroups().length;
    if (!load && passwordForms === reportedPasswordForms) return;
    reportedPasswordForms = passwordForms;
    ipcRenderer.send("catamorphic:browser-login-forms", {
      origin: location.origin,
      passwordForms,
      load,
    });
  }

  // Ignore unrelated SPA churn. A ticking clock, chat stream, or video UI
  // should not keep scanning the whole document and sending duplicate IPC.
  let observeDebounce: ReturnType<typeof setTimeout> | undefined;
  const observer = new MutationObserver((mutations) => {
    const touchesForm = mutations.some(
      (mutation) =>
        mutation.type === "attributes" ||
        [...mutation.addedNodes, ...mutation.removedNodes].some(
          (node) =>
            node instanceof Element &&
            (node.matches("input, form") || node.querySelector("input, form")),
        ),
    );
    if (!touchesForm || observeDebounce !== undefined) return;
    observeDebounce = setTimeout(() => {
      observeDebounce = undefined;
      if (shownField && !editable(shownField)) hideSuggestions();
      reportForms(false);
    }, 300);
  });
  const observeForms = () =>
    observer.observe(document.documentElement, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ["type", "autocomplete", "style", "class", "hidden"],
    });

  window.addEventListener("DOMContentLoaded", () => {
    reportForms(true);
    observeForms();
  });
  window.addEventListener("pagehide", () => {
    hideSuggestions();
    observer.disconnect();
    clearTimeout(observeDebounce);
    observeDebounce = undefined;
  });
  window.addEventListener("pageshow", (event) => {
    if (!event.persisted) return;
    reportForms(true);
    observeForms();
  });

  // --- submissions ---
  /**
   * Report what a sign-in submitted. `from` is the element that submitted
   * (a form, a button, a field): its group is the one that counts, and a
   * formless page takes whichever group holds a password.
   */
  function captureSubmission(from: Element): void {
    const form =
      from instanceof HTMLFormElement
        ? from
        : ((from as HTMLInputElement | HTMLButtonElement).form ??
          from.closest("form"));
    const groups = loginGroups();
    const group =
      groups.find((candidate) => candidate.scope === (form ?? document)) ??
      (form
        ? undefined
        : groups.find((candidate) =>
            candidate.passwords.some((input) => input.value),
          ));
    if (group) {
      const newPasswords = group.passwords.filter(
        (input, index) =>
          classifyPasswordField({
            field: describe(input),
            index,
            count: group.passwords.length,
            formHints: formHints(group.scope),
          }) === "new-password",
      );
      // A change form submits the new password; a sign-in its only one.
      const password =
        newPasswords.find((input) => input.value)?.value ??
        group.passwords.find((input) => input.value)?.value ??
        "";
      if (!password) return;
      ipcRenderer.send("catamorphic:browser-credentials-submitted", {
        origin: location.origin,
        username: group.username?.value.trim() ?? "",
        password,
      });
      return;
    }
    // An email-first step: remember who is signing in for the next step.
    const scope: ParentNode = form ?? document;
    const username = [
      ...scope.querySelectorAll<HTMLInputElement>("input"),
    ].find(
      (input) =>
        editable(input) && input.value && isStandaloneUsername(describe(input)),
    );
    if (username)
      ipcRenderer.send("catamorphic:browser-username-submitted", {
        origin: location.origin,
        username: username.value.trim(),
      });
  }

  // Capture phase on the window sees submissions even when the page
  // cancels the event later.
  window.addEventListener(
    "submit",
    (event) => {
      if (event.target instanceof HTMLFormElement)
        captureSubmission(event.target);
    },
    { capture: true },
  );
  // Many SPAs sign in from a plain button (or a div) click.
  window.addEventListener(
    "click",
    (event) => {
      const target = event.target as Element | null;
      const button = target?.closest?.(
        'button, input[type="submit"], input[type="button"], [role="button"]',
      );
      if (button && event.isTrusted) captureSubmission(button);
    },
    { capture: true },
  );

  // --- filling ---

  function setNativeValue(input: HTMLInputElement, value: string): void {
    // React and friends ignore direct .value writes; go through the native
    // setter and fire input events so frameworks see the change.
    const setter = Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      "value",
    )?.set;
    setter?.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.dispatchEvent(new Event("change", { bubbles: true }));
  }

  /** The login group around a field (or the page's first, lacking one). */
  function groupFor(input: HTMLInputElement | null): LoginGroup | null {
    const groups = loginGroups();
    return (
      groups.find(
        (group) =>
          !!input &&
          (group.passwords.includes(input) ||
            group.username === input ||
            group.scope === (input.form ?? document)),
      ) ??
      groups[0] ??
      null
    );
  }

  ipcRenderer.on(
    "catamorphic:fill-credentials",
    (
      _event,
      payload: { fieldId?: string; username: string; password: string },
    ) => {
      const field = fieldById(payload.fieldId) ?? lastFocusedField;
      const group = groupFor(field);
      if (!group) {
        // An email-first step has only the username field.
        if (field && kindOf(field) === "username" && payload.username) {
          setNativeValue(field, payload.username);
          field.focus();
        }
        return;
      }
      if (group.username && payload.username)
        setNativeValue(group.username, payload.username);
      const password = group.passwords[0];
      if (password) {
        setNativeValue(password, payload.password);
        password.focus();
      }
      hideSuggestions();
    },
  );

  ipcRenderer.on(
    "catamorphic:fill-generated",
    (_event, payload: { fieldId?: string; password: string }) => {
      const field = fieldById(payload.fieldId) ?? lastFocusedField;
      const group = groupFor(field);
      if (!group) return;
      // The new password and its confirmation; never a change form's
      // current password.
      const targets = group.passwords.filter(
        (input, index) =>
          classifyPasswordField({
            field: describe(input),
            index,
            count: group.passwords.length,
            formHints: formHints(group.scope),
          }) === "new-password",
      );
      for (const input of targets.length ? targets : group.passwords)
        setNativeValue(input, payload.password);
      hideSuggestions();
      (field ?? targets[0])?.focus();
    },
  );

  // Option-click previews are intercepted in the isolated guest preload. Only
  // web navigations are relayed; page code never receives desktop IPC access.
  let previewLinksEnabled = true;
  ipcRenderer.on(
    "catamorphic:preview-links-enabled",
    (_event, enabled: unknown) => {
      previewLinksEnabled = enabled === true;
    },
  );
  document.addEventListener(
    "click",
    (event) => {
      const mode = openModeFromEvent(event);
      if (
        event.button !== 0 ||
        mode === "replace" ||
        (mode === "floating" && !previewLinksEnabled)
      )
        return;
      const anchor =
        event.target instanceof Element
          ? event.target.closest("a[href]")
          : null;
      if (
        !(anchor instanceof HTMLAnchorElement) ||
        anchor.hasAttribute("download") ||
        !/^https?:\/\//i.test(anchor.href)
      )
        return;
      event.preventDefault();
      event.stopImmediatePropagation();
      ipcRenderer.sendToHost("catamorphic:open-link", {
        url: anchor.href,
        mode,
      });
    },
    { capture: true },
  );

  // Scope Escape to floating previews; normal page and terminal shortcuts stay local.
  let floatingPreview = "";
  ipcRenderer.on("catamorphic:floating-preview", (_event, enabled: unknown) => {
    floatingPreview = typeof enabled === "string" ? enabled : "";
  });
  window.addEventListener("keydown", (event) => {
    if (
      !floatingPreview ||
      !matchesShortcut({
        event,
        binding: floatingPreview,
        mac: /Mac/.test(navigator.platform),
      }) ||
      event.defaultPrevented
    )
      return;
    event.preventDefault();
    ipcRenderer.sendToHost("catamorphic:dismiss-floating");
  });

  // Push to talk's keys, while voice is set to it (voice, ADR 0216): the
  // main process hears them go down and up; the page never gets them, so a
  // held Option+Space types nothing. They come with the page keys below.
  let pushToTalkKeys = "";
  ipcRenderer.on("catamorphic:push-to-talk-keys", (_event, keys: unknown) => {
    pushToTalkKeys = typeof keys === "string" ? keys : "";
  });
  window.addEventListener(
    "keydown",
    (event) => {
      if (
        !pushToTalkKeys ||
        !matchesShortcut({
          event,
          binding: pushToTalkKeys,
          mac: /Mac/.test(navigator.platform),
        })
      )
        return;
      event.preventDefault();
      event.stopImmediatePropagation();
    },
    { capture: true },
  );

  // Page-first keys (find, back and forward) reach the page first, as in
  // Chrome: a page with its own find (a document editor) keeps them, and a
  // text field keeps Cmd+Left and Cmd+Right for its caret; otherwise the tab
  // takes them. This preload runs in the main frame only; main asks an
  // embedded frame about back and forward (main/browser.ts). The document
  // asks for the keys as it starts, so they work while it loads.
  let pageKeys: [action: string, binding: string][] = [];
  ipcRenderer.on("catamorphic:page-keys", (_event, keys: unknown) => {
    pageKeys =
      keys && typeof keys === "object"
        ? Object.entries(keys).filter(
            (entry): entry is [string, string] =>
              typeof entry[1] === "string" && entry[1] !== "",
          )
        : [];
  });
  ipcRenderer.sendToHost("catamorphic:page-keys-wanted");
  // Captured, so a page that stops the key's propagation without claiming
  // it (no preventDefault) still leaves it to the tab, as in Chrome.
  window.addEventListener(
    "keydown",
    (event) => {
      const mac = /Mac/.test(navigator.platform);
      const action = pageKeys.find(([, binding]) =>
        matchesShortcut({ event, binding, mac }),
      )?.[0];
      if (!action) return;
      if (fieldKeepsKey({ event, focused: document.activeElement, mac }))
        return;
      // Read once every listener has had the key, the page's own included.
      setTimeout(() => {
        if (!event.defaultPrevented)
          ipcRenderer.sendToHost("catamorphic:page-key", action);
      });
    },
    { capture: true },
  );

  // The theme's selection and find-match colors (renderer/lib/page-theme.ts).
  // An author stylesheet: Chromium paints highlights from author styles only
  // (a user sheet shows in getComputedStyle but never paints). Injected
  // sheets come before the page's own, so the page's rules still win.
  let pageThemeKey: string | null = null;
  ipcRenderer.on("catamorphic:page-theme", (_event, css: unknown) => {
    if (typeof css !== "string") return;
    if (pageThemeKey) webFrame.removeInsertedCSS(pageThemeKey);
    pageThemeKey = css ? webFrame.insertCSS(css) : null;
  });

  /**
   * Sleeping tabs (ADR 0194): text typed into a field and not yet sent keeps
   * the page awake, as in Chrome. A field's text is remembered as it was
   * before the person first typed into it (React and similar libraries keep
   * `defaultValue` equal to the current value, so it cannot tell); main's
   * probe asks whether any field holds other text now. Sending its form,
   * emptying a composer or removing the field ends that. Search boxes do not
   * count: a query stays in the box after it ran.
   */
  type TypedField = HTMLInputElement | HTMLTextAreaElement | HTMLElement;
  const typedFields = new Set<WeakRef<TypedField>>();
  let typedFrom = new WeakMap<TypedField, string>();
  const TEXT_INPUT_TYPES = new Set([
    "text",
    "email",
    "url",
    "tel",
    "password",
    "number",
  ]);
  const SEARCH_ROLES = new Set(["searchbox", "combobox"]);
  const fieldText = (field: TypedField) =>
    field instanceof HTMLInputElement || field instanceof HTMLTextAreaElement
      ? field.value
      : (field.textContent ?? "");
  const typedField = (target: EventTarget | undefined): TypedField | null => {
    if (target instanceof HTMLTextAreaElement) return target;
    if (target instanceof HTMLInputElement)
      return TEXT_INPUT_TYPES.has(target.type) &&
        !SEARCH_ROLES.has(target.getAttribute("role") ?? "")
        ? target
        : null;
    return target instanceof HTMLElement && target.isContentEditable
      ? target
      : null;
  };
  window.addEventListener(
    "beforeinput",
    (event) => {
      if (!event.isTrusted) return;
      const field = typedField(event.composedPath()[0]);
      if (!field || typedFrom.has(field)) return;
      typedFrom.set(field, fieldText(field));
      typedFields.add(new WeakRef(field));
    },
    true,
  );
  window.addEventListener(
    "submit",
    (event) => {
      const form = event.target;
      if (!(form instanceof HTMLFormElement)) return;
      for (const ref of typedFields) {
        const field = ref.deref();
        if (field && form.contains(field)) {
          typedFields.delete(ref);
          typedFrom.delete(field);
        }
      }
    },
    true,
  );
  // A new document in the same page (history navigation keeps the preload).
  window.addEventListener("pagehide", () => {
    typedFields.clear();
    typedFrom = new WeakMap();
  });
  const holdsTypedText = (): boolean => {
    for (const ref of typedFields) {
      const field = ref.deref();
      if (!field?.isConnected) {
        typedFields.delete(ref);
        if (field) typedFrom.delete(field);
        continue;
      }
      const text = fieldText(field);
      if (text.trim() !== "" && text !== typedFrom.get(field)) return true;
    }
    return false;
  };
  ipcRenderer.on(
    "catamorphic:browser-sleep-probe",
    (_event, probe: unknown) => {
      ipcRenderer.send("catamorphic:browser-sleep-probe", {
        probe,
        typing: holdsTypedText(),
      });
    },
  );
}
