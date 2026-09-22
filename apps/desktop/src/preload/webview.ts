import { contextBridge, ipcRenderer } from "electron";
import { matchesShortcut } from "../shared/keybindings.js";
import {
  classifyPasswordField,
  type FieldDescriptor,
  isStandaloneUsername,
  isUsernameCandidate,
} from "../shared/login-fields.js";
import { openModeFromEvent } from "../shared/open-mode.js";

/**
 * Guest preload for browser-tab webviews. Runs inside untrusted pages with
 * context isolation. Credential secrets travel directly between this guest
 * and the trusted main process; the embedding renderer receives metadata
 * and status only. Jobs, all Chrome-like:
 *  - present Chrome's client-hint brands to JS (see below),
 *  - place password suggestions under login fields and report submitted
 *    logins (offer-to-save, auto-save of generated passwords),
 *  - fill saved or generated passwords on command.
 */

/**
 * `navigator.userAgentData.brands` is the JS-visible twin of the Sec-CH-UA
 * header (rewritten in main/browser.ts). Electron reports Chromium only;
 * leaving JS and headers disagreeing is exactly the mismatch a
 * supported-browser check keys on. Injected into the page's main world —
 * the preload's isolated world isn't what site scripts read.
 */
interface UaBrand {
  brand: string;
  version: string;
}

interface UaData {
  brands: UaBrand[];
  getHighEntropyValues: (
    hints: string[],
  ) => Promise<{ brands?: UaBrand[]; fullVersionList?: UaBrand[] }>;
}

function alignClientHintBrands(): void {
  const major = /Chrome\/(\d+)/.exec(navigator.userAgent)?.[1];
  if (!major) return;
  // executeInMainWorld runs in the page's world (where site scripts look);
  // the preload's isolated world is invisible to them. `args` is the only
  // channel across the boundary — the function body can't close over
  // preload scope.
  if (typeof contextBridge.executeInMainWorld !== "function") {
    ipcRenderer.sendToHost("catamorphic:brand-align-failed", {
      reason: "executeInMainWorld unavailable",
    });
    return;
  }
  contextBridge.executeInMainWorld({
    func: (version: string) => {
      const data = (navigator as Navigator & { userAgentData?: UaData })
        .userAgentData;
      if (!data) return;
      const brands = [
        { brand: "Google Chrome", version },
        { brand: "Chromium", version },
        { brand: "Not;A=Brand", version: "8" },
      ];
      const copy = () => brands.map((brand) => ({ ...brand }));
      // Patch the prototype, not the instance: `navigator.userAgentData`
      // yields a fresh object per access, so an own-property override is
      // discarded on the next read.
      const proto = Object.getPrototypeOf(data) as object;
      Object.defineProperty(proto, "brands", {
        get: copy,
        configurable: true,
      });
      const getHighEntropyValues = data.getHighEntropyValues;
      Object.defineProperty(proto, "getHighEntropyValues", {
        value: function (this: UaData, hints: string[]) {
          return getHighEntropyValues.call(this, hints).then((values) => {
            if (!values.fullVersionList) {
              return { ...values, brands: copy() };
            }
            // Real Chrome lists Google Chrome at the *Chrome* version;
            // mapping the placeholder brand's version onto it (8.0.0.0)
            // is precisely the tell a checker looks for.
            const chromium = values.fullVersionList.find(
              (entry) => entry.brand === "Chromium",
            );
            const fullVersion = chromium?.version ?? version;
            return {
              ...values,
              brands: copy(),
              fullVersionList: [
                { brand: "Google Chrome", version: fullVersion },
                { brand: "Chromium", version: fullVersion },
                { brand: "Not;A=Brand", version: "8.0.0.0" },
              ],
            };
          });
        },
        configurable: true,
        writable: true,
      });
    },
    args: [major],
  });
}
alignClientHintBrands();

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
        subscribe: (listener: (event: GuestNotificationEvent) => void) => void;
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

function showSuggestions(input: HTMLInputElement): void {
  const kind = kindOf(input);
  if (!kind) return;
  shownField = input;
  const rect = input.getBoundingClientRect();
  ipcRenderer.sendToHost("catamorphic:autofill-show", {
    fieldId: fieldId(input),
    kind,
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
        ipcRenderer.sendToHost("catamorphic:autofill-key", { key: event.key });
        return;
      }
    }
    if (event.key === "ArrowDown" && !event.altKey && !event.metaKey) {
      if (kindOf(input)) {
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
  const username = [...scope.querySelectorAll<HTMLInputElement>("input")].find(
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
      event.target instanceof Element ? event.target.closest("a[href]") : null;
    if (
      !(anchor instanceof HTMLAnchorElement) ||
      anchor.hasAttribute("download") ||
      !/^https?:\/\//i.test(anchor.href)
    )
      return;
    event.preventDefault();
    event.stopImmediatePropagation();
    ipcRenderer.sendToHost("catamorphic:open-link", { url: anchor.href, mode });
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
