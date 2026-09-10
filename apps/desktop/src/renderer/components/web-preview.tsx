import { Globe } from "lucide-react";
import { useEffect, useState } from "react";
import { desktopApi } from "../lib/desktop-api";
/** Link previews reuse local metadata; hovering never visits a website. */
export function WebPreview({ url }: { url: string }) {
  const hostname = URL.canParse(url) ? new URL(url).hostname : "Link";
  const [title, setTitle] = useState<{ url: string; title: string }>();
  useEffect(() => {
    let current = true;
    void desktopApi
      .windowProfile()
      .then((profileId) => desktopApi.browserSuggest({ profileId, query: url }))
      .then((result) => {
        if (current)
          setTitle({
            url,
            title:
              result.matches.find((match) => match.url === url)?.title ?? "",
          });
      })
      .catch(() => undefined);
    return () => {
      current = false;
    };
  }, [url]);
  return (
    <div className="text-xs">
      <div className="flex items-center gap-2 font-medium">
        <Globe className="size-4 shrink-0" />
        {(title?.url === url ? title.title : "") || hostname}
      </div>
      <p className="mt-2 select-text break-all font-mono text-[11px] text-fg-muted">
        {url}
      </p>
    </div>
  );
}
