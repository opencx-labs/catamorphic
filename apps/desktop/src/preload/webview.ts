import { contextBridge, ipcRenderer } from "electron";

/**
 * Guest preload for browser-tab webviews. Runs inside untrusted pages with
 * context isolation. Credential secrets travel directly between this guest
 * and the trusted main process; the embedding renderer receives metadata
 * and status only. Jobs, all Chrome-like:
 *  - present Chrome's client-hint brands to JS (see below),
 *  - detect login forms and report submissions (offer-to-save),
 *  - fill credentials into the current login form on command.
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

interface LoginForm {
  id: string;
  form: HTMLFormElement | null;
  username: HTMLInputElement | null;
  password: HTMLInputElement;
}

const formIds = new WeakMap<HTMLInputElement, string>();
let nextFormId = 1;

function visible(el: HTMLElement): boolean {
  const rect = el.getBoundingClientRect();
  return rect.width > 0 && rect.height > 0;
}

function findLoginForms(includeNewPassword = false): LoginForm[] {
  const passwords = [
    ...document.querySelectorAll<HTMLInputElement>(
      'input[type="password"], input[autocomplete="current-password"]',
    ),
  ].filter(
    (input) =>
      visible(input) &&
      (includeNewPassword ||
        input.autocomplete.toLowerCase() !== "new-password") &&
      !input.disabled &&
      !input.readOnly,
  );
  return passwords.map((password) => {
    let id = formIds.get(password);
    if (!id) {
      id = `login-form-${nextFormId++}`;
      formIds.set(password, id);
    }
    const form = password.closest("form");
    const scope: ParentNode = form ?? document;
    const username =
      [
        ...scope.querySelectorAll<HTMLInputElement>(
          'input[autocomplete="username"], input[autocomplete="email"], input[type="email"], input[type="text"], input[type="tel"]',
        ),
      ]
        .filter((input) => visible(input) && !input.disabled && !input.readOnly)
        // The username field is the closest eligible input above the
        // password field in DOM order.
        .filter(
          (candidate) =>
            candidate.compareDocumentPosition(password) &
            Node.DOCUMENT_POSITION_FOLLOWING,
        )
        .at(-1) ?? null;
    return { id, form, username, password };
  });
}

let announcedForms = "";
function announceForms(): void {
  const forms = findLoginForms();
  const key = JSON.stringify([location.origin, forms.map((form) => form.id)]);
  if (key === announcedForms) return;
  announcedForms = key;
  if (forms.length > 0) {
    ipcRenderer.send("catamorphic:browser-login-forms", {
      origin: location.origin,
      forms: forms.map((form) => ({ id: form.id })),
    });
  }
}

// Ignore unrelated SPA churn. A ticking clock, chat stream, or video UI
// should not keep scanning the whole document and sending duplicate IPC.
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
    announceForms();
  }, 400);
});
let observeDebounce: ReturnType<typeof setTimeout> | undefined;

window.addEventListener("DOMContentLoaded", () => {
  announceForms();
  observer.observe(document.documentElement, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ["type", "autocomplete"],
  });
});
window.addEventListener("pagehide", () => {
  observer.disconnect();
  clearTimeout(observeDebounce);
  observeDebounce = undefined;
});
window.addEventListener("pageshow", (event) => {
  if (!event.persisted) return;
  announcedForms = "";
  announceForms();
  observer.observe(document.documentElement, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ["type", "autocomplete"],
  });
});

// Offer-to-save: capture submitted credentials. Capture phase on the
// window sees submissions even when the page cancels the event later.
function captureSubmission(): void {
  for (const { username, password } of findLoginForms(true)) {
    if (password.value) {
      ipcRenderer.send("catamorphic:browser-credentials-submitted", {
        origin: location.origin,
        username: username?.value ?? "",
        password: password.value,
      });
      return;
    }
  }
}
window.addEventListener("submit", captureSubmission, { capture: true });
window.addEventListener(
  "focusin",
  (event) => {
    const input = event.target;
    if (!(input instanceof HTMLInputElement) || input.type !== "password") {
      return;
    }
    const form = findLoginForms(true).find(
      (candidate) => candidate.password === input,
    );
    if (!form) return;
    ipcRenderer.send("catamorphic:browser-login-form-focused", {
      origin: location.origin,
      formId: form.id,
    });
  },
  { capture: true },
);
// Many SPAs sign in from a button click without a submit event.
window.addEventListener(
  "click",
  (event) => {
    const target = event.target as HTMLElement | null;
    const button = target?.closest?.(
      'button[type="submit"], input[type="submit"], button:not([type])',
    );
    if (button) captureSubmission();
  },
  { capture: true },
);

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

ipcRenderer.on(
  "catamorphic:fill-credentials",
  (
    _event,
    payload: { formId?: string; username: string; password: string },
  ) => {
    const forms = findLoginForms(true);
    const target = forms.find((form) => form.id === payload.formId) ?? forms[0];
    if (!target) return;
    if (target.username && payload.username) {
      setNativeValue(target.username, payload.username);
    }
    setNativeValue(target.password, payload.password);
    target.password.focus();
  },
);
