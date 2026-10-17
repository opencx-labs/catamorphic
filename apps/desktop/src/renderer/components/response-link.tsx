import { useWorkflows } from "@catamorphic/react";
import { AppWindow, FileText, Workflow } from "lucide-react";
import { type ReactNode, useContext } from "react";
import type { OpenModifiers } from "../../shared/open-mode";
import { parseSurfaceLink } from "../../shared/surface-link";
import { type Chip, chipKind } from "../lib/chips";
import { ChipPreview } from "./chip-preview";
import { PILL_SURFACE } from "./context-pill";
import { FilePreview, FilePreviewProjectContext } from "./file-preview";
import { ResourceInspector } from "./resource-inspector";
import { WebPreview } from "./web-preview";

export function ResponseLink({
  href,
  children,
  onOpen,
  chips,
}: {
  /** The chat's chips: a link to one of its tabs previews as its chip does. */
  chips?: readonly Chip[];
  href: string;
  children: ReactNode;
  onOpen: (href: string, modifiers: OpenModifiers) => void;
}) {
  const target = parseSurfaceLink(href);
  // A workflow chip names the workflow as its tab does, whatever the agent
  // wrote as link text.
  const projectId = useContext(FilePreviewProjectContext);
  const workflows = useWorkflows(
    target?.kind === "workflow" ? projectId : undefined,
  );
  const workflowTitle =
    target?.kind === "workflow"
      ? workflows.data?.find((workflow) => workflow.name === target.name)
          ?.displayName
      : undefined;
  if (target?.kind === "workflow" || target?.kind === "app") {
    const Icon = target.kind === "workflow" ? Workflow : AppWindow;
    const label = workflowTitle ?? children;
    return (
      <ResourceInspector<HTMLAnchorElement>
        label={`${target.kind === "workflow" ? "Workflow" : "App"} preview`}
        content={
          <ChipPreview
            chip={{
              id: `${target.kind}:${target.name}`,
              label:
                workflowTitle ??
                (typeof children === "string" ? children : target.name),
              data: { kind: target.kind, name: target.name },
            }}
          />
        }
      >
        {(props) => (
          <a
            {...props}
            href={href}
            data-response-link={target.kind}
            className={`inline-flex max-w-full items-baseline gap-1 px-1.5 align-baseline no-underline ${PILL_SURFACE}`}
            onClick={(event) => {
              event.preventDefault();
              props.onClick();
              onOpen(href, event);
            }}
          >
            <Icon className="size-3 shrink-0 self-center" />
            {label}
            <span className="text-[10px] text-fg-muted">
              {target.kind === "workflow" ? "Workflow" : "App"}
            </span>
          </a>
        )}
      </ResourceInspector>
    );
  }
  const linkedChip =
    target?.kind === "tab"
      ? chips?.find((chip) => chip.url === target.key)
      : undefined;
  const file = target?.kind === "file";
  const content = file ? (
    <FilePreview filePath={target.path} />
  ) : target?.kind === "browser" ? (
    <WebPreview url={target.url} />
  ) : linkedChip ? (
    <ChipPreview chip={linkedChip} />
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
      label={
        linkedChip
          ? `Preview ${linkedChip.label}`
          : file
            ? "File preview"
            : "Link preview"
      }
      content={content}
    >
      {(props) => (
        <a
          {...props}
          href={href}
          data-response-link={
            (linkedChip && chipKind(linkedChip)) ?? (file ? "file" : "web")
          }
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
