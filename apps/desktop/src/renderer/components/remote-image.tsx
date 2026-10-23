import { Image as ImageIcon, ImageOff } from "lucide-react";
import { useContext, useLayoutEffect, useRef, useState } from "react";
import { desktopApi } from "../lib/desktop-api.js";
import { EASE_STANDARD, motionMs } from "../lib/motion.js";
import { untrustedHost, useTrustedHosts } from "../lib/trusted-hosts.js";
import { FilePreviewProjectContext } from "./file-preview.js";

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
  const host = untrustedHost(trusted, src);
  if (src.startsWith("data:image/") || (trusted && !host) || shown)
    return <RevealedImage src={src} alt={alt} />;
  // Not a web image, or the chat's hosts are still being read.
  if (!host || !trusted)
    return <span className="text-fg-muted">{alt || "Image"}</span>;
  return (
    <span
      data-remote-image="waiting"
      className="inline-flex max-w-full flex-wrap items-center gap-x-1.5 gap-y-0.5 rounded-md border border-border px-1.5 py-0.5 align-middle text-xs text-fg-muted"
    >
      <ImageIcon aria-hidden className="size-3.5 shrink-0" />
      <span className="min-w-0 break-all">
        {alt ? `${alt} from ${host}` : `Image from ${host}`}
      </span>
      <button
        type="button"
        className="shrink-0 cursor-pointer rounded px-1 text-fg hover:bg-bg-inset"
        onClick={() => setShown(true)}
      >
        Show
      </button>
      <button
        type="button"
        disabled={trusting}
        className="max-w-full cursor-pointer break-all rounded px-1 text-left text-fg hover:bg-bg-inset disabled:opacity-60"
        onClick={() => {
          setTrusting(true);
          // Shown now; the list catches up for every other image from it.
          setShown(true);
          void desktopApi.trustHost(host).catch(() => setTrusting(false));
        }}
      >
        Always show from {host}
      </button>
    </span>
  );
}

/**
 * The picture, growing into its place once it has loaded: the line its
 * name held opens to the picture's height as the picture fades in, on the
 * standard curve. Reduced motion shows it at once.
 */
function RevealedImage({ src, alt }: { src: string; alt: string }) {
  const frame = useRef<HTMLSpanElement>(null);
  const image = useRef<HTMLImageElement>(null);
  const before = useRef(0);
  const [state, setState] = useState<"loading" | "loaded" | "failed">(
    "loading",
  );
  useLayoutEffect(() => {
    const box = frame.current;
    const picture = image.current;
    if (state !== "loaded" || !box || !picture) return;
    const duration = motionMs(REVEAL_MS);
    if (!duration) return;
    const to = box.getBoundingClientRect().height;
    const grow = box.animate(
      [{ height: `${before.current}px` }, { height: `${to}px` }],
      { duration, easing: EASE_STANDARD },
    );
    const fade = picture.animate(
      [
        { opacity: 0, transform: "scale(0.98)" },
        { opacity: 1, transform: "none" },
      ],
      { duration, easing: EASE_STANDARD },
    );
    return () => {
      grow.cancel();
      fade.cancel();
    };
  }, [state]);
  if (state === "failed")
    return (
      <span
        data-remote-image="failed"
        className="inline-flex items-center gap-1 text-fg-muted"
      >
        <ImageOff aria-hidden className="size-3.5" />
        {alt || "Image"}
      </span>
    );
  return (
    <span
      ref={frame}
      data-remote-image={state}
      className="relative inline-block max-w-full overflow-hidden align-top"
    >
      {state === "loading" && (
        <span className="inline-flex items-center gap-1 text-fg-muted">
          <ImageIcon aria-hidden className="size-3.5" />
          {alt || "Image"}
        </span>
      )}
      <img
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
          before.current = frame.current?.getBoundingClientRect().height ?? 0;
          setState("loaded");
        }}
        onError={() => setState("failed")}
      />
    </span>
  );
}
