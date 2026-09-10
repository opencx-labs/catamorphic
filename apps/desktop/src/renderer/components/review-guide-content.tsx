import { useEffect, useId, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { PullRequestFile } from "../lib/desktop-api.js";
import { guideFileTarget } from "../lib/review-guide-document.js";

/** Derive navigation from rendered Markdown, including user edits. */
export function ReviewGuideContent({
  markdown,
  files,
  onOpenFile,
}: {
  markdown: string;
  files: PullRequestFile[];
  onOpenFile: (file: PullRequestFile) => void;
}) {
  const content = useRef<HTMLDivElement>(null);
  const prefix = useId();
  const [sections, setSections] = useState<HTMLHeadingElement[]>([]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: Reindex the rendered headings when the Markdown document changes.
  useEffect(() => {
    const headings = [
      ...(content.current?.querySelectorAll<HTMLHeadingElement>("h2") ?? []),
    ];
    for (const [index, heading] of headings.entries()) {
      heading.id = `${prefix}-section-${index}`;
      heading.tabIndex = -1;
    }
    setSections(headings);
  }, [markdown, prefix]);

  return (
    <div
      className={`grid min-w-0 gap-6 ${sections.length > 1 ? "@min-[800px]/review:grid-cols-[minmax(0,1fr)_12rem]" : ""}`}
    >
      {sections.length > 1 && (
        <nav
          aria-label="Guide sections"
          className="@min-[800px]/review:sticky @min-[800px]/review:top-3 @min-[800px]/review:col-start-2 @min-[800px]/review:row-start-1 self-start"
        >
          <p className="mb-2 text-xs font-medium text-fg-muted">
            In this guide
          </p>
          <ol className="flex gap-1 overflow-x-auto @min-[800px]/review:flex-col">
            {sections.map((heading, index) => (
              <li
                key={heading.id}
                className="shrink-0 @min-[800px]/review:shrink"
              >
                <a
                  href={`#${heading.id}`}
                  onClick={(event) => {
                    event.preventDefault();
                    heading.scrollIntoView({ block: "start" });
                    heading.focus({ preventScroll: true });
                  }}
                  className="flex gap-2 rounded-md px-2 py-2 text-xs text-fg-muted hover:bg-bg-overlay hover:text-fg focus-visible:outline-2 focus-visible:outline-accent"
                >
                  <span className="tabular-nums text-fg-faint">
                    {index + 1}
                  </span>
                  <span>{heading.textContent}</span>
                </a>
              </li>
            ))}
          </ol>
        </nav>
      )}
      <div
        ref={content}
        className="cat-markdown min-w-0 break-words text-sm @min-[800px]/review:col-start-1 @min-[800px]/review:row-start-1 [&_h2]:scroll-mt-4 [&_h2]:focus-visible:outline-accent"
      >
        <ReactMarkdown
          remarkPlugins={[remarkGfm]}
          components={{
            a: ({ href, children }) => {
              const file = guideFileTarget(href, files);
              return file ? (
                <button
                  type="button"
                  className="text-accent underline underline-offset-2"
                  onClick={() => onOpenFile(file)}
                >
                  {children}
                </button>
              ) : (
                <span>{children}</span>
              );
            },
          }}
        >
          {markdown}
        </ReactMarkdown>
      </div>
    </div>
  );
}
