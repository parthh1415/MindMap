/**
 * Watches the local transcript stream and seeds optimistic ghost nodes from
 * extracted noun-phrase candidates. Ghosts auto-expire after 8 seconds unless
 * a `node_upsert` resolves them first (handled in graphStore).
 *
 * Strategy:
 *   1. Tokenize each partial transcript with a stoplist + simple capitalized
 *      / multi-word noun-phrase heuristic. (No LLM. Ever.)
 *   2. For each candidate phrase, fuzzy-compare against existing labels:
 *      - case-insensitive substring match
 *      - small Levenshtein cutoff
 *   3. If unmatched and not already a pending ghost → addGhost().
 */

import { useGraphStore } from "@/state/graphStore";

const STOPLIST = new Set([
  "the", "a", "an", "and", "or", "but", "if", "of", "for", "to", "in", "on",
  "at", "by", "with", "from", "as", "is", "are", "was", "were", "be", "been",
  "being", "have", "has", "had", "do", "does", "did", "will", "would", "could",
  "should", "may", "might", "shall", "can", "this", "that", "these", "those",
  "i", "you", "he", "she", "it", "we", "they", "me", "him", "her", "us", "them",
  "my", "your", "his", "its", "our", "their", "what", "which", "who", "whom",
  "so", "yes", "no", "not", "very", "really", "actually", "also", "just",
  "okay", "ok", "well", "like", "right", "sure", "maybe", "kind", "sort",
  "thing", "things", "stuff", "yeah", "uh", "um", "hmm",
  "about", "around", "after", "before", "between", "during", "through",
  "above", "below", "over", "under", "upon", "into", "onto", "than", "then",
  "when", "where", "why", "how", "while", "still", "even", "more", "most",
  "some", "any", "every", "all", "many", "few", "much", "such", "only",
  "going", "getting", "making", "saying", "seeing", "looking", "let",
  "lets", "want", "wants", "need", "needs", "know", "knows",
]);

const GHOST_TTL_MS = 8_000;
const ghostExpiryTimers = new Map<string, number>();

function tokenize(text: string): string[] {
  return text
    .replace(/[^\p{L}\p{N}\s'-]/gu, " ")
    .split(/\s+/)
    .map((t) => t.trim())
    .filter(Boolean);
}

function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  const dp = Array.from({ length: a.length + 1 }, (_, i) => i);
  for (let j = 1; j <= b.length; j++) {
    let prev = dp[0];
    dp[0] = j;
    for (let i = 1; i <= a.length; i++) {
      const tmp = dp[i];
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      dp[i] = Math.min(dp[i] + 1, dp[i - 1] + 1, prev + cost);
      prev = tmp;
    }
  }
  return dp[a.length];
}

function matchesExisting(phrase: string): boolean {
  const lp = phrase.toLowerCase();
  const state = useGraphStore.getState();

  for (const node of Object.values(state.nodes)) {
    const lbl = node.label.toLowerCase();
    if (lbl.includes(lp) || lp.includes(lbl)) return true;
    if (Math.abs(lbl.length - lp.length) <= 3) {
      const dist = levenshtein(lbl, lp);
      const max = Math.max(lbl.length, lp.length);
      if (dist <= 2 || dist / max <= 0.25) return true;
    }
  }
  for (const ghost of Object.values(state.ghostNodes)) {
    const gl = ghost.label.toLowerCase();
    if (gl === lp || gl.includes(lp) || lp.includes(gl)) return true;
    if (Math.abs(gl.length - lp.length) <= 3) {
      const dist = levenshtein(gl, lp);
      const max = Math.max(gl.length, lp.length);
      if (dist <= 2 || dist / max <= 0.25) return true;
    }
  }
  return false;
}

/**
 * Extracts candidate noun phrases. We accept:
 *   - Sequences of 1–3 non-stoplist tokens that include at least one
 *     capitalized word OR are not present in the stoplist.
 */
export function extractCandidates(text: string): string[] {
  const tokens = tokenize(text);
  if (tokens.length === 0) return [];
  const out: string[] = [];

  for (let i = 0; i < tokens.length; i++) {
    const wMax = Math.min(3, tokens.length - i);
    for (let w = 1; w <= wMax; w++) {
      const slice = tokens.slice(i, i + w);
      const lower = slice.map((t) => t.toLowerCase());
      // skip if every token is a stoplist token
      if (lower.every((t) => STOPLIST.has(t))) continue;
      // require at least one non-stoplist token of length ≥ 3 (or capitalized non-stoplist).
      // 3 is intentional — picks up acronyms like API, AWS, lag, git that the
      // user is more likely to want surfaced.
      const hasMeat = slice.some(
        (t) => !STOPLIST.has(t.toLowerCase()) && (t.length >= 3 || /^[A-Z]/.test(t)),
      );
      if (!hasMeat) continue;

      const phrase = slice.join(" ");
      if (phrase.length < 3) continue;
      out.push(phrase);
    }
  }
  // dedupe in-call
  return Array.from(new Set(out));
}

/**
 * Public hook: feed every partial transcript chunk through this.
 */
export function processTranscriptPartial(text: string, speakerId: string): void {
  const candidates = extractCandidates(text);
  for (const cand of candidates) {
    if (matchesExisting(cand)) continue;
    const ghostId = useGraphStore.getState().addGhost(cand, speakerId);
    scheduleGhostExpiry(ghostId);
  }
}

function scheduleGhostExpiry(ghostId: string): void {
  const existing = ghostExpiryTimers.get(ghostId);
  if (existing !== undefined) window.clearTimeout(existing);
  const t = window.setTimeout(() => {
    useGraphStore.getState().removeGhost(ghostId);
    ghostExpiryTimers.delete(ghostId);
  }, GHOST_TTL_MS);
  ghostExpiryTimers.set(ghostId, t);
}

/** Test-only export. */
export const __test__ = { levenshtein, matchesExisting };
