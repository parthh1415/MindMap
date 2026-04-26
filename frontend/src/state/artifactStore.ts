import { create } from "zustand";
import { useShallow } from "zustand/react/shallow";
import { useSessionStore } from "@/state/sessionStore";

// ─────────────────────────────────────────────────────────────────────
// Types — mirrors shared/agent_messages.py contracts (frozen).
// ─────────────────────────────────────────────────────────────────────

export const ARTIFACT_TYPES = [
  "prd",
  "scaffold",
  "decision",
  "retro",
  "action",
  "research",
  "debate",
  "brief",
] as const;

export type ArtifactType = (typeof ARTIFACT_TYPES)[number];

export type Phase =
  | "idle"
  | "classifying"
  | "confirming"
  | "generating"
  | "swirl"      // 1.4s cinematic — cited orbs converge to screen center
  | "ready"
  | "editing";

export type ArtifactCandidate = {
  type: ArtifactType;
  score: number;
  why: string;
};

export type ClassifyResult = {
  top_choice: ArtifactType;
  confidence: number;
  candidates: ArtifactCandidate[];
};

export type ArtifactFile = { path: string; content: string };

export type ArtifactEvidence = {
  section_anchor: string;
  node_ids: string[];
  transcript_excerpts: string[];
};

export type Artifact = {
  _id?: string;
  session_id: string;
  artifact_type: ArtifactType;
  title: string;
  markdown: string;
  files: ArtifactFile[];
  evidence: ArtifactEvidence[];
  generated_at?: string;
  classify_top_choice?: ArtifactType;
  classify_confidence?: number;
  /** True once the user has clicked Save on this artifact. Pinned
   *  artifacts surface to the top of the history list. */
  pinned?: boolean;
};

export type ArtifactHistoryItem = {
  _id: string;
  session_id: string;
  artifact_type: ArtifactType;
  title: string;
  generated_at: string;
  classify_top_choice?: ArtifactType;
  classify_confidence?: number;
  pinned?: boolean;
};

// ─────────────────────────────────────────────────────────────────────
// Store
// ─────────────────────────────────────────────────────────────────────

type ArtifactStore = {
  phase: Phase;
  classifyResult: ClassifyResult | null;
  activeArtifact: Artifact | null;
  history: ArtifactHistoryItem[];
  historyOpen: boolean;
  atTimestamp: string | null;
  refinementHint: string;
  overrideType: ArtifactType | null;
  error: string | null;
  apiBase: string;
  // dismissed-without-saving badge state
  pendingDismissed: boolean;

  // actions
  openGenerator: () => Promise<void>;
  setOverrideType: (t: ArtifactType | null) => void;
  setRefinementHint: (h: string) => void;
  setAtTimestamp: (ts: string | null) => void;
  generate: () => Promise<void>;
  regenerateSection: (anchor: string) => Promise<void>;
  openHistory: () => Promise<void>;
  closeHistory: () => void;
  loadFromHistory: (artifactId: string) => Promise<void>;
  /** Toggle the saved/pinned state of the active artifact. Optimistic:
   *  flips local state immediately so the Save button feels instant,
   *  rolls back on a backend error. */
  toggleSaveActive: () => Promise<void>;
  setActiveArtifactMarkdown: (md: string) => void;
  enterEditor: () => void;
  exitEditor: () => void;
  dismiss: () => void;
  setApiBase: (base: string) => void;
  /** Called by GenerateSwirlOverlay when its animation finishes;
   *  flips phase from "swirl" to "ready" so the preview opens. */
  advanceFromSwirl: () => void;
};

const DEFAULT_API_BASE =
  (typeof window !== "undefined" &&
    (window as unknown as { __MINDMAP_API__?: string }).__MINDMAP_API__) ||
  "http://localhost:8000";

function asArtifactType(t: unknown): ArtifactType {
  if (typeof t === "string" && (ARTIFACT_TYPES as readonly string[]).includes(t)) {
    return t as ArtifactType;
  }
  return "brief";
}

function normalizeCandidates(arr: unknown): ArtifactCandidate[] {
  if (!Array.isArray(arr)) return [];
  return arr.map((c) => {
    const o = c as { type?: unknown; score?: unknown; why?: unknown };
    return {
      type: asArtifactType(o.type),
      score: typeof o.score === "number" ? o.score : 0,
      why: typeof o.why === "string" ? o.why : "",
    };
  });
}

