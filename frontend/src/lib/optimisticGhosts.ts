/**
 * SWARM ghost extractor.
 *
 * The transcript-side LLM/topology pipeline can saturate (Groq + Gemini free
 * tiers) and silently return empty diffs. To keep the canvas responsive we
 * aggressively seed *client-side* "ghost" nodes from raw transcript text —
 * within ~100 ms of each spoken phrase — so the user always sees activity.
 * The Groq topology agent later promotes / merges ghosts into real nodes.
 *
 * Design:
 *   1. Permissive candidate extraction. A typical 15-20 word sentence yields
 *      3-6 ghosts (capped at 6).
 *   2. Both partials AND finals seed ghosts. Partials use a short TTL
 *      (8 s default, 60 s under throttle); finals use 30 s.
 *   3. Co-occurrence predictive edges. Two ghosts from the same speaker
 *      arriving within 4 s of each other become a faint predictive edge,
 *      capped at 8 in flight.
 *   4. Throttle-aware TTL: if no real `node_upsert` has arrived in 25 s,
 *      bump in-flight ghost TTL to 60 s so the swarm doesn't dissolve.
 *   5. Speaker trail: every new ghost we create pushes onto the active
 *      speaker's recent-touch trail.
 */

import { useGraphStore } from "@/state/graphStore";

// ─────────────────────────────────────────────────────────────────────
// Stoplist — true function words ONLY. Content-bearing words like
// "going / want / need / know / making" are intentionally excluded
// because they often anchor user intent ("rate-limiting", "auth flow").
// ─────────────────────────────────────────────────────────────────────
const STOPLIST = new Set([
  "the", "a", "an", "and", "or", "but", "if", "of", "for", "to", "in", "on",
  "at", "by", "with", "from", "as", "is", "are", "was", "were", "be", "been",
  "being", "have", "has", "had", "do", "does", "did", "will", "would", "could",
  "should", "may", "might", "shall", "can", "this", "that", "these", "those",
  "i", "you", "he", "she", "it", "we", "they", "me", "him", "her", "us", "them",
  "my", "your", "his", "its", "our", "their", "what", "which", "who", "whom",
  "so", "yes", "no", "not", "very", "really", "actually", "also", "just",
  "okay", "ok", "well", "right", "sure", "maybe",
  "about", "around", "after", "before", "between", "during", "through",
  "above", "below", "over", "under", "upon", "into", "onto", "than", "then",
  "when", "where", "why", "how", "while", "still", "even",
  "uh", "um", "hmm",
]);

// ─────────────────────────────────────────────────────────────────────
// TTL configuration.
// ─────────────────────────────────────────────────────────────────────
const GHOST_TTL_NORMAL_MS = 8_000;
const GHOST_TTL_THROTTLED_MS = 60_000;
const GHOST_TTL_FINAL_MS = 30_000;
const THROTTLE_THRESHOLD_MS = 25_000;

const PREDICTIVE_EDGE_WINDOW_MS = 4_000;
const PREDICTIVE_EDGE_TTL_MS = 12_000;
const MAX_PREDICTIVE_EDGES = 8;

const RECENT_GHOST_RING_SIZE = 5;
const MAX_CANDIDATES_PER_CALL = 6;

// ─────────────────────────────────────────────────────────────────────
// Module-scoped state.
// ─────────────────────────────────────────────────────────────────────
const ghostExpiryTimers = new Map<string, ReturnType<typeof setTimeout>>();
const predictiveEdgeTimers = new Map<string, ReturnType<typeof setTimeout>>();
/** ring per speaker → newest first; tracks {ghostId, ts}. */
const recentGhostsBySpeaker = new Map<
  string,
  { ghostId: string; ts: number }[]
>();
/** order of predictive-edge ids (oldest first) so we can prune the oldest. */
const predictiveEdgeOrder: string[] = [];

let lastNodeArrivalTs = Date.now();
let lastObservedNodeCount = 0;
let throttleSubscribed = false;

// Subscribe once to the graph store so we can detect "no real nodes for 25 s"
// and extend ghost TTLs dynamically. Re-entrant safe.
function ensureThrottleSubscription(): void {
  if (throttleSubscribed) return;
  throttleSubscribed = true;
  // Initialise from current state so we start in a consistent place.
  try {
    lastObservedNodeCount = Object.keys(useGraphStore.getState().nodes).length;
    lastNodeArrivalTs = Date.now();
  } catch {
    /* ignore: store may not be ready in some test contexts */
  }
  useGraphStore.subscribe((state) => {
    const count = Object.keys(state.nodes).length;
    if (count > lastObservedNodeCount) {
      lastNodeArrivalTs = Date.now();
    }
    lastObservedNodeCount = count;
  });
}

function isThrottled(): boolean {
  return Date.now() - lastNodeArrivalTs > THROTTLE_THRESHOLD_MS;
}

function currentPartialTtl(): number {
  return isThrottled() ? GHOST_TTL_THROTTLED_MS : GHOST_TTL_NORMAL_MS;
}

