import { Globe } from "lucide-react";
import { useState } from "react";

function fallbackFavicon(url: string): string | undefined {
  try {
    return new URL("/favicon.ico", url).href;
  } catch {
    return undefined;
  }
}

/** Best-effort page identity with a familiar browser-tab fallback. */
export function SiteFavicon({
  url,
  faviconUrl,
  className = "size-3.5",
}: {
  url: string;
  faviconUrl?: string | null;
  className?: string;
}) {
  const source = faviconUrl || fallbackFavicon(url);
  const [failedSource, setFailedSource] = useState<string>();

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
