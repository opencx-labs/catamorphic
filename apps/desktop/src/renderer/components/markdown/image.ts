import type { JSONContent } from "@tiptap/core";
import { Node } from "@tiptap/core";
import Link from "@tiptap/extension-link";
import Paragraph from "@tiptap/extension-paragraph";
import type { Node as PmNode } from "@tiptap/pm/model";
import type { NodeView } from "@tiptap/pm/view";

/** A URL the editor can show for an image's markdown source, or null. */
export type ImageResolver = (src: string) => Promise<string | null>;

export interface MarkdownImageOptions {
  /** Without one, only web images (https, inline data) show. */
  resolve: ImageResolver;
}

/**
 * Markdown images, as an inline atom. Without an image node the markdown
 * parser turned `![alt](src)` into its alt text: a paragraph holding only
 * an image became a bare text node at the document's top level, which
 * ProseMirror rejects as soon as anything replaces content there (the
 * trailing paragraph, a drop), blanking the window, and saving after any
 * edit wrote the alt text back in place of the image.
 *
 * The node keeps an inline image's markdown as written (a linked badge's
 * link included) and emits it unchanged, so it round-trips byte for byte;
 * a reference-style image is written inline from its resolved URL, since
 * the editor does not keep link definitions, and an HTML `<img>` becomes
 * markdown. It shows the image its `resolve` option finds (`imageView`),
 * and a chip naming it while it loads or when it cannot. It carries its
 * markdown through the clipboard, as data attributes for a paste back here
 * and as text elsewhere. Images stay inline, as markdown has them, so a
 * paragraph holding only an image stays a paragraph (`ImageParagraph`),
 * and a link holding only one stays one image (`ImageLink`).
 */
export const MarkdownImage = Node.create<MarkdownImageOptions>({
  name: "image",
  inline: true,
  group: "inline",
  atom: true,
  selectable: true,
  draggable: false,

  addOptions() {
    return {
      resolve: async (src) => {
        const location = imageLocation(src, null);
        return location && "url" in location ? location.url : null;
      },
    };
  },

  addNodeView() {
    // Per editor, by source: a view made again (an undo, a moved block)
    // shows a loaded image at once instead of loading it again. One not
    // found is looked for again, so a file added since shows.
    const loads = new Map<string, Promise<string | null>>();
    const settled = new Map<string, string>();
    const load = (src: string) => {
      const known = loads.get(src);
      if (known) return known;
      const loading = this.options.resolve(src).catch(() => null);
      loads.set(src, loading);
      void loading.then((url) => {
        if (url) settled.set(src, url);
        else loads.delete(src);
      });
      return loading;
    };
    return ({ node }) => imageView({ node, load, settled });
  },

  addAttributes() {
    return {
      src: { default: "", rendered: false },
      alt: { default: "", rendered: false },
      title: { default: null, rendered: false },
      /** The link around the image, for a linked image (a badge). */
      link: { default: null, rendered: false },
      linkTitle: { default: null, rendered: false },
      /** The markdown as written, emitted unchanged; null to build it. */
      markdown: { default: null, rendered: false },
    };
  },

  parseHTML() {
    return [
      {
        // A chip copied here and pasted back.
        tag: "span.cat-mdedit-image",
        getAttrs: (element) => ({
          src: element.dataset.src ?? "",
          alt: element.dataset.alt ?? "",
          title: element.dataset.title ?? null,
          link: element.dataset.link ?? null,
          linkTitle: element.dataset.linkTitle ?? null,
          markdown: element.dataset.markdown ?? null,
        }),
      },
      {
        tag: "img[src]",
        getAttrs: (element) => ({
          src: element.getAttribute("src") ?? "",
          alt: element.getAttribute("alt") ?? "",
          title: element.getAttribute("title"),
          link: element.closest("a[href]")?.getAttribute("href") ?? null,
        }),
      },
    ];
  },

  renderHTML({ node }) {
    const attrs = imageAttrs(node.attrs);
    const named = !attrs.src.startsWith("data:");
    return [
      "span",
      {
        class: "cat-mdedit-image",
        contenteditable: "false",
        "data-src": attrs.src,
        "data-alt": attrs.alt,
        "data-title": attrs.title ?? undefined,
        "data-link": attrs.link ?? undefined,
        "data-link-title": attrs.linkTitle ?? undefined,
        "data-markdown": imageMarkdown(attrs),
        title: named ? attrs.src : undefined,
      },
      ["span", { class: "cat-mdedit-image-label" }, imageLabel(attrs)],
    ];
  },

  renderText: ({ node }) => imageMarkdown(imageAttrs(node.attrs)),

  markdownTokenName: "image",

  parseMarkdown: (token) => ({
    type: "image",
    attrs: {
      src: token.href ?? "",
      alt: token.text ?? "",
      title: token.title ?? null,
      markdown: inlineMarkdown(token.raw, IMAGE),
    },
  }),

  renderMarkdown: (node) => {
    const attrs = imageAttrs(node.attrs);
    // A link mark on the chip (a linked image pasted from a page) is
    // written around it: the writer marks only text.
    const linkMark = node.marks?.find((mark) => mark.type === "link");
    const href = stringOr(linkMark?.attrs?.href, null);
    return imageMarkdown(
      attrs.link || !href
        ? attrs
        : { ...attrs, link: href, linkTitle: null, markdown: null },
    );
  },
});

