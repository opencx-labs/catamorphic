import { Node } from "@tiptap/core";
import Paragraph from "@tiptap/extension-paragraph";

/**
 * Markdown images, as an inline atom. Without an image node the markdown
 * parser turned `![alt](src)` into its alt text: a paragraph holding only
 * an image became a bare text node at the document's top level, which
 * ProseMirror rejects as soon as anything replaces content there (the
 * trailing paragraph, a drop), blanking the window, and saving after any
 * edit wrote the alt text back in place of the image.
 *
 * The node keeps the image's markdown as written and emits it unchanged,
 * so files round-trip byte for byte. It shows as a chip naming the image;
 * nothing is fetched. Images stay inline, as markdown has them, so a
 * paragraph holding only an image stays a paragraph
 * (`ImageParagraph`).
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
      src: { default: "" },
      alt: { default: "" },
      title: { default: null },
      /** The markdown as written, emitted unchanged. */
      markdown: { default: null, rendered: false },
    };
  },

  parseHTML() {
    return [
      {
        tag: "img[src]",
        getAttrs: (element) => ({
          src: element.getAttribute("src") ?? "",
          alt: element.getAttribute("alt") ?? "",
          title: element.getAttribute("title"),
        }),
      },
    ];
  },

  renderHTML({ node }) {
    const src = String(node.attrs.src ?? "");
    const alt = String(node.attrs.alt ?? "");
    return [
      "span",
      {
        class: "cat-mdedit-image",
        contenteditable: "false",
        "data-src": src,
        title: src,
      },
      alt || fileName(src) || "Image",
    ];
  },

  markdownTokenName: "image",

  parseMarkdown: (token) => ({
    type: "image",
    attrs: {
      src: token.href ?? "",
      alt: token.text ?? "",
      title: token.title ?? null,
      markdown: token.raw ?? null,
    },
  }),

  renderMarkdown: (node) => {
    const { src, alt, title, markdown } = node.attrs ?? {};
    if (typeof markdown === "string" && markdown) return markdown;
    const target = /[\s()<>]/.test(src ?? "") ? `<${src}>` : (src ?? "");
    const caption = title ? ` "${String(title).replace(/"/g, '\\"')}"` : "";
    return `![${String(alt ?? "").replace(/([[\]])/g, "\\$1")}](${target}${caption})`;
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
    return Paragraph.config.parseMarkdown?.(token, helpers) ?? [];
  },
});

function fileName(src: string): string {
  const name = (src.split(/[?#]/)[0] ?? "").split("/").filter(Boolean).at(-1);
  if (!name) return "";
  try {
    return decodeURIComponent(name);
  } catch {
    return name;
  }
}
