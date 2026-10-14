"use strict";

// The part of micromatch this repository's tools call: kysely-codegen's
// table filter (`--include-pattern`) uses `matcher(pattern, { nocase })` on
// "schema.table" names. Globs here are `*` and `?` (never across `/`) and
// `{a,b}` alternatives, which is what those names need. Anything else
// micromatch would read as glob syntax (character classes, escapes,
// extglobs, negation, brace ranges) is refused rather than matched
// differently, so no `braces` or `picomatch`.
const SPECIAL = /[\\^$.+()|[\]]/;
const UNSUPPORTED = /[[\]\\()]|^!|\{[^}]*\.\.[^}]*\}/;

function source(pattern) {
  const unsupported = UNSUPPORTED.exec(pattern);
  if (unsupported)
    throw new Error(
      `Unsupported glob syntax "${unsupported[0]}" in pattern ${pattern}`,
    );
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