/**
 * Tiptap's paragraph, except that one holding only an image stays a
 * paragraph: Tiptap's unwraps it, expecting a block image.
 */
export const ImageParagraph = Paragraph.extend({
  parseMarkdown(token, helpers) {
    const tokens = token.tokens ?? [];
    if (tokens.length === 1 && tokens[0]?.type === "image") {
      return helpers.createNode(
        "paragraph",
        undefined,
        helpers.parseInline(tokens),
      );
    }
    // Tiptap's own parser (`this.parent` is untyped for this hook).
    return Paragraph.config.parseMarkdown?.(token, helpers) ?? [];
  },
});

/**
 * Tiptap's link, except that one holding only an image (a badge) stays one
 * image, link and all: Tiptap's links mark only text, so the image lost
 * its link.
 */
export const ImageLink = Link.extend({
  parseMarkdown(token, helpers) {
    const inner = token.tokens ?? [];
    const image = inner.length === 1 ? inner[0] : undefined;
    if (image?.type === "image") {
      return {
        type: "image",
        attrs: {
          src: image.href ?? "",
          alt: image.text ?? "",
          title: image.title ?? null,
          link: token.href ?? null,
          linkTitle: token.title ?? null,
          markdown: inlineMarkdown(token.raw, LINKED_IMAGE),
        },
      };
    }
    return Link.config.parseMarkdown?.(token, helpers) ?? [];
  },
});

interface ImageAttrs {
  src: string;
  alt: string;
  title: string | null;
  link: string | null;
  linkTitle: string | null;
  markdown: string | null;
}

/** An inline image, `![alt](src "title")`, as opposed to a reference. */
const IMAGE = /^!\[[^\n]*\]\([^\n]*\)$/;
/** An inline link around an inline image. */
const LINKED_IMAGE = /^\[!\[[^\n]*\]\([^\n]*\)\]\([^\n]*\)$/;

/** The markdown as written, when it is the inline form (else rebuilt). */
function inlineMarkdown(raw: unknown, form: RegExp): string | null {
  if (typeof raw !== "string") return null;
  const written = raw.trim();
  return form.test(written) ? written : null;
}

function imageAttrs(attrs: JSONContent["attrs"]): ImageAttrs {
  return {
    src: stringOr(attrs?.src, ""),
    alt: stringOr(attrs?.alt, ""),
    title: stringOr(attrs?.title, null),
    link: stringOr(attrs?.link, null),
    linkTitle: stringOr(attrs?.linkTitle, null),
    markdown: stringOr(attrs?.markdown, null),
  };
}

function imageMarkdown(attrs: ImageAttrs): string {
  if (attrs.markdown) return attrs.markdown;
  const alt = attrs.alt.replace(/([\\[\]])/g, "\\$1");
  const image = `![${alt}](${destination(attrs.src)}${caption(attrs.title)})`;
  return attrs.link
    ? `[${image}](${destination(attrs.link)}${caption(attrs.linkTitle)})`
    : image;
}

function destination(url: string): string {
  return /[\s()<>]/.test(url) ? `<${url.replace(/[<>]/g, "")}>` : url;
}

function caption(title: string | null): string {
  return title ? ` "${title.replace(/"/g, '\\"')}"` : "";
}

function stringOr<T extends string | null>(value: unknown, fallback: T) {
  return typeof value === "string" ? value : fallback;
}

/**
 * A rendered image: a chip naming it while its source loads (shown only
 * if that takes a moment) or when it cannot, then the image. Nothing in it
 * is editable, so ProseMirror ignores its mutations.
 */