function normalizeArtifact(raw: unknown): Artifact | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  const session_id =
    typeof o.session_id === "string" ? o.session_id : "";
  // Backend's `_serialize_artifact` renames `_id` → `artifact_id`, but
  // tests + a few WS payloads still emit `_id`. Accept either so the
  // Save button (which needs the id to PATCH /artifacts/:id/pin) works
  // for both the live API and existing fixture data.
  const id =
    typeof o._id === "string"
      ? o._id
      : typeof o.artifact_id === "string"
        ? o.artifact_id
        : undefined;
  return {
    _id: id,
    session_id,
    artifact_type: asArtifactType(o.artifact_type),
    title: typeof o.title === "string" ? o.title : "Untitled artifact",
    markdown: typeof o.markdown === "string" ? o.markdown : "",
    files: Array.isArray(o.files)
      ? (o.files as unknown[])
          .map((f) => {
            const fo = f as { path?: unknown; content?: unknown };
            return {
              path: typeof fo.path === "string" ? fo.path : "",
              content: typeof fo.content === "string" ? fo.content : "",
            };
          })
          .filter((f) => f.path)
      : [],
    evidence: Array.isArray(o.evidence)
      ? (o.evidence as unknown[]).map((e) => {
          const eo = e as Record<string, unknown>;
          return {
            section_anchor:
              typeof eo.section_anchor === "string" ? eo.section_anchor : "",
            node_ids: Array.isArray(eo.node_ids)
              ? (eo.node_ids as unknown[]).filter(
                  (x): x is string => typeof x === "string",
                )
              : [],
            transcript_excerpts: Array.isArray(eo.transcript_excerpts)
              ? (eo.transcript_excerpts as unknown[]).filter(
                  (x): x is string => typeof x === "string",
                )
              : [],
          };
        })
      : [],
    generated_at:
      typeof o.generated_at === "string" ? o.generated_at : undefined,
    classify_top_choice:
      typeof o.classify_top_choice === "string"
        ? asArtifactType(o.classify_top_choice)
        : undefined,
    classify_confidence:
      typeof o.classify_confidence === "number"
        ? o.classify_confidence
        : undefined,
    pinned: o.pinned === true,
  };
}

function currentSessionId(): string | null {
  return useSessionStore.getState().currentSessionId;
}

