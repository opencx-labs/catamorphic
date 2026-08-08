/**
 * Ported from Superhuman's command-score fuzzy matcher — the same
 * algorithm behind cmdk. Subsequence matching with weighted scoring:
 * word-boundary jumps score high, mid-word jumps low, skips and case
 * mismatches apply small compounding penalties. Returns 0..1; 0 = no match.
 *
 * Original work Copyright (c) 2016 Superhuman, MIT License.
 * See the NOTICE file at the repository root for the full text.
 */

const SCORE_CONTINUE_MATCH = 1;
const SCORE_SPACE_WORD_JUMP = 0.9;
const SCORE_NON_SPACE_WORD_JUMP = 0.8;
const SCORE_CHARACTER_JUMP = 0.17;
const SCORE_TRANSPOSITION = 0.1;
const PENALTY_SKIPPED = 0.999;
const PENALTY_CASE_MISMATCH = 0.9999;
const PENALTY_NOT_COMPLETE = 0.99;

const IS_GAP = /[\\/_+.#"@[({&]/;
const COUNT_GAPS = /[\\/_+.#"@[({&]/g;
const IS_SPACE = /[\s-]/;
const COUNT_SPACES = /[\s-]/g;

function score(
  string: string,
  query: string,
  stringLower: string,
  queryLower: string,
  stringIndex: number,
  queryIndex: number,
  memo: Record<string, number>,
): number {
  if (queryIndex === query.length) {
    return stringIndex === string.length
      ? SCORE_CONTINUE_MATCH
      : PENALTY_NOT_COMPLETE;
  }

  const memoKey = `${stringIndex},${queryIndex}`;
  const cached = memo[memoKey];
  if (cached !== undefined) return cached;

  const queryChar = queryLower.charAt(queryIndex);
  let index = stringLower.indexOf(queryChar, stringIndex);
  let best = 0;

  while (index >= 0) {
    let candidate = score(
      string,
      query,
      stringLower,
      queryLower,
      index + 1,
      queryIndex + 1,
      memo,
    );
    if (candidate > best) {
      if (index === stringIndex) {
        candidate *= SCORE_CONTINUE_MATCH;
      } else if (IS_GAP.test(string.charAt(index - 1))) {
        candidate *= SCORE_NON_SPACE_WORD_JUMP;
        const skippedGaps = string
          .slice(stringIndex, index - 1)
          .match(COUNT_GAPS);
        if (skippedGaps && stringIndex > 0) {
          candidate *= PENALTY_SKIPPED ** skippedGaps.length;
        }
      } else if (IS_SPACE.test(string.charAt(index - 1))) {
        candidate *= SCORE_SPACE_WORD_JUMP;
        const skippedSpaces = string
          .slice(stringIndex, index - 1)
          .match(COUNT_SPACES);
        if (skippedSpaces && stringIndex > 0) {
          candidate *= PENALTY_SKIPPED ** skippedSpaces.length;
        }
      } else {
        candidate *= SCORE_CHARACTER_JUMP;
        if (stringIndex > 0) {
          candidate *= PENALTY_SKIPPED ** (index - stringIndex);
        }
      }
      if (string.charAt(index) !== query.charAt(queryIndex)) {
        candidate *= PENALTY_CASE_MISMATCH;
      }
    }

    // Transposition tolerance: "sotck" still finds "stock".
    if (
      (candidate < SCORE_TRANSPOSITION &&
        stringLower.charAt(index - 1) === queryLower.charAt(queryIndex + 1)) ||
      (queryLower.charAt(queryIndex + 1) === queryLower.charAt(queryIndex) &&
        stringLower.charAt(index - 1) !== queryLower.charAt(queryIndex))
    ) {
      const transposed = score(
        string,
        query,
        stringLower,
        queryLower,
        index + 1,
        queryIndex + 2,
        memo,
      );
      if (transposed * SCORE_TRANSPOSITION > candidate) {
        candidate = transposed * SCORE_TRANSPOSITION;
      }
    }

    if (candidate > best) best = candidate;
    index = stringLower.indexOf(queryChar, index + 1);
  }

  memo[memoKey] = best;
  return best;
}

function normalize(value: string): string {
  return value.toLowerCase().replace(COUNT_SPACES, " ");
}

export function commandScore(
  haystack: string,
  query: string,
  keywords?: readonly string[],
): number {
  const full =
    keywords && keywords.length > 0
      ? `${haystack} ${keywords.join(" ")}`
      : haystack;
  return score(full, query, normalize(full), normalize(query), 0, 0, {});
}
