import { create } from "zustand";

export type BranchedSessionRef = {
  session_id: string;
  name: string;
  branched_at: string; // ISO
  parent_session_id: string;
};

export type BranchingState =
  | { phase: "idle" }
  | { phase: "splitting"; from_session_id: string; at_timestamp: string }
  | { phase: "complete"; new_session_id: string };

type SessionStore = {
  // current session
  currentSessionId: string | null;
  currentSessionName: string;
  micActive: boolean;

  // branches
  branchedSessions: BranchedSessionRef[];
  branching: BranchingState;
  sidePanelOpen: boolean;

  // user prefs
  theme: "dark"; // single theme by mandate
  reducedMotion: boolean;
  soundEnabled: boolean;

  // actions
  setSession: (id: string | null, name?: string) => void;
  setSessionName: (name: string) => void;
  setMicActive: (active: boolean) => void;
  pushBranch: (ref: BranchedSessionRef) => void;
  setBranching: (s: BranchingState) => void;
  setSidePanelOpen: (open: boolean) => void;
  setReducedMotion: (rm: boolean) => void;
  setSoundEnabled: (s: boolean) => void;
};

export const useSessionStore = create<SessionStore>((set) => ({
  currentSessionId: null,
  currentSessionName: "Untitled session",
  micActive: false,
  branchedSessions: [],
  branching: { phase: "idle" },
  sidePanelOpen: false,
  theme: "dark",
  reducedMotion: false,
  soundEnabled: false,

  setSession: (id, name) =>
    set((s) => ({
      currentSessionId: id,
      currentSessionName: name ?? s.currentSessionName,
    })),
  setSessionName: (name) => set({ currentSessionName: name }),
  setMicActive: (active) => set({ micActive: active }),
  pushBranch: (ref) =>
    set((s) => ({ branchedSessions: [ref, ...s.branchedSessions] })),
  setBranching: (b) => set({ branching: b }),
  setSidePanelOpen: (open) => set({ sidePanelOpen: open }),
  setReducedMotion: (rm) => set({ reducedMotion: rm }),
  setSoundEnabled: (s) => set({ soundEnabled: s }),
}));