export const useArtifactStore = create<ArtifactStore>((set, get) => ({
  phase: "idle",
  classifyResult: null,
  activeArtifact: null,
  history: [],
  historyOpen: false,
  atTimestamp: null,
  refinementHint: "",
  overrideType: null,
  error: null,
  apiBase: DEFAULT_API_BASE,
  pendingDismissed: false,

  setApiBase: (base) => set({ apiBase: base }),

  setOverrideType: (t) => set({ overrideType: t }),
  setRefinementHint: (h) => set({ refinementHint: h }),
  setAtTimestamp: (ts) => set({ atTimestamp: ts }),

  openGenerator: async () => {
    // One-click generation. Classify the graph + transcript to pick the
    // most-fitting artifact type, then immediately call generate with
    // that choice. The user no longer has to choose between PRD /
    // research / decision / brief / etc. — the system reads the
    // context (nodes, edges, importance, transcript) and picks the
    // best document type for what the conversation actually was.
    //
    // The user can still re-classify into a different type via the
    // history view + "regenerate as…" if they want to override.
    const sessionId = currentSessionId();
    if (!sessionId) return;
    set({
      phase: "classifying",
      error: null,
      classifyResult: null,
      overrideType: null,
      refinementHint: "",
      atTimestamp: null,
    });
    try {
      const { apiBase, atTimestamp } = get();
      const res = await fetch(
        `${apiBase}/sessions/${encodeURIComponent(sessionId)}/classify-artifact`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(atTimestamp ? { at: atTimestamp } : {}),
        },
      );
      if (!res.ok) {
        throw new Error(`classify ${res.status}`);
      }
      const data = (await res.json()) as {
        top_choice: string;
        confidence: number;
        candidates: unknown;
      };
      const result: ClassifyResult = {
        top_choice: asArtifactType(data.top_choice),
        confidence:
          typeof data.confidence === "number" ? data.confidence : 0,
        candidates: normalizeCandidates(data.candidates),
      };
      // Skip the confirm modal — classifyResult is recorded for any
      // downstream UI that wants to show "we chose X because…", and
      // we proceed straight to generation.
      set({ classifyResult: result });
      await get().generate();
    } catch (err) {
      set({
        phase: "idle",
        error: err instanceof Error ? err.message : String(err),
      });
    }
  },

  generate: async () => {
    const sessionId = currentSessionId();
    if (!sessionId) return;
    const {
      apiBase,
      classifyResult,
      overrideType,
      refinementHint,
      atTimestamp,
    } = get();
    const artifact_type =
      overrideType ?? classifyResult?.top_choice ?? "brief";

    set({ phase: "generating", error: null });
    try {
      const body: Record<string, unknown> = { artifact_type };
      if (refinementHint) body.refinement_hint = refinementHint;
      if (atTimestamp) body.at = atTimestamp;
      const res = await fetch(
        `${apiBase}/sessions/${encodeURIComponent(sessionId)}/generate-artifact`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        },
      );
      if (!res.ok) {
        throw new Error(`generate ${res.status}`);
      }
      const data = (await res.json()) as Record<string, unknown>;
      const artifact = normalizeArtifact({
        ...data,
        session_id:
          (data.session_id as string | undefined) ?? sessionId,
      });
      if (!artifact) throw new Error("invalid artifact response");
      // Stash the result and enter the cinematic swirl phase. The
      // GenerateSwirlOverlay reads the artifact's evidence to find
      // which orbs to animate, plays a ~1.4s converge-to-center
      // animation, then calls advanceFromSwirl() to flip to "ready"
      // (which opens the preview modal). If the overlay can't run
      // for any reason, a fallback timer below still flips us to
      // ready so the user is never stuck.
      set({
        activeArtifact: artifact,
        phase: "swirl",
        pendingDismissed: false,
      });
      // Safety net: if the swirl overlay fails to advance us within
      // 3s (no DOM elements found, animation glitched, etc.), force
      // the transition. The overlay's own happy path advances at
      // ~1.4s.
      setTimeout(() => {
        if (get().phase === "swirl") {
          set({ phase: "ready" });
        }
      }, 3000);
    } catch (err) {
      set({
        phase: "idle",
        error: err instanceof Error ? err.message : String(err),
      });
    }
  },

  regenerateSection: async (anchor: string) => {
    const sessionId = currentSessionId();
    const { apiBase, activeArtifact, refinementHint, atTimestamp } = get();
    if (!sessionId || !activeArtifact) return;
    set({ phase: "generating", error: null });
    try {
      const body: Record<string, unknown> = {
        artifact_type: activeArtifact.artifact_type,
        section_anchor: anchor,
      };
      if (refinementHint) body.refinement_hint = refinementHint;
      if (atTimestamp) body.at = atTimestamp;
      const res = await fetch(
        `${apiBase}/sessions/${encodeURIComponent(sessionId)}/generate-artifact`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        },
      );
      if (!res.ok) throw new Error(`regenerate ${res.status}`);
      const data = (await res.json()) as Record<string, unknown>;
      const next = normalizeArtifact({
        ...data,
        session_id:
          (data.session_id as string | undefined) ?? sessionId,
      });
      if (!next) throw new Error("invalid artifact response");
      // Splice the regenerated section back into the existing markdown.
      const merged = spliceSection(
        activeArtifact.markdown,
        anchor,
        next.markdown,
      );
      set({
        activeArtifact: { ...activeArtifact, markdown: merged },
        phase: "editing",
      });
    } catch (err) {
      set({
        phase: "editing",
        error: err instanceof Error ? err.message : String(err),
      });
    }
  },

  openHistory: async () => {
    const sessionId = currentSessionId();
    if (!sessionId) {
      set({ historyOpen: true });
      return;
    }
    set({ historyOpen: true });
    try {
      const { apiBase } = get();
      const res = await fetch(
        `${apiBase}/sessions/${encodeURIComponent(sessionId)}/artifacts`,
      );
      if (!res.ok) return;
      const data = (await res.json()) as { artifacts?: unknown };
      const items = Array.isArray(data.artifacts)
        ? (data.artifacts as unknown[])
            .map((a) => {
              const o = a as Record<string, unknown>;
              const id =
                typeof o._id === "string"
                  ? o._id
                  : typeof o.artifact_id === "string"
                    ? o.artifact_id
                    : null;
              if (!id) return null;
              return {
                _id: id,
                session_id:
                  typeof o.session_id === "string" ? o.session_id : "",
                artifact_type: asArtifactType(o.artifact_type),
                title:
                  typeof o.title === "string" ? o.title : "Untitled artifact",
                generated_at:
                  typeof o.generated_at === "string"
                    ? o.generated_at
                    : new Date().toISOString(),
                classify_top_choice:
                  typeof o.classify_top_choice === "string"
                    ? asArtifactType(o.classify_top_choice)
                    : undefined,
                classify_confidence:
                  typeof o.classify_confidence === "number"
                    ? o.classify_confidence
                    : undefined,
                pinned: o.pinned === true,
              } as ArtifactHistoryItem;
            })
            .filter((x): x is ArtifactHistoryItem => x !== null)
        : [];
      set({ history: items });
    } catch {
      /* leave history as-is */
    }
  },

  closeHistory: () => set({ historyOpen: false }),

  loadFromHistory: async (artifactId: string) => {
    const { apiBase } = get();
    set({ phase: "generating", error: null, historyOpen: false });
    try {
      const res = await fetch(
        `${apiBase}/artifacts/${encodeURIComponent(artifactId)}`,
      );
      if (!res.ok) throw new Error(`load ${res.status}`);
      const data = (await res.json()) as Record<string, unknown>;
      const artifact = normalizeArtifact(data);
      if (!artifact) throw new Error("invalid artifact response");
      set({ activeArtifact: artifact, phase: "ready" });
    } catch (err) {
      set({
        phase: "idle",
        error: err instanceof Error ? err.message : String(err),
      });
    }
  },

  toggleSaveActive: async () => {
    const { apiBase, activeArtifact, history } = get();
    if (!activeArtifact?._id) return;
    const id = activeArtifact._id;
    const nextPinned = !activeArtifact.pinned;
    // Optimistic flip — UI confirms instantly, we reconcile on response.
    set({
      activeArtifact: { ...activeArtifact, pinned: nextPinned },
      history: history.map((h) =>
        h._id === id ? { ...h, pinned: nextPinned } : h,
      ),
    });
    try {
      const res = await fetch(
        `${apiBase}/artifacts/${encodeURIComponent(id)}/pin`,
        {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ pinned: nextPinned }),
        },
      );
      if (!res.ok) throw new Error(`pin ${res.status}`);
    } catch (err) {
      // Roll back the optimistic update — keep the user's data
      // honest about what's actually persisted server-side.
      const cur = get();
      set({
        activeArtifact: cur.activeArtifact?._id === id
          ? { ...cur.activeArtifact, pinned: !nextPinned }
          : cur.activeArtifact,
        history: cur.history.map((h) =>
          h._id === id ? { ...h, pinned: !nextPinned } : h,
        ),
        error: err instanceof Error ? err.message : String(err),
      });
    }
  },

  setActiveArtifactMarkdown: (md: string) => {
    const a = get().activeArtifact;
    if (!a) return;
    set({ activeArtifact: { ...a, markdown: md } });
  },

  enterEditor: () => {
    if (get().phase === "ready") set({ phase: "editing" });
  },

  exitEditor: () => {
    if (get().phase === "editing") set({ phase: "ready" });
  },

  advanceFromSwirl: () => {
    if (get().phase === "swirl") set({ phase: "ready" });
  },

  dismiss: () => {
    const had = get().activeArtifact;
    set({
      phase: "idle",
      classifyResult: null,
      historyOpen: false,
      // Keep activeArtifact so the badge can hint user can re-open from history.
      pendingDismissed: had ? true : false,
    });
  },
}));

