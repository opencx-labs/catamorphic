/**
 * Cross-item imports in source live at `../<item>/<file>.js`; installed
 * files all land flat in the same target directory, so they become
 * sibling imports. The build writes `./<file>`; a host that keeps the
 * `.js` suffix on relative imports passes `extension: ".js"`.
 */
export function rewriteCrossItemImports(
  content: string,
  extension: "" | ".js" = "",
): string {
  return content.replaceAll(
    /from "\.\.\/[\w-]+\/([\w-]+)\.js"/g,
    `from "./$1${extension}"`,
  );
}
