import { Image as ImageIcon, ImageOff } from "lucide-react";
import { useContext, useLayoutEffect, useRef, useState } from "react";
import { desktopApi } from "../lib/desktop-api.js";
import { EASE_STANDARD, motionMs } from "../lib/motion.js";
import { untrustedHost, useTrustedHosts } from "../lib/trusted-hosts.js";
import { FilePreviewProjectContext } from "./file-preview.js";
import { PendingButton } from "./pending-button.js";

/** How long a picture takes to grow into its place (DESIGN.md motion). */
const REVEAL_MS = 200;

/**
 * An image in an agent's reply (ADR 0277). Loading it sends its address to
 * its host, and the agent chose the address, so it shows at once only from
 * a host the chat trusts. From any other it names the host and waits: Show
 * loads it this once, and Always show trusts the host from now on.
 */
export function RemoteImage({ src, alt }: { src: string; alt: string }) {
  const projectId = useContext(FilePreviewProjectContext);
  return (
    <ImageConsent
      key={JSON.stringify([projectId, src])}
      src={src}
      alt={alt}
      projectId={projectId}
    />
  );
}

/** Consent and reveal state belong to this exact address in this project. */
function ImageConsent({
  src,
  alt,
  projectId,
}: {
  src: string;
  alt: string;
  projectId: string | undefined;
}) {
  const trusted = useTrustedHosts(projectId);
  const [shown, setShown] = useState(false);
  const [trusting, setTrusting] = useState(false);
  const [trustFailed, setTrustFailed] = useState(false);
  const [always, setAlways] = useState(false);
  const host = untrustedHost(trusted, src);
  const allowed = Boolean(
    src.startsWith("data:image/") || (trusted && !host && !trusting) || shown,
  );
  // Keep the question that actually occupied this space, even when a host
  // approval arrives from another window while its image is still loading.
  const [askedHost, setAskedHost] = useState(trusted ? host : null);
  const frame = useRef<HTMLSpanElement>(null);
  const placeholder = useRef<HTMLSpanElement>(null);
  const image = useRef<HTMLImageElement>(null);
  const before = useRef({ width: 0, height: 0 });
  const [attempt, setAttempt] = useState(0);
  const [state, setState] = useState<"loading" | "loaded" | "failed">(
    "loading",
  );
  const [settled, setSettled] = useState(false);
  const loaded = allowed && state === "loaded";
  const busy = trusting || (allowed && state !== "failed" && !settled);

  useLayoutEffect(() => {
    if (trusted && host) setAskedHost(host);
    if (!allowed) {
      setState("loading");
      setSettled(false);
    }
  }, [allowed, host, trusted]);

  useLayoutEffect(() => {
    const box = frame.current;
    const picture = image.current;
    const pill = placeholder.current;
    if (!loaded || !box || !picture || !pill) return;
    const duration = motionMs(REVEAL_MS);
    if (!duration) {
      setSettled(true);
      return;
    }
    const to = box.getBoundingClientRect();
    // The picture and question keep their own dimensions while their shared
    // frame changes size. Neither text wrapping nor image scaling jumps.
    picture.style.width = `${picture.getBoundingClientRect().width}px`;
    picture.style.maxWidth = "none";
    pill.style.width = `${before.current.width}px`;
    const grow = box.animate(
      [
        {
          width: `${before.current.width}px`,
          height: `${before.current.height}px`,
        },
        { width: `${to.width}px`, height: `${to.height}px` },
      ],
      { duration, easing: EASE_STANDARD },
    );
    const enter = picture.animate([{ opacity: 0 }, { opacity: 1 }], {
      duration,
      easing: EASE_STANDARD,
    });
    const exit = pill.animate([{ opacity: 1 }, { opacity: 0 }], {
      duration,
      easing: EASE_STANDARD,
    });
    let cancelled = false;
    void grow.finished.then(
      () => {
        if (cancelled) return;
        picture.style.removeProperty("width");
        picture.style.removeProperty("max-width");
        setSettled(true);
      },
      () => {},
    );
    return () => {
      cancelled = true;
      grow.cancel();
      enter.cancel();
      exit.cancel();
    };
  }, [loaded]);

  const promptHost = askedHost ?? (trusted ? host : null);
  const label = promptHost
    ? `${alt || "Image"} from ${promptHost}`
    : alt || "Image";
  const failed = state === "failed" || trustFailed;
  const show = () => {
    setTrustFailed(false);
    setState("loading");
    setAttempt((value) => value + 1);
    setShown(true);
  };
  return (
    <span
      ref={frame}
      data-remote-image={allowed ? state : "waiting"}
      className={`relative inline-grid max-w-full align-top ${loaded ? "overflow-hidden" : ""}`}
    >
      {!settled && (
        <span
          ref={placeholder}
          data-remote-image-placeholder
          aria-hidden={loaded || undefined}
          inert={loaded}
          className={`inline-flex max-w-full flex-wrap items-center gap-x-1.5 gap-y-0.5 rounded-md border border-border px-1.5 py-0.5 text-xs text-fg-muted ${loaded ? "absolute left-0 top-0" : ""}`}
        >
          {failed ? (
            <ImageOff aria-hidden className="size-3.5 shrink-0" />
          ) : (
            <ImageIcon aria-hidden className="size-3.5 shrink-0" />
          )}
          <span className="grid min-w-0 break-all" aria-live="polite">
            <span
              aria-hidden={failed}
              className={`col-start-1 row-start-1 ${failed ? "invisible" : ""}`}
            >
              {label}
            </span>
            {[
              [state === "failed" && !trustFailed, "Image unavailable"],
              [trustFailed, "Host could not be saved"],
            ].map(([visible, message]) => (
              <span
                key={String(message)}
                aria-hidden={!visible}
                className={`col-start-1 row-start-1 ${visible ? "" : "invisible"}`}
              >
                {message}
              </span>
            ))}
          </span>
          {promptHost && (
            <>
              <PendingButton
                type="button"
                pending={busy && !always}
                disabled={busy}
                className="shrink-0 cursor-pointer rounded px-1 text-fg hover:bg-bg-inset disabled:cursor-default"
                onClick={() => {
                  setAlways(false);
                  show();
                }}
              >
                Show
              </PendingButton>
              <PendingButton
                type="button"
                pending={busy && always}
                disabled={busy}
                aria-label={`Always show images from ${promptHost}`}
                className="shrink-0 cursor-pointer rounded px-1 text-fg hover:bg-bg-inset disabled:cursor-default"
                onClick={() => {
                  setAlways(true);
                  setTrusting(true);
                  setTrustFailed(false);
                  void desktopApi.trustHost(promptHost).then(
                    () => {
                      setTrusting(false);
                      show();
                    },
                    () => {
                      setTrusting(false);
                      setTrustFailed(true);
                    },
                  );
                }}
              >
                Always show
              </PendingButton>
            </>
          )}
        </span>
      )}
      {allowed && state !== "failed" && (
        <img
          key={attempt}
          ref={image}
          src={src}
          alt={alt}
          // Laid out out of sight until it has loaded, so its place opens
          // from the name's line to its own size.
          className={
            state === "loaded"
              ? "block max-w-full rounded-md"
              : "pointer-events-none absolute left-0 top-0 max-w-full opacity-0"
          }
          onLoad={() => {
            const box = frame.current?.getBoundingClientRect();
            before.current = {
              width: box?.width ?? 0,
              height: box?.height ?? 0,
            };
            setState("loaded");
          }}
          onError={() => setState("failed")}
        />
      )}
    </span>
  );
}
