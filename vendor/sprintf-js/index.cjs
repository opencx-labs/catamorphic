"use strict";

// The part of sprintf-js this repository's tools call: roarr, the logger
// global-agent uses under Electron's download helper, formats a message with
// `sprintf(format, ...values)`. Only `%s`, `%d`, `%i`, `%f`, `%j` and `%%`;
// no widths, precisions or named arguments, so the output is never longer
// than the format and its values.
function vsprintf(format, values) {
  let next = 0;
  return String(format).replace(/%([%sdifj])/g, (placeholder, type) => {
    if (type === "%") return "%";
    if (next >= values.length) return placeholder;
    const value = values[next++];
    if (type === "s") return String(value);
    if (type === "j") return JSON.stringify(value) ?? String(value);
    if (type === "f") return String(Number.parseFloat(value));
    return String(Number.parseInt(value, 10));
  });
}

exports.vsprintf = vsprintf;
exports.sprintf = (format, ...values) => vsprintf(format, values);
