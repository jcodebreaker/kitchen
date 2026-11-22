// A review finding's category, and the security veto. Pure.
//
// The retro mutes a category for a lens after enough dismissals, so a category must be
// something the engine computes the same way at review time and at retro time. A lens
// writes it (`- category: <one of CATEGORIES>`, roles/_review.md); a finding without a
// valid one falls back to keywords on its title, then its why; anything else is `other`,
// which is never muted (too broad to silence).
//
// The veto: a finding that mentions a security term (in its title, why or category) is
// never muted, whatever its lens or category. A code-lens "missing test for the session
// check" is about security even when the lens called it `tests`; dismissals of it don't
// count toward a mute either.
export const CATEGORIES = ["security", "correctness", "performance", "naming", "style", "types", "tests", "docs", "ux", "ui"] as const;
export type Category = (typeof CATEGORIES)[number] | "other";

/** Keyword fallback for a finding with no valid `category:` line; first match wins (security first). */
const KEYWORDS: readonly (readonly [Category, RegExp])[] = [
  [
    "security",
    /\b(security|vulnerab\w*|exploit\w*|auth(?!or)\w*|tokens?|sessions?|permissions?|owner\w*|inject\w*|sql|xss|csrf|leak\w*|secrets?|passwords?|credentials?|access)\b/i,
  ],
  ["naming", /\b(renam\w*|naming|names?d?|identifier|variable name|misnam\w*)\b/i],
  ["style", /\b(style|format\w*|indent\w*|whitespace|semicolon|quote style|lint|prettier|biome|eslint|trailing)\b/i],
  ["tests", /\b(tests?|testing|coverage|unit[- ]test|assert\w*|spec file)\b/i],
  ["docs", /\b(comments?|docs?|documentation|docstring|jsdoc|readme|changelog)\b/i],
  ["performance", /\b(perf\w*|slow|n\+1|latency|cache|caching|memory|allocation|quadratic|o\(n)/i],
  ["types", /\b(types?|typing|any\b|cast|nullable|undefined|null check)\b/i],
  ["ui", /\b(layout|spacing|padding|margin|align\w*|overflow|responsive|width|mobile|breakpoint|contrast|colou?r|font|icon|dark mode)\b/i],
  ["ux", /\b(wording|copy|typo|spelling|capitali[sz]\w*|grammar|label|message|a11y|accessib\w*|aria|screen reader|keyboard|focus|confusing|empty state)\b/i],
  ["correctness", /\b(bug|wrong|incorrect|broken|crash\w*|errors?|exceptions?|unhandled|race|off[- ]by[- ]one|regression|fails?)\b/i],
];

/** A `category:` value as a lens wrote it → one of CATEGORIES, or undefined (unknown or empty). */
export function parseCategory(raw: string | undefined): Category | undefined {
  const v = (raw ?? "").toLowerCase().replace(/[`*]/g, "").trim();
  return (CATEGORIES as readonly string[]).includes(v) ? (v as Category) : undefined;
}

/** The finding's category: the one the lens declared when valid, else the first keyword match on the title, then the why, else `other`. */
export function categoryOf(title: string, why = "", declared?: string): Category {
  const d = parseCategory(declared);
  if (d) return d;
  for (const [name, re] of KEYWORDS) if (re.test(title)) return name;
  for (const [name, re] of KEYWORDS) if (re.test(why)) return name;
  return "other";
}

/** Terms that make a finding security-relevant, for every lens. */
export const SECURITY_TERMS =
  /\b(auth(?!or)\w*|tokens?|sessions?|permissions?|ownership|owners?|inject\w*|sql\w*|xss|csrf|leak\w*|secrets?|passwords?|credentials?|delete another|access(?!ib)\w*)\b/i;

/**
 * The security veto: why this finding may never be muted, or null. A declared or fallback category of
 * `security`, or a security term anywhere in its title, why or category.
 */
export function securityVeto(f: { title: string; why?: string; category?: string }): string | null {
  if (categoryOf(f.title, f.why ?? "", f.category) === "security") return "a security finding";
  const m = SECURITY_TERMS.exec(`${f.title}\n${f.why ?? ""}\n${f.category ?? ""}`);
  return m ? `it mentions "${m[1].toLowerCase()}"` : null;
}

/** A finding a person may dismiss only with an explicit reason (recorded with it): the security lens's, or one declared `category: security`. */
export const needsReason = (f: { lens: string; category?: string }) => f.lens === "security" || parseCategory(f.category) === "security";
