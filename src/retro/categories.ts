// A review finding's category, from its title (and why). Pure.
//
// The retro mutes a category for a lens after enough dismissals, so a category must
// be something the engine can compute the same way at review time and at retro time,
// from what every finding has: its title. A short fixed list, first match wins;
// anything else is `other`, which is never muted (too broad to silence).
export const CATEGORIES = [
  ["naming", /\b(renam\w*|naming|names?d?|identifier|variable name|misnam\w*)\b/i],
  ["style", /\b(style|format\w*|indent\w*|whitespace|semicolon|quote style|lint|prettier|biome|eslint|trailing)\b/i],
  ["tests", /\b(tests?|testing|coverage|unit[- ]test|assert\w*|spec file)\b/i],
  ["docs", /\b(comments?|docs?|documentation|docstring|jsdoc|readme|changelog)\b/i],
  ["error-handling", /\b(error[- ]handling|errors?|exceptions?|try\/catch|catch|throws?|unhandled|reject\w*)\b/i],
  ["performance", /\b(perf\w*|slow|n\+1|latency|cache|caching|memory|allocation|quadratic|o\(n)/i],
  ["copy", /\b(wording|copy|typo|spelling|capitali[sz]\w*|grammar|label text|message text)\b/i],
  ["layout", /\b(layout|spacing|padding|margin|align\w*|overflow|responsive|width|mobile|breakpoint)\b/i],
  ["a11y", /\b(a11y|accessib\w*|aria|contrast|screen reader|keyboard|focus|alt text)\b/i],
  ["types", /\b(types?|typing|any\b|cast|nullable|undefined|null check)\b/i],
] as const satisfies readonly (readonly [string, RegExp])[];

export type Category = (typeof CATEGORIES)[number][0] | "other";

export function categoryOf(title: string, why = ""): Category {
  for (const [name, re] of CATEGORIES) if (re.test(title)) return name;
  for (const [name, re] of CATEGORIES) if (re.test(why)) return name;
  return "other";
}