// ─────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────

// Replace the H2 section beginning with the given anchor in the existing
// markdown with the body of `replacement`. Anchor is the kebab slug; we
// scan the H2 lines and slugify each to find a match.
export function spliceSection(
  original: string,
  anchor: string,
  replacement: string,
): string {
  const lines = original.split("\n");
  const start = findH2Index(lines, anchor);
  if (start < 0) {
    // Anchor not found — just append.
    return original.trimEnd() + "\n\n" + replacement.trim() + "\n";
  }
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    if (/^##\s+/.test(lines[i])) {
      end = i;
      break;
    }
  }
  const before = lines.slice(0, start).join("\n");
  const after = lines.slice(end).join("\n");
  const trimmedReplacement = replacement.trim();
  return [before, trimmedReplacement, after]
    .filter((p) => p.length > 0)
    .join("\n\n");
}

function findH2Index(lines: string[], anchor: string): number {
  for (let i = 0; i < lines.length; i++) {
    const m = /^##\s+(.+)$/.exec(lines[i]);
    if (!m) continue;
    if (slugify(m[1]) === anchor) return i;
  }
  return -1;
}

function slugify(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/-{2,}/g, "-");
}

// ─────────────────────────────────────────────────────────────────────
// Selector hooks
// ─────────────────────────────────────────────────────────────────────

export const useArtifactPhase = () =>
  useArtifactStore((s) => s.phase);

const activeArtifactFn = (s: ArtifactStore) => s.activeArtifact;
export const useActiveArtifact = () =>
  useArtifactStore(useShallow(activeArtifactFn));

const classifyResultFn = (s: ArtifactStore) => s.classifyResult;
export const useClassifyResult = () =>
  useArtifactStore(useShallow(classifyResultFn));

const historyFn = (s: ArtifactStore) => s.history;
export const useArtifactHistory = () =>
  useArtifactStore(useShallow(historyFn));
