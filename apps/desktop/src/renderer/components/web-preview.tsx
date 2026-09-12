import { useEffect, useState } from "react";
import { desktopApi } from "../lib/desktop-api";
import { ResourcePreviewContent } from "./catamorphic/resource-preview";
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
    <ResourcePreviewContent
      preview={{
        name: (title?.url === url ? title.title : "") || hostname,
        typeLabel: "Page",
        location: url,
        content: { kind: "summary", text: hostname },
      }}
    />
  );
}
