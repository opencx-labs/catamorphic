import { FileText } from "lucide-react";
import type { ReactNode } from "react";
import type { OpenModifiers } from "../../shared/open-mode";
import { parseSurfaceLink } from "../lib/surface-link";
import { PILL_SURFACE } from "./context-pill";
import { FilePreview } from "./file-preview";
import { ResourceInspector } from "./resource-inspector";
import { WebPreview } from "./web-preview";

export function ResponseLink({
  href,
  children,
  onOpen,
}: {
  href: string;
  children: ReactNode;
  onOpen: (href: string, modifiers: OpenModifiers) => void;
}) {
  const target = parseSurfaceLink(href);
  const file = target?.kind === "file";
  const content = file ? (
    <FilePreview filePath={target.path} />
  ) : target?.kind === "browser" ? (
    <WebPreview url={target.url} />
  ) : undefined;
  if (!content)
    return (
      <a
        href={href}
        onClick={(event) => {
          event.preventDefault();
          onOpen(href, event);
        }}
      >
        {children}
      </a>
    );
  return (
    <ResourceInspector<HTMLAnchorElement>
      label={file ? "File preview" : "Link preview"}
      content={content}
    >
      {(props) => (
        <a
          {...props}
          href={href}
          data-response-link={file ? "file" : "web"}
          className={
            file
              ? `inline-flex max-w-full items-baseline gap-1 px-1.5 align-baseline no-underline ${PILL_SURFACE}`
              : undefined
          }
          onClick={(event) => {
            event.preventDefault();
            props.onClick();
            onOpen(href, event);
          }}
        >
          {file && <FileText className="size-3 shrink-0 self-center" />}
          {children}
        </a>
      )}
    </ResourceInspector>
  );
}

export const renderResponseLink = (
  props: Parameters<typeof ResponseLink>[0],
) => <ResponseLink {...props} />;
