/**
 * Language tags as pages write them (BCP 47, any case and region) matched
 * to the languages Work can translate and detect (ADR 0320).
 */

/** The languages the bundled detector (Google's CLD3) tells apart. */
export const DETECTOR_LANGUAGES: ReadonlySet<string> = new Set([
  ..."af am ar az be bg bn bs ca ceb co cs cy da de el en eo es et eu fa fi fil fr fy ga gd gl gu ha haw he hi hmn hr ht hu hy id ig is it ja jv ka kk km kn ko ku ky la lb lo lt lv mg mi mk ml mn mr ms mt my ne nl no ny pa pl ps pt ro ru sd si sk sl sm sn so sq sr st su sv sw ta te tg th tr uk ur uz vi xh yi yo zh zu".split(
    " ",
  ),
]);

/** CLD3's codes that BCP 47 spells differently. */
const DETECTED_ALIASES: Record<string, string> = { iw: "he" };

/** A tag in Intl's canonical form, or null when it is not a language tag. */
export function canonicalTag(tag: string): string | null {
  try {
    return Intl.getCanonicalLocales(tag)[0] ?? null;
  } catch {
    return null;
  }
}

/**
 * The model language a tag asks for: its language subtag, except Chinese,
 * which the models split by script (zh and zh-CN are Simplified, zh-TW and
 * zh-HK Traditional), and two languages the models name differently.
 */
export function modelLanguage(tag: string): string | null {
  const canonical = canonicalTag(tag);
  if (!canonical) return null;
  const locale = new Intl.Locale(canonical);
  if (locale.language === "zh") {
    const script = locale.script ?? locale.maximize().script;
    return script === "Hant" ? "zh-Hant" : "zh-Hans";
  }
  if (locale.language === "no") return "nb";
  if (locale.language === "fil") return "tl";
  return locale.language;
}

/** Whether the detector can tell a tag's language apart. */
export function detectorKnows(tag: string): boolean {
  const canonical = canonicalTag(tag);
  return (
    canonical !== null &&
    DETECTOR_LANGUAGES.has(new Intl.Locale(canonical).language)
  );
}

/** A detected language as a BCP 47 tag. */
export function detectedTag(code: string): string {
  return DETECTED_ALIASES[code] ?? code;
}

/**
 * The models a translation runs through: the pair itself, or into English
 * and out of it as Firefox does when there is no direct model. Null when
 * no route exists, or when both tags name the same language.
 */
export function translationRoute(
  source: string,
  target: string,
  pairs: ReadonlySet<string>,
): string[] | null {
  const from = modelLanguage(source);
  const to = modelLanguage(target);
  if (!from || !to || from === to) return null;
  const direct = `${from}-${to}`;
  if (pairs.has(direct)) return [direct];
  const into = `${from}-en`;
  const out = `en-${to}`;
  return pairs.has(into) && pairs.has(out) ? [into, out] : null;
}
