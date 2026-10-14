"use strict";

// The part of micromatch this repository's tools call: kysely-codegen's
// table filter (`--include-pattern`) uses `matcher(pattern, { nocase })` on
// "schema.table" names. Globs here are `*` and `?` (never across `/`) and
// `{a,b}` alternatives, which is what those names need; no brace ranges,
// extglobs or character classes, so no `braces` or `picomatch`.
const SPECIAL = /[\\^$.+()|[\]]/;

function source(pattern) {
  let out = "";
  let depth = 0;
  for (const char of pattern) {
    if (char === "*") out += "[^/]*";
    else if (char === "?") out += "[^/]";
    else if (char === "{") {
      depth += 1;
      out += "(?:";
    } else if (char === "}" && depth > 0) {
      depth -= 1;
      out += ")";
    } else if (char === "," && depth > 0) out += "|";
    else out += SPECIAL.test(char) || char === "}" ? `\\${char}` : char;
  }
  if (depth > 0) throw new Error(`Unclosed "{" in pattern ${pattern}`);
  return `^${out}$`;
}

exports.matcher = (pattern, options = {}) => {
  const regex = new RegExp(source(String(pattern)), options.nocase ? "i" : "");
  return (value) => regex.test(String(value));
};