// ─────────────────────────────────────────────────────────────────────
// Tokenisation / Levenshtein.
// ─────────────────────────────────────────────────────────────────────
function tokenize(text: string): string[] {
  // Keep apostrophes and hyphens inside tokens; treat everything else as
  // whitespace. \p{L} = any letter, \p{N} = any number.
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

// ─────────────────────────────────────────────────────────────────────
// Candidate extraction.
// ─────────────────────────────────────────────────────────────────────

type ScoredCandidate = {
  phrase: string;
  score: number;
};

function isStop(t: string): boolean {
  return STOPLIST.has(t.toLowerCase());
}

function isCapitalized(t: string): boolean {
  return /^[A-Z]/.test(t) && t.length > 1;
}

function isContentToken(t: string): boolean {
  if (isStop(t)) return false;
  // accept short tokens only if capitalized (acronyms / proper nouns).
  if (t.length < 3 && !/^[A-Z]/.test(t)) return false;
  return true;
}

/**
 * Builds candidate phrases of 1-3 tokens with a sliding window.
 *
 * Scoring (higher = better):
 *   +3 phrase contains a capitalized non-initial word (proper noun)
 *   +2 length-2 N-N collocation (both content tokens)
 *   +2 length-3 phrase with all content tokens
 *   +1 base for any candidate
 *   +1 phrase length >= 6 chars
 */
export function extractCandidates(text: string): string[] {
  const tokens = tokenize(text);
  if (tokens.length === 0) return [];

  const seen = new Map<string, ScoredCandidate>();

  for (let i = 0; i < tokens.length; i++) {
    const wMax = Math.min(3, tokens.length - i);
    for (let w = 1; w <= wMax; w++) {
      const slice = tokens.slice(i, i + w);

      // every-token-stoplist? skip.
      if (slice.every(isStop)) continue;

      // for length-1: must be a content token (≥3 chars OR capitalized).
      if (w === 1) {
        if (!isContentToken(slice[0])) continue;
      } else {
        // multi-word: drop if either edge is a stop word — they make for
        // ugly fragments like "the api" or "with cache".
        if (isStop(slice[0]) || isStop(slice[slice.length - 1])) continue;
        // require at least one length-≥3-or-capitalized non-stop token.
        const hasMeat = slice.some(
          (t) => !isStop(t) && (t.length >= 3 || isCapitalized(t)),
        );
        if (!hasMeat) continue;
      }

      const phrase = slice.join(" ");
      if (phrase.length < 3) continue;

      // score
      let score = 1;
      const allContent = slice.every((t) => !isStop(t));
      const hasCap = slice.some(isCapitalized);
      if (hasCap) score += 3;
      if (w === 2 && allContent) score += 2;
      if (w === 3 && allContent) score += 2;
      if (phrase.length >= 6) score += 1;
      // Slight bonus for longer phrases — they tend to carry more meaning.
      score += w - 1;

      const key = phrase.toLowerCase();
      const existing = seen.get(key);
      if (!existing || score > existing.score) {
        seen.set(key, { phrase, score });
      }
    }
  }

  if (seen.size === 0) return [];

  // Prefer the highest-scoring candidates but try not to emit
  // overlapping fragments (e.g. "rate", "rate limiting", "limiting" all
  // for the same span). Prefer the longest covering phrase.
  const sorted = Array.from(seen.values()).sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    // tiebreak: longer phrase first
    return b.phrase.length - a.phrase.length;
  });

  const accepted: string[] = [];
  for (const c of sorted) {
    if (accepted.length >= MAX_CANDIDATES_PER_CALL) break;
    const lc = c.phrase.toLowerCase();
    // Prune redundant fragments: skip if an already-accepted phrase fully
    // contains this one (we already kept the bigger version).
    let redundant = false;
    for (const a of accepted) {
      const la = a.toLowerCase();
      if (la === lc) {
        redundant = true;
        break;
      }
      if (la.includes(lc)) {
        redundant = true;
        break;
      }
    }
    if (redundant) continue;
    accepted.push(c.phrase);
  }

  return accepted;
}

// ─────────────────────────────────────────────────────────────────────
// Ghost lifecycle.
// ─────────────────────────────────────────────────────────────────────

function scheduleGhostExpiry(ghostId: string, ttlMs: number): void {
  const existing = ghostExpiryTimers.get(ghostId);
  if (existing !== undefined) clearTimeout(existing);
  const t = setTimeout(() => {
    try {
      useGraphStore.getState().removeGhost(ghostId);
    } catch {
      /* store may have been reset */
    }
    ghostExpiryTimers.delete(ghostId);
  }, ttlMs);
  ghostExpiryTimers.set(ghostId, t);
}

function rememberRecentGhost(speakerId: string, ghostId: string): void {
  const ring = recentGhostsBySpeaker.get(speakerId) ?? [];
  ring.unshift({ ghostId, ts: Date.now() });
  if (ring.length > RECENT_GHOST_RING_SIZE) ring.length = RECENT_GHOST_RING_SIZE;
  recentGhostsBySpeaker.set(speakerId, ring);
}

