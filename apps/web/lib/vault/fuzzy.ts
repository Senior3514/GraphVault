/**
 * A tiny, dependency-free subsequence fuzzy matcher for the command palette.
 *
 * Note search uses MiniSearch (see `search.ts`); this is for the small, fixed
 * set of *commands* ("Create new note", "Go to Graph", …) where a forgiving
 * subsequence match — "gg" -> "Go to Graph" — feels right and a full-text index
 * would be overkill. It is pure and side-effect-free so it unit-tests trivially.
 *
 * Scoring rewards (in order): contiguous runs, matches at word boundaries, and
 * earlier matches. Higher scores are better; a non-match returns `null`.
 */

export interface FuzzyMatch {
  /** Total match score; higher is a better match. */
  score: number;
  /** Indices in `text` that matched, for optional highlight rendering. */
  indices: number[];
}

const BOUNDARY = /[\s/\-_.]/;

/**
 * Score how well `query` fuzzy-matches `text` (case-insensitive). An empty
 * query matches everything with score 0. Returns `null` when `query` is not a
 * subsequence of `text`.
 */
export function fuzzyMatch(text: string, query: string): FuzzyMatch | null {
  const q = query.trim().toLowerCase();
  if (q === '') return { score: 0, indices: [] };

  const haystack = text.toLowerCase();
  const indices: number[] = [];
  let score = 0;
  let from = 0;
  let prevIndex = -2;

  for (const ch of q) {
    const idx = haystack.indexOf(ch, from);
    if (idx === -1) return null;
    indices.push(idx);

    // Base point for any match, with an earlier-is-better nudge.
    score += 1 + Math.max(0, 8 - idx) * 0.1;
    // Contiguous with the previous matched char: a strong signal.
    if (idx === prevIndex + 1) score += 4;
    // Sitting at a word boundary (start, or after a separator) reads as intent.
    if (idx === 0 || BOUNDARY.test(haystack[idx - 1])) score += 3;

    prevIndex = idx;
    from = idx + 1;
  }

  return { score, indices };
}

/** Convenience: true when `query` fuzzy-matches `text`. */
export function fuzzyMatches(text: string, query: string): boolean {
  return fuzzyMatch(text, query) !== null;
}
