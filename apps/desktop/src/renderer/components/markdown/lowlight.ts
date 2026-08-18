import bash from "highlight.js/lib/languages/bash";
import css from "highlight.js/lib/languages/css";
import go from "highlight.js/lib/languages/go";
import javascript from "highlight.js/lib/languages/javascript";
import json from "highlight.js/lib/languages/json";
import markdown from "highlight.js/lib/languages/markdown";
import python from "highlight.js/lib/languages/python";
import rust from "highlight.js/lib/languages/rust";
import sql from "highlight.js/lib/languages/sql";
import typescript from "highlight.js/lib/languages/typescript";
import xml from "highlight.js/lib/languages/xml";
import yaml from "highlight.js/lib/languages/yaml";
import { createLowlight } from "lowlight";

/**
 * Curated grammar set instead of lowlight's `common` bundle (~37 grammars):
 * the languages that actually appear in project markdown. Fences with other
 * languages render as plain code. Aliases follow highlight.js conventions.
 */
export const lowlight = createLowlight();

lowlight.register({
  bash,
  css,
  go,
  javascript,
  json,
  markdown,
  python,
  rust,
  sql,
  typescript,
  xml,
  yaml,
});
lowlight.registerAlias({
  bash: ["sh", "shell", "zsh"],
  javascript: ["js", "jsx"],
  markdown: ["md"],
  python: ["py"],
  typescript: ["ts", "tsx"],
  xml: ["html"],
  yaml: ["yml"],
});
