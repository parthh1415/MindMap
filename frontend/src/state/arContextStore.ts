import { create } from "zustand";

/** Max simultaneously-open cards. Older cards fade out as new ones open
 *  so the AR view stays legible — three is the comfortable limit before
 *  cards start crowding the projected orb positions. */
const MAX_OPEN_CARDS = 3;

export type OpenCard = {
  nodeId: string;
  openedAt: number;
};

type ArContextStore = {
  openCards: OpenCard[];
  isOpen: (nodeId: string) => boolean;
  /** Toggle: opening a card that's already open closes it; otherwise
   *  push and evict the oldest if we're at the cap. */
  toggleCard: (nodeId: string) => void;
  closeCard: (nodeId: string) => void;
  closeAll: () => void;
};

export const useArContextStore = create<ArContextStore>((set, get) => ({
  openCards: [],
  isOpen: (nodeId) => get().openCards.some((c) => c.nodeId === nodeId),
  toggleCard: (nodeId) => {
    const cards = get().openCards;
    if (cards.some((c) => c.nodeId === nodeId)) {
      set({ openCards: cards.filter((c) => c.nodeId !== nodeId) });
      return;
    }
    const next: OpenCard = { nodeId, openedAt: Date.now() };
    const merged = [...cards, next];
    if (merged.length > MAX_OPEN_CARDS) {
      // Evict the oldest by openedAt — the card that's been on screen
      // the longest is the one the user is least likely to be reading.
      merged.sort((a, b) => a.openedAt - b.openedAt);
      merged.shift();
    }
    set({ openCards: merged });
  },
  closeCard: (nodeId) =>
    set((s) => ({ openCards: s.openCards.filter((c) => c.nodeId !== nodeId) })),
  closeAll: () => set({ openCards: [] }),
}));