function imageView({
  node,
  load,
  settled,
}: {
  node: PmNode;
  load: (src: string) => Promise<string | null>;
  settled: ReadonlyMap<string, string>;
}): NodeView {
  const dom = document.createElement("span");
  dom.className = "cat-mdedit-image";
  dom.contentEditable = "false";
  const state = { node, generation: 0 };
  const chip = (attrs: ImageAttrs, status: "loading" | "failed") => {
    const label = document.createElement("span");
    label.className = "cat-mdedit-image-label";
    label.textContent = imageLabel(attrs);
    dom.dataset.state = status;
    dom.setAttribute("role", "img");
    dom.setAttribute(
      "aria-label",
      status === "failed"
        ? `${label.textContent}, could not be shown`
        : label.textContent,
    );
    dom.replaceChildren(label);
  };
  const show = (attrs: ImageAttrs, url: string | null, current: number) => {
    if (current !== state.generation) return;
    if (!url) {
      chip(attrs, "failed");
      return;
    }
    const image = document.createElement("img");
    image.alt = attrs.alt;
    image.draggable = false;
    const loaded = () => {
      if (current !== state.generation) return;
      dom.dataset.state = "loaded";
      dom.removeAttribute("role");
      dom.removeAttribute("aria-label");
      dom.replaceChildren(image);
    };
    image.addEventListener("error", () => {
      if (current === state.generation) chip(attrs, "failed");
    });
    image.src = url;
    if (image.complete && image.naturalWidth > 0) loaded();
    else image.addEventListener("load", loaded, { once: true });
  };
  const render = (next: PmNode) => {
    const attrs = imageAttrs(next.attrs);
    state.generation += 1;
    const current = state.generation;
    chip(attrs, "loading");
    const ready = settled.get(attrs.src);
    if (ready) {
      show(attrs, ready, current);
    } else {
      void load(attrs.src).then((url) => show(attrs, url, current));
    }
  };
  render(node);
  return {
    dom,
    update: (next) => {
      if (next.type !== state.node.type) return false;
      const before = imageAttrs(state.node.attrs);
      const after = imageAttrs(next.attrs);
      state.node = next;
      if (after.src !== before.src || after.alt !== before.alt) render(next);
      return true;
    },
    ignoreMutation: () => true,
    destroy: () => {
      state.generation += 1;
    },
  };
}

function imageLabel(attrs: ImageAttrs): string {
  const named = !attrs.src.startsWith("data:");
  return attrs.alt || (named ? fileName(attrs.src) : "") || "Image";
}

/**
 * Where an image's source is: a URL shown as it is (https, inline image
 * data), a file in the project (relative to it), or null for anything
 * else: http and other schemes, file URLs, and paths leaving the project
 * or with no project document to start from. A relative path starts at
 * the document's folder; one starting with `/` at the project's root, as
 * in a repository's own markdown.
 */
export function imageLocation(
  src: string,
  /** The document's path relative to its project; null without one. */
  documentPath: string | null,
): { url: string } | { path: string } | null {
  const source = src.trim();
  if (/^https:\/\//i.test(source)) return { url: source };
  if (source.startsWith("//")) return { url: `https:${source}` };
  if (/^data:image\//i.test(source)) return { url: source };
  if (documentPath === null || documentPath.startsWith("/")) return null;
  // Any other scheme, `file:` and a drive letter included.
  if (/^[a-z][a-z\d+.-]*:/i.test(source)) return null;
  const file = decoded(source.replace(/[?#][\s\S]*$/, ""));
  if (!file) return null;
  const folder = documentPath.split("/").slice(0, -1).join("/");
  const path = projectPath(
    file.startsWith("/") || !folder ? file : `${folder}/${file}`,
  );
  return path ? { path } : null;
}

function decoded(path: string): string {
  try {
    return decodeURIComponent(path);
  } catch {
    return path;
  }
}

/** A path in the project with `.` and `..` resolved; null if it leaves. */
function projectPath(path: string): string | null {
  const parts: string[] = [];
  for (const part of path.split("/")) {
    if (part === "" || part === ".") continue;
    if (part !== "..") parts.push(part);
    else if (parts.pop() === undefined) return null;
  }
  return parts.length > 0 ? parts.join("/") : null;
}

function fileName(src: string): string {
  const name = (src.split(/[?#]/)[0] ?? "").split("/").filter(Boolean).at(-1);
  if (!name) return "";
  try {
    return decodeURIComponent(name);
  } catch {
    return name;
  }
}