function trackPredictiveEdge(id: string): void {
  predictiveEdgeOrder.push(id);
  // Schedule TTL.
  const t = setTimeout(() => {
    try {
      useGraphStore.getState().removePredictiveEdge(id);
    } catch {
      /* noop */
    }
    predictiveEdgeTimers.delete(id);
    const idx = predictiveEdgeOrder.indexOf(id);
    if (idx >= 0) predictiveEdgeOrder.splice(idx, 1);
  }, PREDICTIVE_EDGE_TTL_MS);
  predictiveEdgeTimers.set(id, t);

  // Cap in-flight predictive edges. Drop oldest if over cap.
  while (predictiveEdgeOrder.length > MAX_PREDICTIVE_EDGES) {
    const oldest = predictiveEdgeOrder.shift();
    if (!oldest) break;
    const tm = predictiveEdgeTimers.get(oldest);
    if (tm !== undefined) {
      clearTimeout(tm);
      predictiveEdgeTimers.delete(oldest);
    }
    try {
      useGraphStore.getState().removePredictiveEdge(oldest);
    } catch {
      /* noop */
    }
  }
}

function maybeAddPredictiveEdges(speakerId: string, newGhostId: string): void {
  const ring = recentGhostsBySpeaker.get(speakerId);
  if (!ring) return;
  const now = Date.now();
  const store = useGraphStore.getState();
  for (const prev of ring) {
    if (prev.ghostId === newGhostId) continue;
    if (now - prev.ts > PREDICTIVE_EDGE_WINDOW_MS) continue;
    const id = store.addPredictiveEdge({
      source_id: prev.ghostId,
      target_id: newGhostId,
      speaker_id: speakerId,
    });
    trackPredictiveEdge(id);
    // One predictive edge per new ghost is enough — avoid flooding for a
    // single phrase. The most-recent prior ghost wins.
    break;
  }
}

function seedGhost(
  candidate: string,
  speakerId: string,
  ttlMs: number,
): string | null {
  if (matchesExisting(candidate)) return null;
  const store = useGraphStore.getState();
  const ghostId = store.addGhost(candidate, speakerId);
  scheduleGhostExpiry(ghostId, ttlMs);
  maybeAddPredictiveEdges(speakerId, ghostId);
  rememberRecentGhost(speakerId, ghostId);
  try {
    store.pushSpeakerTrail(speakerId, ghostId);
  } catch {
    /* noop */
  }
  return ghostId;
}

// ─────────────────────────────────────────────────────────────────────
// Public API.
// ─────────────────────────────────────────────────────────────────────

/**
 * Process a *partial* transcript chunk. Seeds ghosts with the standard
 * (or throttle-bumped) TTL.
 */
export function processTranscriptPartial(
  text: string,
  speakerId: string,
): void {
  ensureThrottleSubscription();
  const ttl = currentPartialTtl();
  const candidates = extractCandidates(text);
  for (const cand of candidates) {
    seedGhost(cand, speakerId, ttl);
  }
}

/**
 * Process a *final* transcript chunk. Seeds ghosts with a longer TTL
 * (30 s) since these phrases were committed by the speaker.
 */
export function processTranscriptFinal(
  text: string,
  speakerId: string,
): void {
  ensureThrottleSubscription();
  const candidates = extractCandidates(text);
  for (const cand of candidates) {
    seedGhost(cand, speakerId, GHOST_TTL_FINAL_MS);
  }
}

// ─────────────────────────────────────────────────────────────────────
// Test seam.
// ─────────────────────────────────────────────────────────────────────

export const __test__ = {
  levenshtein,
  matchesExisting,
  /** Force the throttle subscription to (re)initialise. */
  resetThrottleState: (): void => {
    lastNodeArrivalTs = Date.now();
    lastObservedNodeCount = 0;
  },
  /** Force the "last node arrival" timestamp for testing throttle TTL. */
  setLastNodeArrivalTs: (ts: number): void => {
    lastNodeArrivalTs = ts;
  },
  isThrottled,
  currentPartialTtl,
  /** Clear all module-scoped timers + rings (test isolation). */
  clearAll: (): void => {
    for (const t of ghostExpiryTimers.values()) clearTimeout(t);
    ghostExpiryTimers.clear();
    for (const t of predictiveEdgeTimers.values()) clearTimeout(t);
    predictiveEdgeTimers.clear();
    predictiveEdgeOrder.length = 0;
    recentGhostsBySpeaker.clear();
  },
  constants: {
    GHOST_TTL_NORMAL_MS,
    GHOST_TTL_THROTTLED_MS,
    GHOST_TTL_FINAL_MS,
    THROTTLE_THRESHOLD_MS,
    PREDICTIVE_EDGE_WINDOW_MS,
    PREDICTIVE_EDGE_TTL_MS,
    MAX_PREDICTIVE_EDGES,
  },
};
