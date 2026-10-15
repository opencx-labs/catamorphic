import type { JSONContent } from "@tiptap/core";
import { Node } from "@tiptap/core";
import Link from "@tiptap/extension-link";
import Paragraph from "@tiptap/extension-paragraph";

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
 * markdown. It shows as a chip naming the image; nothing is fetched. It
 * carries its markdown through the clipboard, as data attributes for a
 * paste back here and as text elsewhere. Images stay inline, as markdown
 * has them, so a paragraph holding only an image stays a paragraph
 * (`ImageParagraph`), and a link holding only one stays one image
 * (`ImageLink`).
 */
export const MarkdownImage = Node.create({
  name: "image",
  inline: true,
  group: "inline",
  atom: true,
  selectable: true,
  draggable: false,

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
      [
        "span",
        { class: "cat-mdedit-image-label" },
        attrs.alt || (named ? fileName(attrs.src) : "") || "Image",
      ],
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

function fileName(src: string): string {
  const name = (src.split(/[?#]/)[0] ?? "").split("/").filter(Boolean).at(-1);
  if (!name) return "";
  try {
    return decodeURIComponent(name);
  } catch {
    return name;
  }
}
