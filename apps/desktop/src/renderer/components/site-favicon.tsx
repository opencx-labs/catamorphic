import { Globe } from "lucide-react";
import { useState } from "react";
import { useWindowImage } from "../lib/window-images";

/**
 * A page's icon: one this profile saw the site show (ADR 0277), never an
 * address the window fetches itself, so a row or chip naming a site it
 * never visited shows the globe and contacts nothing.
 */
export function SiteFavicon({
  url,
  faviconUrl,
  className = "size-3.5",
}: {
  url: string;
  faviconUrl?: string | null;
  className?: string;
}) {
  const source = useWindowImage({
    site: { page: url, ...(faviconUrl ? { icon: faviconUrl } : {}) },
  });
  const [failedSource, setFailedSource] = useState<string>();

  if (source === undefined)
    return <span aria-hidden className={`${className} shrink-0`} />;
  if (!source || failedSource === source) {
    return <Globe className={`${className} shrink-0 text-fg-faint`} />;
  }
  return (
    <img
      src={source}
      alt=""
      className={`${className} shrink-0 rounded-[2px] object-contain`}
      onError={() => setFailedSource(source)}
    />
  );
}
