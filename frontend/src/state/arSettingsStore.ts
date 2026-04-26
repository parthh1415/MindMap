import { create } from "zustand";

const STORAGE_KEY = "mm.ar.settings.v1";

type Persisted = {
  expandOnPinch: boolean;
};

function loadPersisted(): Persisted {
  if (typeof window === "undefined") return { expandOnPinch: true };
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return { expandOnPinch: true };
    const parsed = JSON.parse(raw) as Partial<Persisted>;
    return { expandOnPinch: parsed.expandOnPinch ?? true };
  } catch {
    return { expandOnPinch: true };
  }
}

function savePersisted(state: Persisted): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch {
    // Quota / SecurityError → toggle stays in-memory only this session.
  }
}

type ArSettingsStore = {
  /**
   * When true, a sustained right-hand pinch on a hovered orb opens its
   * context card. Quick pinches still mark the node as activated. When
   * false, hold-pinch is suppressed and pinch is purely activate.
   */
  expandOnPinch: boolean;
  setExpandOnPinch: (value: boolean) => void;
  toggleExpandOnPinch: () => void;
};

export const useArSettingsStore = create<ArSettingsStore>((set, get) => ({
  ...loadPersisted(),
  setExpandOnPinch: (value) => {
    set({ expandOnPinch: value });
    savePersisted({ expandOnPinch: value });
  },
  toggleExpandOnPinch: () => {
    const next = !get().expandOnPinch;
    set({ expandOnPinch: next });
    savePersisted({ expandOnPinch: next });
  },
}));
