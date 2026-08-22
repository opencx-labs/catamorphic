import { Download, Share, X } from "lucide-react";
import { useEffect, useState } from "react";
import {
  installPromotionKind,
  installPromptWasDismissed,
  rememberInstallPromptDismissal,
} from "../lib/install.js";

interface BeforeInstallPromptEvent extends Event {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed"; platform: string }>;
}

function isBeforeInstallPromptEvent(
  event: Event,
): event is BeforeInstallPromptEvent {
  const userChoice = Reflect.get(event, "userChoice");
  return (
    typeof Reflect.get(event, "prompt") === "function" &&
    typeof userChoice === "object" &&
    userChoice !== null &&
    typeof Reflect.get(userChoice, "then") === "function"
  );
}

export function InstallPromotion({ enabled }: { enabled: boolean }) {
  const [nativePrompt, setNativePrompt] =
    useState<BeforeInstallPromptEvent | null>(null);
  const [hidden, setHidden] = useState(() =>
    installPromptWasDismissed(localStorage),
  );
  const [closing, setClosing] = useState(false);

  useEffect(() => {
    const markInstalled = () => {
      rememberInstallPromptDismissal(localStorage);
      setHidden(true);
      setClosing(false);
    };
    const onBeforeInstallPrompt = (event: Event) => {
      if (!isBeforeInstallPromptEvent(event)) return;
      event.preventDefault();
      if (!installPromptWasDismissed(localStorage)) setNativePrompt(event);
    };
    window.addEventListener("beforeinstallprompt", onBeforeInstallPrompt);
    window.addEventListener("appinstalled", markInstalled);
    return () => {
      window.removeEventListener("beforeinstallprompt", onBeforeInstallPrompt);
      window.removeEventListener("appinstalled", markInstalled);
    };
  }, []);

  const standalone =
    window.matchMedia("(display-mode: standalone)").matches ||
    Reflect.get(navigator, "standalone") === true;
  const availableKind = installPromotionKind({
    secureContext: window.isSecureContext,
    standalone,
    dismissed: false,
    hasNativePrompt: nativePrompt !== null,
    userAgent: navigator.userAgent,
    platform: navigator.platform,
    maxTouchPoints: navigator.maxTouchPoints,
  });

  if (!enabled || !availableKind || (hidden && !closing)) return null;

  const dismissForever = () => {
    rememberInstallPromptDismissal(localStorage);
    setHidden(true);
    setClosing(true);
  };
  const install = async () => {
    if (!nativePrompt) return;
    try {
      await nativePrompt.prompt();
      await nativePrompt.userChoice;
    } finally {
      dismissForever();
    }
  };

  return (
    <aside
      className={`fixed inset-x-3 top-[calc(env(safe-area-inset-top)+4rem)] z-50 mx-auto flex max-w-sm items-start gap-3 rounded-2xl border border-border-strong bg-bg-raised/95 p-3 shadow-2xl backdrop-blur-xl ${closing ? "animate-install-prompt-out" : "animate-install-prompt-in"}`}
      aria-label="Install Catamorphic"
      data-testid="install-prompt"
      onAnimationEnd={(event) => {
        if (closing && event.currentTarget === event.target) {
          setClosing(false);
        }
      }}
    >
      <span className="grid size-10 shrink-0 place-items-center rounded-xl bg-accent text-accent-fg">
        {availableKind === "native" ? (
          <Download className="size-5" />
        ) : (
          <Share className="size-5" />
        )}
      </span>
      <div className="min-w-0 flex-1">
        <h2 className="text-[14px] font-semibold">Install Catamorphic</h2>
        <p className="mt-0.5 text-xs leading-5 text-fg-muted">
          {availableKind === "native"
            ? "Keep Catamorphic one tap away and use it without browser chrome."
            : "On iPhone or iPad, open this page in Safari, tap Share, then Add to Home Screen."}
        </p>
        {availableKind === "native" && (
          <button
            type="button"
            className="mt-2 h-8 cursor-pointer rounded-lg bg-accent px-3 text-xs font-semibold text-accent-fg active:scale-[0.98]"
            onClick={() => void install()}
            data-testid="install-confirm"
          >
            Install
          </button>
        )}
      </div>
      <button
        type="button"
        className="grid size-8 shrink-0 cursor-pointer place-items-center rounded-lg text-fg-faint active:bg-bg-overlay active:text-fg"
        onClick={dismissForever}
        aria-label="Dismiss install prompt permanently"
        data-testid="install-dismiss"
      >
        <X className="size-4" />
      </button>
    </aside>
  );
}
